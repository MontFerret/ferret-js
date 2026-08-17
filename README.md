# Ferret JS

Official JavaScript runtime for compiling and running Ferret programs in Node.js and modern browsers.

Powered by `github.com/MontFerret/ferret/v2`, this package exposes a small TypeScript-friendly API around Ferret engines, compiled plans, and execution sessions. Results are returned as JSON-decoded JavaScript values.

> Ferret v2 is currently in alpha. APIs may still change before the stable release.

## Installation

```sh
npm install @montferret/ferret
```

## Requirements

- Node.js 22 or newer
- A modern browser with WebAssembly, `fetch`, and `crypto.getRandomValues`
- Go 1.25 or newer when building from source

## Quick start

```javascript
import { create } from '@montferret/ferret';

const engine = await create();

try {
    const result = await engine.run(
        `RETURN (FOR value IN 1..3 RETURN value * @factor)`,
        { params: { factor: 2 } },
    );

    console.log(result); // [2, 4, 6]
} finally {
    await engine.close();
}
```

CommonJS is also supported:

```javascript
const { create } = require('@montferret/ferret');
```

## Core concepts

Ferret JS has three explicit runtime objects:

- `Engine` owns the Ferret runtime, registered JavaScript functions, and
  modules.
- `Plan` is a compiled Ferret program that can be reused.
- `Session` is an execution context with captured parameters.

For one-off execution, use `engine.run()`. For repeated execution, compile once and reuse a plan.

## Plans and sessions

```javascript
const engine = await create();
const plan = await engine.compile(`RETURN @factor * 2`);

console.log(plan.params); // ['factor']
console.log(await plan.run({ params: { factor: 3 } })); // 6

const session = await plan.createSession({ params: { factor: 4 } });

try {
    console.log(await session.run()); // 8
    console.log(await session.run()); // 8
} finally {
    await session.close();
    await plan.close();
    await engine.close();
}
```

Compiling a plan and creating a session are asynchronous. Sessions are reusable, but they do not support concurrent runs. Closing an engine closes its idle child plans and sessions. Closing a plan closes its idle child sessions. If resource creation is pending or a child session is currently running, `close()` rejects without closing anything. Every `close()` method is idempotent.

## Register JavaScript functions

JavaScript functions are registered when the engine is created and cannot be mutated afterward. Function names are canonicalized to uppercase, including namespace segments. Functions may return either a value or a promise.

```javascript
const engine = await create({
    functions: {
        join: (...values) => values.join('-'),
        async_value: async () => ({ status: 'ok' }),
    },
});

try {
    console.log(await engine.run(`RETURN JOIN('a', 'b')`)); // a-b
    console.log(await engine.run(`RETURN ASYNC_VALUE()`)); // { status: 'ok' }
} finally {
    await engine.close();
}
```

## Modules and lifecycle hooks

Use `defineModule()` when JavaScript functions need to participate in the
Ferret engine, plan, or session lifecycle. Modules are registered when the
engine is created and cannot be added, removed, or changed afterward.

```javascript
import { create, defineModule } from '@montferret/ferret';

const logger = defineModule({
    name: 'logger',
    namespace: 'APP::LOGGING',
    functions: {
        log: (value) => console.log(value),
    },
    lifecycle: {
        onInit() {
            console.log('engine initialized');
        },
        beforeRun() {
            console.log('running Ferret');
        },
    },
});

const engine = await create({
    modules: [logger],
});
```

The `log` function is available to FQL as `APP::LOGGING::LOG(...)` and is not
also registered as a top-level `LOG(...)` function.

Modules can define engine hooks (`onInit`, `onClose`), plan hooks
(`beforeCompile`, `afterCompile`, `onPlanClose`), and session hooks
(`beforeRun`, `afterRun`, `onSessionClose`). Every callback may return normally
or return a promise; Ferret waits for asynchronous callbacks and propagates
thrown or rejected errors to the corresponding `create()`, `compile()`,
`run()`, or `close()` promise.

Compile callbacks receive the normalized source. The `afterCompile` and
`afterRun` events also contain an `error` when the underlying operation failed.
Hook ordering follows Ferret Core: initialization and before hooks run in module
registration order, while after and close hooks run in reverse order.

The `functions` option remains the simpler shorthand when lifecycle callbacks
are not needed, and it can be used together with modules. A module's `name` is
its case-sensitive registration and lifecycle identity. The optional
`namespace` independently places its functions under an FQL namespace and is
never inferred from `name`; modules that omit it continue to register functions
at the top level. Namespace and function lookup remain case-insensitive, while
declared namespace spelling is preserved. Qualified function keys are relative
to the module namespace, so namespace `APP` with key `LOGGING::WRITE` exposes
`APP::LOGGING::WRITE(...)`.

## Values

Parameters, return values, and JavaScript function values support JSON-compatible data plus `Uint8Array`.

| JavaScript value     | Ferret value |
| -------------------- | ------------ |
| `undefined` / `null` | `NONE`       |
| `boolean`            | Boolean      |
| `string`             | String       |
| finite `number`      | Number       |
| `Array`              | Array        |
| plain object         | Object       |
| `Uint8Array`         | Binary       |

Unsupported values fail explicitly. This includes cyclic objects, non-finite numbers, class instances, functions as values, and other non-plain JavaScript objects.

Binary values returned from Ferret are JSON-decoded according to Ferret's serialization rules.

## Cancellation

Pass an `AbortSignal` to `engine.compile()`, `engine.run()`, `plan.createSession()`, `plan.run()`, or `session.run()`:

```javascript
const controller = new AbortController();
const pending = engine.run(`WAIT(10000) RETURN TRUE`, {
    signal: controller.signal,
});

controller.abort();

try {
    await pending;
} catch (error) {
    console.log(error.name); // AbortError
}
```

Ferret execution and HTTP calls observe cancellation. JavaScript promises returned by registered functions cannot be forcibly cancelled; the runtime remains alive until the promise settles, then reports the run as aborted.

Compilation and session creation also reject with `AbortError` when cancelled:

```javascript
const controller = new AbortController();
controller.abort();

try {
    await engine.compile(`RETURN TRUE`, {
        signal: controller.signal,
    });
} catch (error) {
    console.log(error.name); // AbortError
}
```

## Browser loading

The browser export loads `ferret.wasm` and `wasm_exec.js` relative to the package entrypoint. Both files must be served together with the generated JavaScript bundle.

You can override the WASM source:

```javascript
const engine = await create({
    wasm: new URL('/assets/ferret.wasm', location.href),
});
```

The `wasm` option accepts:

- a browser URL
- a file path in Node.js
- an `ArrayBuffer`
- a `Uint8Array`
- a precompiled `WebAssembly.Module`

The full Ferret v2 standard library is registered. Ferret's HTTP policy denies
localhost and loopback addresses by default. Trusted applications can opt in to
localhost access when creating an engine:

```javascript
const engine = await create({
    http: { allowLocalhost: true },
});
```

This option enables loopback access only; private and link-local networks remain
blocked. Each Node engine uses its own `node:http` and `node:https` connection
pools. DNS results are policy-checked before connecting, the selected address is
pinned for that request, and redirects are returned to Ferret for validation
before they are followed.

Browser HTTP is intentionally limited to same-origin requests. Fetch is called
with redirect handling disabled, so cross-origin requests and redirects are
rejected. Browsers do not expose concrete DNS results or redirect destinations,
which prevents Ferret from applying its network policy safely to those targets.

## Migrating from v1

| v1                             | v2                                      |
| ------------------------------ | --------------------------------------- |
| `compiler.exec(query, params)` | `engine.run(query, { params })`         |
| `compiler.compile(query)`      | `await engine.compile(query)`           |
| `program.run(params)`          | `plan.run({ params })`                  |
| `program.destroy()`            | `await plan.close()`                    |
| `compiler.register(name, fn)`  | `create({ functions: { [name]: fn } })` |
| `compiler.version()`           | `engine.version`                        |

There is no v1 compatibility facade.

## Development

```sh
npm ci
npm run build
npm run check
npm run test:browser
```

The build copies `wasm_exec.js` from the same Go installation used to compile `ferret.wasm`. These files must always be published together.
