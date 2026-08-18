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

Class instances and other objects can opt into Ferret operations through the
host-value capability protocols below. Other unsupported values fail
explicitly, including cyclic objects, non-finite numbers, functions as values,
symbols, and big integers.

Binary values returned from Ferret are JSON-decoded according to Ferret's serialization rules.

## Host values and capabilities

JavaScript objects can expose application-owned state to FQL without first
copying it into a plain object. Import the frozen `capabilities` object and
implement the operations the value supports. Each property is a global symbol
created with `Symbol.for("ferret.capability.<name>")`; there are no base classes,
decorators, registration wrappers, or `instanceof` checks.

```javascript
import { capabilities, create } from '@montferret/ferret';

class Settings {
    constructor(values) {
        this.values = new Map(Object.entries(values));
    }

    [capabilities.keyReadable](key) {
        return this.values.has(key) ? this.values.get(key) : undefined;
    }
}

const engine = await create();
const result = await engine.run('RETURN @settings.theme', {
    params: { settings: new Settings({ theme: 'dark' }) },
});
```

`undefined` from a read means that the key or index is missing. `null` is a
present value and becomes Ferret `NONE`. Protocol methods keep their JavaScript
`this` receiver and may return a promise unless noted otherwise.

### Protocol reference

| Capability        | Method result and purpose                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| `keyReadable`     | `(key) => unknown`; read a key.                                                                           |
| `keyWritable`     | `(key, value) => void`; set a key.                                                                        |
| `keyRemovable`    | `(key) => void`; remove a key.                                                                            |
| `indexReadable`   | `(index) => unknown`; read a numeric index.                                                               |
| `indexWritable`   | `(index, value) => void`; replace an index.                                                               |
| `indexRemovable`  | `(index) => void`; remove an index.                                                                       |
| `indexInsertable` | `(index, value) => void`; insert at an index.                                                             |
| `appendable`      | `(value) => void`; append a value.                                                                        |
| `swappable`       | `(first, second) => void`; swap two indices.                                                              |
| `valueRemovable`  | `(value) => void`; remove a matching value.                                                               |
| `clearable`       | `() => void`; clear the collection.                                                                       |
| `measurable`      | `() => number`; return a non-negative safe-integer length.                                                |
| `containable`     | `(value) => boolean`; test membership.                                                                    |
| `spawnable`       | `() => unknown`; create an empty value satisfying the same List or Map composite contract.                |
| `cloneable`       | `() => unknown`; clone the value.                                                                         |
| `hashable`        | `() => number`; synchronously return a stable non-negative safe integer.                                  |
| `equatable`       | `(other) => boolean`; test equality. An equatable value must also implement `hashable`.                   |
| `comparable`      | `(other) => number`; return any negative, zero, or positive ordering result.                              |
| `sortable`        | `(direction) => void`; sort in place for `"asc"` or `"desc"`.                                             |
| `dispatchable`    | `(event) => void`; receive `{ name, payload, options }`.                                                  |
| `observable`      | `(subscription) => Iterable \| AsyncIterable`; receive `{ eventName, options }` and provide event values. |
| `queryable`       | `(query) => Array \| Iterable \| AsyncIterable`; receive `{ kind, expression, params, options }`.         |
| `serializable`    | `() => unknown`; synchronously return ordinary materializable JavaScript data for final output.           |

All methods except `hashable` and `serializable` may return their result or a
promise. TypeScript users can import the matching structural interfaces and the
`FerretMap`, `FerretList`, and `FerretCollection` composite types from either
the Node or browser entrypoint.

### Composite values and derived operations

A Map requires `keyReadable`, `keyWritable`, `keyRemovable`, `measurable`,
`spawnable`, and iteration over `[key, value]` pairs. Ferret derives lookup,
key and value membership, value removal, clearing, cloning, merging, keys,
values, filtering, finding, and `FOR` iteration.

A List requires `indexReadable`, `indexWritable`, `indexRemovable`,
`indexInsertable`, `swappable`, `appendable`, `measurable`, `spawnable`,
`sortable`, and iteration over values. Ferret derives lookup, membership,
index lookup, value removal, clearing, cloning, concatenation, slicing,
first/last, filtering, finding, and `FOR` iteration.

A standalone Collection requires iteration plus `measurable`, `containable`,
`clearable`, and `cloneable`. When `containable`, `clearable`, `cloneable`, or
`valueRemovable` is explicitly present on a List or Map, Ferret prefers it over
the derived behavior.

Implement `Symbol.iterator` or `Symbol.asyncIterator` for native iteration. The
async form wins when both are present. List and generic collection iterators
produce zero-based Ferret keys; Map iterators must produce exactly two-element
`[key, value]` entries. Ferret calls `return()` when iteration stops early, is
cancelled, or fails. `Symbol.dispose` and `Symbol.asyncDispose` are deliberately
not recognized because the JavaScript application retains ownership of the
object.

By default, composite host values use stable JavaScript object identity for
equality, hashing, and ordering. `equatable`/`hashable` and `comparable`
override that behavior. Protocol methods are detected and snapshotted each
time a value independently crosses into an engine, so changing a method does
not mutate an existing wrapper. Passing a host value to a registered shorthand
or module function returns the original JavaScript target, and values returned
from those functions use the same conversion rules as parameters.

### Asynchronous remote Map

```javascript
import { capabilities } from '@montferret/ferret';

class RemoteMap {
    constructor(client, resource) {
        this.client = client;
        this.resource = resource;
    }

    async [capabilities.keyReadable](key) {
        const entry = await this.client.get(this.resource, key);
        return entry.found ? entry.value : undefined;
    }

    async [capabilities.keyWritable](key, value) {
        await this.client.set(this.resource, key, value);
    }

    async [capabilities.keyRemovable](key) {
        await this.client.delete(this.resource, key);
    }

    async [capabilities.measurable]() {
        return this.client.count(this.resource);
    }

    [capabilities.spawnable]() {
        return new RemoteMap(this.client, this.client.temporaryResource());
    }

    async *[Symbol.asyncIterator]() {
        for await (const entry of this.client.entries(this.resource)) {
            yield [entry.key, entry.value];
        }
    }
}
```

The complete composite makes `LENGTH(remote)`, property lookup and mutation,
`DELETE`, `KEYS`, `VALUES`, `MERGE`, filtering, cloning, object spread, and
`FOR` iteration available without reimplementing those operations in
JavaScript.

Protocol throws and rejected promises fail the current execution. Returned
values are converted recursively, so a protocol may return another host value.
An opaque host value used as the final FQL result must implement `serializable`,
or satisfy the serializable List, Map, or iterable contract. Serialization must
produce ordinary finite, acyclic JavaScript data and may not return the same
host object recursively.

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
