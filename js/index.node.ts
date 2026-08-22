import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { webcrypto } from 'node:crypto';

import type { FerretGlobals } from './bridge';
import { createWithPlatform, type Platform } from './factory';
import { createNodeHTTPTransport } from './node_http';
import type { CreateOptions } from './types';

export { defineModule } from './module';

declare const __filename: string | undefined;

const moduleURL =
    typeof __filename === 'string'
        ? pathToFileURL(__filename).href
        : import.meta.url;

const platform: Platform = {
    defaultWasm: new URL('./ferret.wasm', moduleURL),
    createHTTPTransport: createNodeHTTPTransport,
    async prepare(runtime): Promise<void> {
        const globals = globalThis as typeof globalThis & FerretGlobals;
        globals.fs ??= fs;
        globals.path ??= path;
        globalThis.crypto ??= webcrypto as Crypto;
        globalThis.performance ??= performance as unknown as Performance;
        await import(/* @vite-ignore */ runtime.href);
    },
    async load(source): Promise<BufferSource | WebAssembly.Module> {
        if (source instanceof WebAssembly.Module) {
            return source;
        }

        if (source instanceof ArrayBuffer || source instanceof Uint8Array) {
            return source;
        }

        const target =
            source instanceof URL
                ? source
                : isRemote(source)
                  ? new URL(source)
                  : path.resolve(source);

        if (target instanceof URL && target.protocol !== 'file:') {
            const response = await fetch(target);

            if (!response.ok) {
                throw new Error(
                    `Failed to load WASM: ${response.status} ${response.statusText}`,
                );
            }

            return response.arrayBuffer();
        }

        return fs.promises.readFile(target);
    },
};

export function create(options?: CreateOptions) {
    return createWithPlatform(
        platform,
        new URL('./wasm_exec.js', moduleURL),
        options,
    );
}

function isRemote(value: string): boolean {
    return /^[a-z][a-z\d+.-]*:\/\//i.test(value);
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
