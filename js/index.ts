import { createWithPlatform, type Platform } from './factory';
import { createBrowserHTTPTransport } from './browser_http';
import type { CreateOptions } from './types';

export { defineModule } from './module';
export { capabilities } from './capabilities';

const moduleURL = import.meta.url;
const platform: Platform = {
    defaultWasm: new URL('./ferret.wasm', moduleURL),
    createHTTPTransport: createBrowserHTTPTransport,
    async prepare(runtime): Promise<void> {
        await import(/* @vite-ignore */ runtime.href);
    },
    async load(source): Promise<BufferSource | WebAssembly.Module> {
        if (source instanceof WebAssembly.Module) {
            return source;
        }

        if (source instanceof ArrayBuffer || source instanceof Uint8Array) {
            return source;
        }

        const response = await fetch(source);

        if (!response.ok) {
            throw new Error(
                `Failed to load WASM: ${response.status} ${response.statusText}`,
            );
        }

        return response.arrayBuffer();
    },
};

export function create(options?: CreateOptions) {
    return createWithPlatform(
        platform,
        new URL('./wasm_exec.js', moduleURL),
        options,
    );
}

export type {
    CompileEvent,
    CompileOptions,
    CompileResultEvent,
    CompileSource,
    CreateOptions,
    Engine,
    ExecutionOptions,
    HTTPOptions,
    MaybePromise,
    ModuleDefinition,
    ModuleLifecycle,
    Params,
    Plan,
    PlanEvent,
    RunEvent,
    RunResultEvent,
    RuntimeFunction,
    Session,
    SessionEvent,
    SessionOptions,
    SessionRunOptions,
    SourceInput,
    Version,
} from './types';

export type {
    Appendable,
    CapabilitySymbols,
    Clearable,
    Cloneable,
    Comparable,
    Containable,
    Dispatchable,
    DispatchEvent,
    Equatable,
    FerretCollection,
    FerretList,
    FerretMap,
    Hashable,
    HostQuery,
    IndexInsertable,
    IndexReadable,
    IndexRemovable,
    IndexWritable,
    KeyReadable,
    KeyRemovable,
    KeyWritable,
    Measurable,
    Observable,
    ObservableResult,
    Queryable,
    QueryResult,
    Serializable,
    Sortable,
    Spawnable,
    Subscription,
    Swappable,
    ValueRemovable,
} from './capabilities';
