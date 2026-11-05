import type { CompileResult, GoBridge } from './bridge';
import { callBridge, unwrap } from './bridge';
import { OutputImpl, readOutputJSON } from './output';
import type { OutputResult } from './bridge';
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

async function runWithOutputCleanup(
    run: () => Promise<OutputImpl>,
    cleanup: () => Promise<void>,
): Promise<OutputImpl> {
    let output: OutputImpl | undefined;
    let runError: unknown;
    let failed = false;
    try {
        output = await run();
        return output;
    } catch (error) {
        failed = true;
        runError = error;
        throw error;
    } finally {
        try {
            await cleanup();
        } catch (cleanupError) {
            if (output !== undefined) {
                output.addCleanupError(cleanupError);
            } else if (failed) {
                throw new AggregateError(
                    [runError, cleanupError],
                    'Execution and cleanup both failed',
                );
            } else {
                throw cleanupError;
            }
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
    #output?: OutputImpl;

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

    async run(options: SessionRunOptions = {}): Promise<OutputImpl> {
        if (this.#closed) {
            throw new Error('Session is closed');
        }

        if (this.#closing) {
            throw new Error('Session is closing');
        }

        if (this.#running) {
            throw new Error('Session is already running');
        }
        if (this.#owner.closing || this.#owner.engineClosing) {
            throw new Error('Plan or engine is closing');
        }

        if (this.#output != null && !this.#output.closed) {
            throw new Error(
                'Previous session output must be settled before another run',
            );
        }
        if (options == null || typeof options !== 'object') {
            throw new TypeError('options must be an object');
        }
        validateSignal(options.signal);

        this.#running = true;

        try {
            const result = await callBridge<OutputResult>((callback) =>
                this.#bridge.runSession(this.#id, options.signal, callback),
            );
            this.#output = this.#owner.registerOutput(result, options.signal);
            return this.#output;
        } finally {
            this.#running = false;
        }
    }

    runJSON<T = unknown>(
        options: SessionRunOptions = {},
    ): Promise<T | undefined> {
        return readOutputJSON<T>(this.run(options));
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

    /** @internal */
    get engineClosing(): boolean {
        return this.#owner.closing;
    }

    get closed(): boolean {
        return this.#closed;
    }

    /** @internal */
    removeSession(session: SessionImpl): void {
        this.#sessions.delete(session);
    }

    /** @internal */
    registerOutput(
        result: OutputResult,
        signal: AbortSignal | undefined,
    ): OutputImpl {
        return this.#owner.registerOutput(result, signal);
    }

    async createSession(options: SessionOptions = {}): Promise<SessionImpl> {
        if (this.#closed) {
            throw new Error('Plan is closed');
        }

        if (this.#closing || this.engineClosing) {
            throw new Error('Plan or engine is closing');
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

    async run(options: ExecutionOptions = {}): Promise<OutputImpl> {
        if (options == null || !isParams(options.params)) {
            throw new TypeError('params must be a plain JavaScript object');
        }

        const session = await this.createSession({
            params: options.params,
            signal: options.signal,
        });

        return runWithOutputCleanup(
            () => session.run({ signal: options.signal }),
            () => session.close(),
        );
    }

    runJSON<T = unknown>(
        options: ExecutionOptions = {},
    ): Promise<T | undefined> {
        return readOutputJSON<T>(this.run(options));
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
    readonly #outputs = new Set<OutputImpl>();
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

    /** @internal */
    get closing(): boolean {
        return this.#closing;
    }

    get closed(): boolean {
        return this.#closed;
    }

    /** @internal */
    registerOutput(
        result: OutputResult,
        signal: AbortSignal | undefined,
    ): OutputImpl {
        const output = new OutputImpl(this.#bridge, result, signal, () =>
            this.#outputs.delete(output),
        );
        this.#outputs.add(output);
        return output;
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

    async run(
        source: SourceInput,
        options: ExecutionOptions = {},
    ): Promise<OutputImpl> {
        if (options == null || !isParams(options.params)) {
            throw new TypeError('params must be a plain JavaScript object');
        }
        const plan = await this.compile(source, {
            signal: options.signal,
        });
        return runWithOutputCleanup(
            () => plan.run(options),
            () => plan.close(),
        );
    }

    runJSON<T = unknown>(
        source: SourceInput,
        options: ExecutionOptions = {},
    ): Promise<T | undefined> {
        return readOutputJSON<T>(this.run(source, options));
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

        for (const output of this.#outputs) {
            if (output.active) {
                throw new Error('Cannot close an engine with an active output');
            }
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
            // Reserve every output before yielding, so callbacks cannot start
            // consuming another unread handle during shutdown.
            const outputClosures = [...this.#outputs].map((output) =>
                output.close(),
            );
            for (const result of await Promise.allSettled(outputClosures)) {
                if (result.status === 'rejected') errors.push(result.reason);
            }

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
