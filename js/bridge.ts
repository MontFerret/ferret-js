import type {
    Content,
    Metadata,
    ModuleDefinition,
    RuntimeFunction,
    Version,
} from './types';
import type { HTTPTransport } from './http';

export interface BridgeError {
    message: string;
    code?: string;
}

export interface BridgeResult<T = undefined> {
    ok: boolean;
    data?: T;
    error?: BridgeError;
}

export interface CompileResult {
    id: string;
    params: string[];
}

export interface OutputResult {
    id: string;
    metadata: Metadata;
}

/** A successful bridge call can still carry terminal execution/cleanup errors. */
export interface OutputCompletion {
    content: Content | null;
    error?: BridgeError;
    closeError?: BridgeError;
}

export interface GoBridge {
    initialize(
        functions: Record<string, RuntimeFunction>,
        modules: readonly ModuleDefinition[],
        allowLocalhost: boolean,
        transport: HTTPTransport,
        callback: (result: BridgeResult<undefined>) => void,
    ): BridgeResult<undefined>;
    version(): BridgeResult<Version>;
    compile(
        name: string,
        text: string,
        signal: AbortSignal | undefined,
        callback: (result: BridgeResult<CompileResult>) => void,
    ): BridgeResult<undefined>;
    createSession(
        planId: string,
        params: Record<string, unknown> | undefined,
        signal: AbortSignal | undefined,
        callback: (result: BridgeResult<string>) => void,
    ): BridgeResult<undefined>;
    runSession(
        sessionId: string,
        signal: AbortSignal | undefined,
        callback: (result: BridgeResult<OutputResult>) => void,
    ): BridgeResult<undefined>;
    collectOutput(
        outputId: string,
        signal: AbortSignal | undefined,
        callback: (result: BridgeResult<OutputCompletion>) => void,
    ): BridgeResult<undefined>;
    consumeOutput(
        outputId: string,
        signal: AbortSignal | undefined,
        consumer: (chunk: Uint8Array) => Promise<void>,
        callback: (result: BridgeResult<OutputCompletion>) => void,
    ): BridgeResult<undefined>;
    closeOutput(
        outputId: string,
        callback: (result: BridgeResult<undefined>) => void,
    ): BridgeResult<undefined>;
    closeSession(
        sessionId: string,
        callback: (result: BridgeResult<undefined>) => void,
    ): BridgeResult<undefined>;
    closePlan(
        planId: string,
        callback: (result: BridgeResult<undefined>) => void,
    ): BridgeResult<undefined>;
    closeEngine(
        callback: (result: BridgeResult<undefined>) => void,
    ): BridgeResult<undefined>;
    shutdown(): BridgeResult<undefined>;
}

export interface GoRuntime {
    _scheduledTimeouts: Map<number, ReturnType<typeof setTimeout>>;
    env: Record<string, string>;
    importObject: WebAssembly.Imports;
    run(instance: WebAssembly.Instance): Promise<void>;
}

export interface GoRuntimeConstructor {
    new (): GoRuntime;
}

export interface FerretGlobals {
    Go?: GoRuntimeConstructor;
    __ferretWasmBridges?: Record<string, GoBridge>;
    fs?: unknown;
    path?: unknown;
}

export function unwrap<T>(result: BridgeResult<T>): T {
    if (result?.ok) {
        return result.data as T;
    }

    const error = Object.assign(
        new Error(result?.error?.message ?? 'Unexpected WASM error'),
        { code: result?.error?.code },
    );
    if (result?.error?.code === 'ABORTED') {
        error.name = 'AbortError';
    }
    throw error;
}

/** @internal */
export function callBridge<T>(
    start: (
        callback: (result: BridgeResult<T>) => void,
    ) => BridgeResult<undefined>,
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const callback = (result: BridgeResult<T>): void => {
            try {
                resolve(unwrap(result));
            } catch (error) {
                reject(error);
            }
        };

        try {
            unwrap(start(callback));
        } catch (error) {
            reject(error);
        }
    });
}
