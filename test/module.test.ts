import { describe, expect, it } from 'vitest';

// @ts-ignore The generated declaration exists only after the build step.
import {
    create,
    defineModule,
    type CompileResultEvent,
    type ModuleDefinition,
    type ModuleLifecycle,
    type RunResultEvent,
} from '../dist/index.node.js';

describe('Ferret JavaScript modules', () => {
    it('defines modules without wrapping them and snapshots registration', async () => {
        const lifecycle: ModuleLifecycle = {
            onInit() {},
        };
        const definition: ModuleDefinition = {
            name: 'first',
            functions: {
                hello: (name) => `Hello, ${String(name)}!`,
            },
            lifecycle,
        };
        const module = defineModule(definition);
        expect(module).toBe(definition);

        const engine = await create({
            functions: {
                shorthand: () => 'short',
            },
            modules: [
                module,
                {
                    name: 'second',
                    functions: {
                        answer: () => 42,
                    },
                },
            ],
        });

        (definition.functions as Record<string, () => string>).hello = () =>
            'mutated';

        try {
            await expect(
                engine.run(
                    'RETURN { hello: HELLO("Ferret"), answer: ANSWER(), shorthand: SHORTHAND() }',
                ),
            ).resolves.toEqual({
                hello: 'Hello, Ferret!',
                answer: 42,
                shorthand: 'short',
            });
        } finally {
            await engine.close();
        }
    });

    it('validates definitions and duplicate module names before loading WASM', async () => {
        expect(() => defineModule(null as never)).toThrow(
            'module definition must be a plain JavaScript object',
        );
        expect(() => defineModule({ name: '  ' })).toThrow(
            'module definition.name must be a non-empty string',
        );
        expect(() =>
            defineModule({ name: 'bad-functions', functions: [] as never }),
        ).toThrow('functions must be a plain JavaScript object');
        expect(() =>
            defineModule({ name: 'bad-namespace', namespace: null as never }),
        ).toThrow('namespace must be a string');
        for (const namespace of [
            '',
            '   ',
            '::TEST',
            'TEST::',
            'TEST::::UTILS',
            'TEST UTILS',
            '1TEST',
            'TEST::1UTILS',
            'TEST::UTILS-NEXT',
            'TÉST',
        ]) {
            expect(() =>
                defineModule({
                    name: 'bad-namespace',
                    namespace,
                }),
            ).toThrow(
                'namespace must contain valid FQL identifier segments separated by "::"',
            );
        }
        expect(() =>
            defineModule({
                name: 'bad-function',
                functions: { value: 1 as never },
            }),
        ).toThrow('functions["value"] must be callable');
        expect(() =>
            defineModule({ name: 'bad-lifecycle', lifecycle: [] as never }),
        ).toThrow('lifecycle must be a plain JavaScript object');
        expect(() =>
            defineModule({
                name: 'bad-callback',
                lifecycle: { onInit: true as never },
            }),
        ).toThrow('lifecycle.onInit must be callable');
        expect(() =>
            defineModule({
                name: 'unsupported',
                lifecycle: { onStart() {} } as never,
            }),
        ).toThrow('onStart is not a supported lifecycle callback');

        await expect(create({ modules: {} as never })).rejects.toThrow(
            'modules must be an array',
        );
        await expect(
            create({
                modules: [
                    { name: 'same', namespace: 'FIRST' },
                    { name: 'same', namespace: 'SECOND' },
                ],
            }),
        ).rejects.toThrow('duplicate module name "same"');
        await expect(
            create({
                modules: [{ name: 'direct', namespace: 'INVALID::' }],
            }),
        ).rejects.toThrow(
            'modules[0].namespace must contain valid FQL identifier segments separated by "::"',
        );

        const engine = await create({
            modules: [{ name: 'Case' }, { name: 'case' }],
        });
        await engine.close();
    });

    it('registers module functions in optional nested namespaces', async () => {
        const definition: ModuleDefinition = {
            name: 'telemetry',
            namespace: 'Observability::Telemetry',
            functions: {
                track: (value) => value,
                'UTIL::flush': () => 'flushed',
            },
        };
        const creating = create({ modules: [definition] });

        (definition as { namespace?: string }).namespace = 'MUTATED';

        const engine = await creating;
        try {
            await expect(
                engine.run('RETURN oBsErVaBiLiTy::tElEmEtRy::TrAcK("event")'),
            ).resolves.toBe('event');
            await expect(
                engine.run('RETURN OBSERVABILITY::TELEMETRY::UTIL::FLUSH()'),
            ).resolves.toBe('flushed');
            await expect(engine.run('RETURN TRACK("event")')).rejects.toThrow();
            await expect(
                engine.run('RETURN MUTATED::TRACK("event")'),
            ).rejects.toThrow();
        } finally {
            await engine.close();
        }
    });

    it('separates module identity from effective FQL function identity', async () => {
        const engine = await create({
            functions: {
                track: () => 'root',
            },
            modules: [
                {
                    name: 'analytics',
                    namespace: 'ANALYTICS',
                    functions: { track: () => 'analytics' },
                },
                {
                    name: 'telemetry',
                    namespace: 'TELEMETRY',
                    functions: { track: () => 'telemetry' },
                },
            ],
        });

        try {
            await expect(
                engine.run(
                    'RETURN [TRACK(), ANALYTICS::TRACK(), TELEMETRY::TRACK()]',
                ),
            ).resolves.toEqual(['root', 'analytics', 'telemetry']);
        } finally {
            await engine.close();
        }

        await expect(
            create({
                modules: [
                    {
                        name: 'first',
                        namespace: 'Base',
                        functions: { 'Util::value': () => 1 },
                    },
                    {
                        name: 'second',
                        namespace: 'BASE::UTIL',
                        functions: { VALUE: () => 2 },
                    },
                ],
            }),
        ).rejects.toThrow('already exists');
    });

    it('uses Ferret canonical conflict semantics across registrations', async () => {
        await expect(
            create({
                modules: [
                    { name: 'first', functions: { value: () => 1 } },
                    { name: 'second', functions: { VALUE: () => 2 } },
                ],
            }),
        ).rejects.toThrow('already exists');

        await expect(
            create({
                functions: { value: () => 1 },
                modules: [{ name: 'module', functions: { VALUE: () => 2 } }],
            }),
        ).rejects.toThrow('already exists');
    });

    it('awaits lifecycle promises and exposes immutable semantic events', async () => {
        const events: string[] = [];
        const initEntered = deferred<void>();
        const releaseInit = deferred<void>();
        const closeEntered = deferred<void>();
        const releaseClose = deferred<void>();
        const creating = create({
            modules: [
                defineModule({
                    name: 'lifecycle',
                    lifecycle: {
                        async onInit() {
                            events.push('init');
                            initEntered.resolve(undefined);
                            await releaseInit.promise;
                        },
                        async beforeCompile(event) {
                            expect(Object.isFrozen(event)).toBe(true);
                            expect(Object.isFrozen(event.source)).toBe(true);
                            expect(event.source).toEqual({
                                name: 'module.fql',
                                text: 'RETURN 42',
                            });
                            events.push('beforeCompile');
                            await Promise.resolve();
                        },
                        async afterCompile(event) {
                            expect(event.error).toBeUndefined();
                            events.push('afterCompile');
                            await Promise.resolve();
                        },
                        async beforeRun(event) {
                            expect(Object.isFrozen(event)).toBe(true);
                            events.push('beforeRun');
                            await Promise.resolve();
                        },
                        async afterRun(event) {
                            expect(event.error).toBeUndefined();
                            events.push('afterRun');
                            await Promise.resolve();
                        },
                        async onSessionClose(event) {
                            expect(Object.isFrozen(event)).toBe(true);
                            events.push('sessionClose');
                            await Promise.resolve();
                        },
                        async onPlanClose() {
                            events.push('planClose');
                            await Promise.resolve();
                        },
                        async onClose() {
                            closeEntered.resolve(undefined);
                            await releaseClose.promise;
                            events.push('close');
                        },
                    },
                }),
            ],
        });

        await initEntered.promise;
        let initialized = false;
        void creating.then(() => {
            initialized = true;
        });
        await Promise.resolve();
        expect(initialized).toBe(false);
        releaseInit.resolve(undefined);

        const engine = await creating;
        const plan = await engine.compile({
            name: 'module.fql',
            text: 'RETURN 42',
        });
        const session = await plan.createSession();
        await expect(session.run()).resolves.toBe(42);
        await session.close();
        await plan.close();
        const closing = engine.close();
        await closeEntered.promise;
        let closed = false;
        void closing.then(() => {
            closed = true;
        });
        await Promise.resolve();
        expect(closed).toBe(false);
        releaseClose.resolve(undefined);
        await closing;

        expect(events).toEqual([
            'init',
            'beforeCompile',
            'afterCompile',
            'beforeRun',
            'afterRun',
            'sessionClose',
            'planClose',
            'close',
        ]);
    });

    it('inherits FIFO and LIFO hook ordering from Ferret Core', async () => {
        const events: string[] = [];
        const module = (name: string) =>
            defineModule({
                name,
                lifecycle: {
                    onInit() {
                        events.push(`${name}:init`);
                    },
                    beforeCompile() {
                        events.push(`${name}:beforeCompile`);
                    },
                    afterCompile() {
                        events.push(`${name}:afterCompile`);
                    },
                    beforeRun() {
                        events.push(`${name}:beforeRun`);
                    },
                    afterRun() {
                        events.push(`${name}:afterRun`);
                    },
                    onSessionClose() {
                        events.push(`${name}:sessionClose`);
                    },
                    onPlanClose() {
                        events.push(`${name}:planClose`);
                    },
                    onClose() {
                        events.push(`${name}:close`);
                    },
                },
            });

        const engine = await create({
            modules: [module('first'), module('second')],
        });
        const plan = await engine.compile('RETURN TRUE');
        const session = await plan.createSession();
        await session.run();
        await session.close();
        await plan.close();
        await engine.close();

        expect(events).toEqual([
            'first:init',
            'second:init',
            'first:beforeCompile',
            'second:beforeCompile',
            'second:afterCompile',
            'first:afterCompile',
            'first:beforeRun',
            'second:beforeRun',
            'second:afterRun',
            'first:afterRun',
            'second:sessionClose',
            'first:sessionClose',
            'second:planClose',
            'first:planClose',
            'second:close',
            'first:close',
        ]);
    });

    it('propagates initialization and before-hook failures with phase context', async () => {
        const initEvents: string[] = [];
        await expect(
            create({
                modules: [
                    {
                        name: 'initialization',
                        namespace: 'NAMESPACED',
                        lifecycle: {
                            async onInit() {
                                initEvents.push('init');
                                throw new Error('init rejected');
                            },
                            async onClose() {
                                initEvents.push('close');
                            },
                        },
                    },
                ],
            }),
        ).rejects.toThrow(
            /module "initialization" lifecycle onInit.*init rejected/s,
        );
        expect(initEvents).toEqual(['init', 'close']);

        let afterCompileCalled = false;
        const compileEngine = await create({
            modules: [
                {
                    name: 'compile-before',
                    lifecycle: {
                        beforeCompile() {
                            throw new Error('compile rejected');
                        },
                        afterCompile() {
                            afterCompileCalled = true;
                        },
                    },
                },
            ],
        });
        await expect(compileEngine.compile('RETURN TRUE')).rejects.toThrow(
            /beforeCompile.*compile rejected/s,
        );
        expect(afterCompileCalled).toBe(false);
        await compileEngine.close();

        let afterRunCalled = false;
        const runEngine = await create({
            modules: [
                {
                    name: 'run-before',
                    lifecycle: {
                        beforeRun() {
                            return Promise.reject(new Error('run rejected'));
                        },
                        afterRun() {
                            afterRunCalled = true;
                        },
                    },
                },
            ],
        });
        const plan = await runEngine.compile('RETURN TRUE');
        const session = await plan.createSession();
        await expect(session.run()).rejects.toThrow(/beforeRun.*run rejected/s);
        expect(afterRunCalled).toBe(false);
        await runEngine.close();
    });

    it('passes underlying failures to result hooks and propagates after-hook rejection', async () => {
        let compileEvent: CompileResultEvent | undefined;
        const compileEngine = await create({
            modules: [
                {
                    name: 'compile-result',
                    lifecycle: {
                        afterCompile(event) {
                            compileEvent = event;
                        },
                    },
                },
            ],
        });
        await expect(
            compileEngine.compile({ name: 'broken.fql', text: 'RETURN (' }),
        ).rejects.toThrow();
        expect(compileEvent?.source.name).toBe('broken.fql');
        expect(compileEvent?.error).toBeInstanceOf(Error);
        await compileEngine.close();

        const rejectedCompileEngine = await create({
            modules: [
                {
                    name: 'compile-after-rejection',
                    lifecycle: {
                        async afterCompile() {
                            throw new Error('after compile rejected');
                        },
                    },
                },
            ],
        });
        await expect(
            rejectedCompileEngine.compile('RETURN TRUE'),
        ).rejects.toThrow(/afterCompile.*after compile rejected/s);
        await rejectedCompileEngine.close();

        let runEvent: RunResultEvent | undefined;
        const runEngine = await create({
            functions: {
                fail: async () => {
                    throw new Error('runtime failed');
                },
            },
            modules: [
                {
                    name: 'run-result',
                    lifecycle: {
                        afterRun(event) {
                            runEvent = event;
                            throw new Error('after run rejected');
                        },
                    },
                },
            ],
        });
        await expect(runEngine.run('RETURN FAIL()')).rejects.toThrow(
            /runtime failed.*afterRun.*after run rejected/s,
        );
        expect(runEvent?.error).toBeInstanceOf(Error);
        expect((runEvent?.error as Error).message).toContain('runtime failed');
        await runEngine.close();
    });

    it('closes exactly once after rejected close hooks and releases the runtime', async () => {
        const calls = { session: 0, plan: 0, engine: 0 };
        const engine = await create({
            modules: [
                {
                    name: 'close-errors',
                    lifecycle: {
                        async onSessionClose() {
                            calls.session++;
                            throw new Error('session close rejected');
                        },
                        async onPlanClose() {
                            calls.plan++;
                            throw new Error('plan close rejected');
                        },
                        async onClose() {
                            calls.engine++;
                            throw new Error('engine close rejected');
                        },
                    },
                },
            ],
        });
        const plan = await engine.compile('RETURN TRUE');
        const session = await plan.createSession();

        await expect(session.close()).rejects.toThrow('session close rejected');
        expect(session.closed).toBe(true);
        await session.close();

        await expect(plan.close()).rejects.toThrow('plan close rejected');
        expect(plan.closed).toBe(true);
        await plan.close();

        await expect(engine.close()).rejects.toThrow('engine close rejected');
        expect(engine.closed).toBe(true);
        await engine.close();

        expect(calls).toEqual({ session: 1, plan: 1, engine: 1 });
    });

    it('rejects reentrant operations while lifecycle close callbacks run', async () => {
        const messages: string[] = [];
        let engine: Awaited<ReturnType<typeof create>>;
        let plan: Awaited<ReturnType<typeof engine.compile>>;
        let session: Awaited<ReturnType<typeof plan.createSession>>;

        engine = await create({
            modules: [
                {
                    name: 'reentrant',
                    lifecycle: {
                        async onSessionClose() {
                            await session
                                .close()
                                .catch((error: Error) =>
                                    messages.push(error.message),
                                );
                        },
                        async onPlanClose() {
                            await plan
                                .close()
                                .catch((error: Error) =>
                                    messages.push(error.message),
                                );
                        },
                        async onClose() {
                            await engine
                                .close()
                                .catch((error: Error) =>
                                    messages.push(error.message),
                                );
                            await engine
                                .compile('RETURN TRUE')
                                .catch((error: Error) =>
                                    messages.push(error.message),
                                );
                        },
                    },
                },
            ],
        });
        plan = await engine.compile('RETURN TRUE');
        session = await plan.createSession();

        await session.close();
        await plan.close();
        await engine.close();

        expect(messages).toEqual([
            'Session is closing',
            'Plan is closing',
            'Engine is closing',
            'Engine is closing',
        ]);
    });

    it('does not accumulate callbacks across repeated engine lifecycles', async () => {
        let initCalls = 0;
        let closeCalls = 0;

        for (let index = 0; index < 8; index++) {
            const engine = await create({
                modules: [
                    {
                        name: `cycle-${index}`,
                        lifecycle: {
                            onInit() {
                                initCalls++;
                            },
                            onClose() {
                                closeCalls++;
                            },
                        },
                    },
                ],
            });
            await engine.close();
        }

        expect(initCalls).toBe(8);
        expect(closeCalls).toBe(8);
        expect(
            Object.keys(
                (
                    globalThis as typeof globalThis & {
                        __ferretWasmBridges?: Record<string, unknown>;
                    }
                ).__ferretWasmBridges ?? {},
            ),
        ).toHaveLength(0);
    });
});

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });

    return { promise, resolve, reject };
}
