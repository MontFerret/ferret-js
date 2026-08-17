import type { CompileResult, GoBridge } from './bridge';
import { callBridge, unwrap } from './bridge';
import type {
    CompileOptions,
    Engine,
    ExecutionOptions,
    Params,
    Plan,
    Session,
    SessionOptions,
    SessionRunOptions,
    SourceInput,
    Version,
} from './types';

function normalizeSource(source: SourceInput): { name: string; text: string } {
    if (typeof source === 'string') {
        return { name: 'anonymous', text: source };
    }

    if (
        source == null ||
        typeof source !== 'object' ||
        typeof source.text !== 'string'
    ) {
        throw new TypeError('source must be a string or a source object');
    }

    if (source.name != null && typeof source.name !== 'string') {
        throw new TypeError('source.name must be a string');
    }

    return { name: source.name || 'anonymous', text: source.text };
}

async function runWithCleanup<T>(
    run: () => Promise<T>,
    cleanup: () => Promise<void>,
): Promise<T> {
    let runError: unknown;

    try {
        return await run();
    } catch (error) {
        runError = error;
        throw error;
    } finally {
        try {
            await cleanup();
        } catch (cleanupError) {
            if (runError !== undefined) {
                throw new AggregateError(
                    [runError, cleanupError],
                    'Execution and cleanup both failed',
                );
            }
            throw cleanupError;
        }
    }
}

export class SessionImpl implements Session {
    readonly #bridge: GoBridge;
    readonly #id: string;
    readonly #owner: PlanImpl;
    #closed = false;
    #closing = false;
    #running = false;

    /** @internal */
    constructor(bridge: GoBridge, id: string, owner: PlanImpl) {
        this.#bridge = bridge;
        this.#id = id;
        this.#owner = owner;
    }

    /** @internal */
    get running(): boolean {
        return this.#running;
    }

    /** @internal */
    get closing(): boolean {
        return this.#closing;
    }

    get closed(): boolean {
        return this.#closed;
    }

    async run<T = unknown>(options: SessionRunOptions = {}): Promise<T> {
        if (this.#closed) {
            throw new Error('Session is closed');
        }

        if (this.#closing) {
            throw new Error('Session is closing');
        }

        if (this.#running) {
            throw new Error('Session is already running');
        }

        if (
            options == null ||
            (options.signal != null &&
                typeof options.signal.addEventListener !== 'function')
        ) {
            throw new TypeError('signal must be an AbortSignal');
        }

        this.#running = true;

        try {
            const json = await callBridge<string>((callback) =>
                this.#bridge.runSession(this.#id, options.signal, callback),
            );
            return JSON.parse(json) as T;
        } finally {
            this.#running = false;
        }
    }

    async close(): Promise<void> {
        if (this.#closed) {
            return;
        }

        if (this.#closing) {
            throw new Error('Session is closing');
        }

        if (this.#running) {
            throw new Error('Cannot close a running session');
        }

        this.#closing = true;
        let accepted = false;

        try {
            await callBridge((callback) => {
                const result = this.#bridge.closeSession(this.#id, callback);
                accepted = result?.ok === true;
                return result;
            });
        } finally {
            this.#closing = false;

            if (accepted) {
                this.#closed = true;
                this.#owner.removeSession(this);
            }
        }
    }
}

export class PlanImpl implements Plan {
    readonly #bridge: GoBridge;
    readonly #id: string;
    readonly #owner: EngineImpl;
    readonly #sessions = new Set<SessionImpl>();
    readonly params: readonly string[];
    #closed = false;
    #closing = false;
    #pendingSessionCreations = 0;

    /** @internal */
    constructor(
        bridge: GoBridge,
        id: string,
        params: string[],
        owner: EngineImpl,
    ) {
        this.#bridge = bridge;
        this.#id = id;
        this.#owner = owner;
        this.params = Object.freeze([...params]);
    }

    /** @internal */
    get hasRunningSession(): boolean {
        for (const session of this.#sessions) {
            if (session.running) {
                return true;
            }
        }

        return false;
    }

    /** @internal */
    get hasPendingSessionCreation(): boolean {
        return this.#pendingSessionCreations > 0;
    }

    /** @internal */
    get hasClosingSession(): boolean {
        for (const session of this.#sessions) {
            if (session.closing) {
                return true;
            }
        }

        return false;
    }

    /** @internal */
    get closing(): boolean {
        return this.#closing;
    }

    get closed(): boolean {
        return this.#closed;
    }

    /** @internal */
    removeSession(session: SessionImpl): void {
        this.#sessions.delete(session);
    }

    async createSession(options: SessionOptions = {}): Promise<SessionImpl> {
        if (this.#closed) {
            throw new Error('Plan is closed');
        }

        if (this.#closing) {
            throw new Error('Plan is closing');
        }

        if (
            options == null ||
            typeof options !== 'object' ||
            !isParams(options.params)
        ) {
            throw new TypeError('params must be a plain JavaScript object');
        }

        validateSignal(options.signal);
        this.#pendingSessionCreations++;

        try {
            const id = await callBridge<string>((callback) =>
                this.#bridge.createSession(
                    this.#id,
                    options.params,
                    options.signal,
                    callback,
                ),
            );
            const session = new SessionImpl(this.#bridge, id, this);
            this.#sessions.add(session);

            return session;
        } finally {
            this.#pendingSessionCreations--;
        }
    }

    async run<T = unknown>(options: ExecutionOptions = {}): Promise<T> {
        if (options == null || !isParams(options.params)) {
            throw new TypeError('params must be a plain JavaScript object');
        }

        const session = await this.createSession({
            params: options.params,
            signal: options.signal,
        });

        return runWithCleanup(
            () => session.run<T>({ signal: options.signal }),
            () => session.close(),
        );
    }

    async close(): Promise<void> {
        if (this.#closed) {
            return;
        }

        if (this.#closing) {
            throw new Error('Plan is closing');
        }

        if (this.hasPendingSessionCreation) {
            throw new Error('Cannot close a plan while creating a session');
        }

        if (this.hasRunningSession) {
            throw new Error('Cannot close a plan with a running session');
        }

        if (this.hasClosingSession) {
            throw new Error('Cannot close a plan with a closing session');
        }

        this.#closing = true;
        const errors: unknown[] = [];
        let accepted = false;

        try {
            for (const session of [...this.#sessions]) {
                try {
                    await session.close();
                } catch (error) {
                    errors.push(error);
                }
            }

            try {
                await callBridge((callback) => {
                    const result = this.#bridge.closePlan(this.#id, callback);
                    accepted = result?.ok === true;
                    return result;
                });
            } catch (error) {
                errors.push(error);
            }
        } finally {
            this.#closing = false;

            if (accepted) {
                this.#closed = true;
                this.#owner.removePlan(this);
            }
        }

        throwCloseErrors(errors, 'Plan cleanup failed');
    }
}

export class EngineImpl implements Engine {
    readonly #bridge: GoBridge;
    readonly #runtimeDone: Promise<void>;
    readonly #plans = new Set<PlanImpl>();
    readonly version: Readonly<Version>;
    #closed = false;
    #closing = false;
    #pendingCompilations = 0;

    /** @internal */
    constructor(
        bridge: GoBridge,
        runtimeDone: Promise<void>,
        version: Version,
    ) {
        this.#bridge = bridge;
        this.#runtimeDone = runtimeDone;
        this.version = Object.freeze({ ...version });
    }

    /** @internal */
    removePlan(plan: PlanImpl): void {
        this.#plans.delete(plan);
    }

    get closed(): boolean {
        return this.#closed;
    }

    async compile(
        source: SourceInput,
        options: CompileOptions = {},
    ): Promise<PlanImpl> {
        if (this.#closed) {
            throw new Error('Engine is closed');
        }

        if (this.#closing) {
            throw new Error('Engine is closing');
        }

        if (options == null || typeof options !== 'object') {
            throw new TypeError('options must be an object');
        }

        validateSignal(options.signal);
        const normalized = normalizeSource(source);
        this.#pendingCompilations++;

        try {
            const result = await callBridge<CompileResult>((callback) =>
                this.#bridge.compile(
                    normalized.name,
                    normalized.text,
                    options.signal,
                    callback,
                ),
            );
            const plan = new PlanImpl(
                this.#bridge,
                result.id,
                result.params,
                this,
            );
            this.#plans.add(plan);

            return plan;
        } finally {
            this.#pendingCompilations--;
        }
    }

    async run<T = unknown>(
        source: SourceInput,
        options: ExecutionOptions = {},
    ): Promise<T> {
        const plan = await this.compile(source, {
            signal: options.signal,
        });
        return runWithCleanup(
            () => plan.run<T>(options),
            () => plan.close(),
        );
    }

    async close(): Promise<void> {
        if (this.#closed) {
            return;
        }

        if (this.#closing) {
            throw new Error('Engine is closing');
        }

        if (this.#pendingCompilations > 0) {
            throw new Error('Cannot close an engine while compiling a plan');
        }

        for (const plan of this.#plans) {
            if (plan.closing) {
                throw new Error('Cannot close an engine with a closing plan');
            }

            if (plan.hasPendingSessionCreation) {
                throw new Error(
                    'Cannot close an engine while creating a session',
                );
            }

            if (plan.hasRunningSession) {
                throw new Error(
                    'Cannot close an engine with a running session',
                );
            }

            if (plan.hasClosingSession) {
                throw new Error(
                    'Cannot close an engine with a closing session',
                );
            }
        }

        this.#closing = true;
        const errors: unknown[] = [];
        let accepted = false;

        try {
            for (const plan of [...this.#plans]) {
                try {
                    await plan.close();
                } catch (error) {
                    errors.push(error);
                }
            }

            try {
                await callBridge((callback) => {
                    const result = this.#bridge.closeEngine(callback);
                    accepted = result?.ok === true;
                    return result;
                });
            } catch (error) {
                errors.push(error);
            }

            if (accepted) {
                this.#closed = true;

                try {
                    unwrap(this.#bridge.shutdown());
                    await this.#runtimeDone;
                } catch (error) {
                    errors.push(error);
                }
            }
        } finally {
            this.#closing = false;
        }

        throwCloseErrors(errors, 'Engine cleanup failed');
    }
}

function throwCloseErrors(errors: unknown[], message: string): void {
    if (errors.length === 1) {
        throw errors[0];
    }

    if (errors.length > 1) {
        throw new AggregateError(errors, message);
    }
}

function isParams(value: Params | undefined): boolean {
    if (value === undefined) {
        return true;
    }

    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }

    const prototype = Object.getPrototypeOf(value);

    return prototype === Object.prototype || prototype === null;
}

function validateSignal(signal: AbortSignal | undefined): void {
    if (
        signal != null &&
        (typeof signal !== 'object' ||
            typeof signal.addEventListener !== 'function' ||
            typeof signal.removeEventListener !== 'function')
    ) {
        throw new TypeError('signal must be an AbortSignal');
    }
}
