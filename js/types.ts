export type SourceInput = string | { name?: string; text: string };
export type Params = Record<string, unknown>;
export type RuntimeFunction = (
    ...args: unknown[]
) => unknown | Promise<unknown>;
export type MaybePromise<T> = T | PromiseLike<T>;

export interface CompileSource {
    readonly name: string;
    readonly text: string;
}

export interface CompileEvent {
    readonly source: Readonly<CompileSource>;
}

export interface CompileResultEvent extends CompileEvent {
    readonly error?: unknown;
}

export interface PlanEvent {}

export interface RunEvent {}

export interface RunResultEvent extends RunEvent {
    readonly error?: unknown;
}

export interface SessionEvent {}

export interface ModuleLifecycle {
    onInit?(): MaybePromise<void>;
    onClose?(): MaybePromise<void>;
    beforeCompile?(event: CompileEvent): MaybePromise<void>;
    afterCompile?(event: CompileResultEvent): MaybePromise<void>;
    onPlanClose?(event: PlanEvent): MaybePromise<void>;
    beforeRun?(event: RunEvent): MaybePromise<void>;
    afterRun?(event: RunResultEvent): MaybePromise<void>;
    onSessionClose?(event: SessionEvent): MaybePromise<void>;
}

export interface ModuleDefinition {
    readonly name: string;
    readonly namespace?: string;
    readonly functions?: Readonly<Record<string, RuntimeFunction>>;
    readonly lifecycle?: Readonly<ModuleLifecycle>;
}

export interface HTTPOptions {
    allowLocalhost?: boolean;
}

export interface CreateOptions {
    wasm?: string | URL | ArrayBuffer | Uint8Array | WebAssembly.Module;
    functions?: Record<string, RuntimeFunction>;
    modules?: readonly ModuleDefinition[];
    http?: HTTPOptions;
}

export interface ExecutionOptions {
    params?: Params;
    signal?: AbortSignal;
}

export interface CompileOptions {
    signal?: AbortSignal;
}

export interface SessionOptions {
    params?: Params;
    signal?: AbortSignal;
}

export interface SessionRunOptions {
    signal?: AbortSignal;
}

export interface Version {
    self: string;
    ferret: string;
}

export interface Session {
    readonly closed: boolean;
    run<T = unknown>(options?: SessionRunOptions): Promise<T>;
    close(): Promise<void>;
}

export interface Plan {
    readonly params: readonly string[];
    readonly closed: boolean;
    createSession(options?: SessionOptions): Promise<Session>;
    run<T = unknown>(options?: ExecutionOptions): Promise<T>;
    close(): Promise<void>;
}

export interface Engine {
    readonly version: Readonly<Version>;
    readonly closed: boolean;
    compile(source: SourceInput, options?: CompileOptions): Promise<Plan>;
    run<T = unknown>(
        source: SourceInput,
        options?: ExecutionOptions,
    ): Promise<T>;
    close(): Promise<void>;
}
