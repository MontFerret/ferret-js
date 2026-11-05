import { callBridge } from './bridge';
import type {
    BridgeError,
    GoBridge,
    OutputCompletion,
    OutputResult,
} from './bridge';
import type {
    Content,
    Metadata,
    Output,
    OutputConsumer,
    OutputOptions,
} from './types';

/** A terminal output failure, with any content collected before the failure. */
export class OutputError extends Error {
    readonly content: Content | null;
    readonly code?: string;

    constructor(
        message: string,
        content: Content | null = null,
        options: { cause?: unknown; code?: string } = {},
    ) {
        super(message, { cause: options.cause });
        this.name = options.code === 'ABORTED' ? 'AbortError' : 'OutputError';
        this.content = content;
        this.code = options.code;
    }
}

/** @internal */
export class OutputImpl implements Output {
    readonly metadata: Readonly<Metadata>;
    #bridge?: GoBridge;
    readonly #id: string;
    readonly #invocationSignal?: AbortSignal;
    #release?: () => void;
    readonly #cleanupErrors: unknown[] = [];
    #state: 'ready' | 'consuming' | 'closing' | 'closed' = 'ready';
    #controller?: AbortController;
    #closePromise?: Promise<void>;

    constructor(
        bridge: GoBridge,
        result: OutputResult,
        signal: AbortSignal | undefined,
        release: () => void,
    ) {
        this.#bridge = bridge;
        this.#id = result.id;
        this.metadata = Object.freeze({ ...result.metadata });
        this.#invocationSignal = signal;
        this.#release = release;
    }

    get closed(): boolean {
        return this.#state === 'closed';
    }

    /** @internal */
    get active(): boolean {
        return this.#state === 'consuming' || this.#state === 'closing';
    }

    /** @internal */
    addCleanupError(error: unknown): void {
        this.#cleanupErrors.push(error);
    }

    collect(options: OutputOptions = {}): Promise<Content | null> {
        return this.#consume(undefined, options);
    }

    async consume(
        consumer: OutputConsumer,
        options: OutputOptions = {},
    ): Promise<void> {
        if (typeof consumer !== 'function') {
            throw new TypeError('consumer must be callable');
        }
        await this.#consume(consumer, options);
    }

    async json<T = unknown>(
        options: OutputOptions = {},
    ): Promise<T | undefined> {
        const content = await this.collect(options);
        if (content === null) {
            return undefined;
        }
        try {
            return JSON.parse(
                new TextDecoder('utf-8', { fatal: true }).decode(content.data),
            ) as T;
        } catch (cause) {
            throw new OutputError('Decode output JSON failed', content, {
                cause,
            });
        }
    }

    async #consume(
        consumer: OutputConsumer | undefined,
        options: OutputOptions,
    ): Promise<Content | null> {
        validateOutputOptions(options);
        if (options.signal?.aborted || this.#invocationSignal?.aborted) {
            throw new OutputError('Output consumption was aborted', null, {
                code: 'ABORTED',
            });
        }
        if (this.#state !== 'ready') {
            throw new OutputError(
                this.#state === 'consuming'
                    ? 'Output is already being consumed'
                    : 'Output is closed',
                null,
                {
                    code:
                        this.#state === 'consuming'
                            ? 'OUTPUT_IN_USE'
                            : 'OUTPUT_CLOSED',
                },
            );
        }

        this.#state = 'consuming';
        const bridge = this.#bridge!;
        const controller = new AbortController();
        this.#controller = controller;
        const abort = (): void => controller.abort();
        const signals = new Set([options.signal, this.#invocationSignal]);
        for (const signal of signals) {
            signal?.addEventListener('abort', abort);
        }
        let callbackError: unknown;
        let callbackFailed = false;
        try {
            let completion: OutputCompletion;
            try {
                completion = await callBridge<OutputCompletion>((callback) =>
                    consumer === undefined
                        ? bridge.collectOutput(
                              this.#id,
                              controller.signal,
                              callback,
                          )
                        : bridge.consumeOutput(
                              this.#id,
                              controller.signal,
                              async (chunk) => {
                                  try {
                                      await consumer(chunk, controller.signal);
                                  } catch (error) {
                                      callbackFailed = true;
                                      callbackError = error;
                                      throw error;
                                  }
                              },
                              callback,
                          ),
                );
            } catch (cause) {
                // The bridge rejected admission; a fresh consumption may retry.
                if (this.#state === 'consuming') {
                    this.#state = 'ready';
                }
                throw asOutputError(cause);
            }

            if (completion.closeError != null) {
                this.addCleanupError(fromBridgeError(completion.closeError));
            }
            this.#finish();
            const content =
                completion.content === null
                    ? null
                    : Object.freeze({
                          metadata: Object.freeze({
                              ...completion.content.metadata,
                          }),
                          data: completion.content.data,
                      });
            if (
                completion.error != null ||
                this.#cleanupErrors.length > 0 ||
                callbackFailed
            ) {
                const causes: unknown[] = [];
                if (completion.error != null)
                    causes.push(fromBridgeError(completion.error));
                if (callbackFailed) causes.push(callbackError);
                causes.push(...this.#cleanupErrors);
                throw new OutputError(
                    causes.map(errorMessage).join('\n'),
                    content,
                    {
                        code: completion.error?.code,
                        cause:
                            causes.length === 1
                                ? causes[0]
                                : new AggregateError(causes),
                    },
                );
            }
            return content;
        } finally {
            for (const signal of signals) {
                signal?.removeEventListener('abort', abort);
            }
            this.#controller = undefined;
        }
    }

    close(): Promise<void> {
        if (this.#closePromise != null) return this.#closePromise;
        if (this.closed) {
            this.#closePromise = this.#cleanupResult();
            return this.#closePromise;
        }
        this.#state = 'closing';
        this.#controller?.abort();
        this.#closePromise = this.#close();
        return this.#closePromise;
    }

    async #close(): Promise<void> {
        try {
            await callBridge((callback) =>
                this.#bridge!.closeOutput(this.#id, callback),
            );
        } catch (error) {
            // Active consumption also reports the same native cleanup error.
            if (
                !this.#cleanupErrors.some(
                    (existing) =>
                        errorMessage(existing) === errorMessage(error),
                )
            ) {
                this.addCleanupError(error);
            }
        } finally {
            this.#finish(true);
        }
        await this.#cleanupResult();
    }

    async #cleanupResult(): Promise<void> {
        if (this.#cleanupErrors.length > 0) {
            throw new OutputError(
                this.#cleanupErrors.map(errorMessage).join('\n'),
                null,
                {
                    cause:
                        this.#cleanupErrors.length === 1
                            ? this.#cleanupErrors[0]
                            : new AggregateError(this.#cleanupErrors),
                },
            );
        }
    }

    #finish(explicitClose = false): void {
        // Explicit Close must also deliver its bridge callback before the engine
        // can release the WASM runtime.
        if (this.#state !== 'closing' || explicitClose) {
            this.#state = 'closed';
            // A retained, settled handle must not keep the engine or WASM memory alive.
            this.#bridge = undefined;
            const release = this.#release;
            this.#release = undefined;
            release?.();
        }
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function fromBridgeError(error: BridgeError): OutputError {
    return new OutputError(error.message, null, { code: error.code });
}

function asOutputError(cause: unknown): OutputError {
    if (cause instanceof OutputError) return cause;
    return new OutputError(errorMessage(cause), null, {
        cause,
        code: (cause as { code?: string } | null)?.code,
    });
}

function validateOutputOptions(options: OutputOptions): void {
    if (options == null || typeof options !== 'object')
        throw new TypeError('options must be an object');
    const signal = options.signal;
    if (
        signal != null &&
        (typeof signal !== 'object' ||
            typeof signal.addEventListener !== 'function' ||
            typeof signal.removeEventListener !== 'function')
    ) {
        throw new TypeError('signal must be an AbortSignal');
    }
}

/** @internal */
export async function readOutputJSON<T>(
    pending: Promise<OutputImpl>,
): Promise<T | undefined> {
    const output = await pending;
    try {
        return await output.json<T>();
    } catch (error) {
        const alreadySettled = output.closed;
        try {
            await output.close();
        } catch (cleanupError) {
            if (!alreadySettled) {
                throw new OutputError(
                    'Output consumption and cleanup failed',
                    null,
                    {
                        cause: new AggregateError([error, cleanupError]),
                        code: (error as { code?: string } | null)?.code,
                    },
                );
            }
        }
        throw error;
    }
}
