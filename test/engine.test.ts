import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// @ts-ignore The generated declaration exists only after the build step.
import { create } from '../dist/index.node.js';

let httpServer: Server;
let httpBaseURL: string;
let valueRequests = 0;

beforeAll(async () => {
    httpServer = createServer((request, response) => {
        switch (request.url) {
            case '/value':
                valueRequests++;
                response.writeHead(200, { 'Content-Type': 'text/plain' });
                response.end('node');
                return;
            case '/redirect':
                response.writeHead(302, { Location: '/value' });
                response.end();
                return;
            case '/blocked-redirect':
                response.writeHead(302, {
                    Location: 'http://169.254.169.254/latest/meta-data/',
                });
                response.end();
                return;
            case '/slow': {
                const timeout = setTimeout(() => {
                    response.writeHead(200);
                    response.end('late');
                }, 5_000);
                response.once('close', () => clearTimeout(timeout));
                return;
            }
            case '/oversized':
                response.writeHead(200, {
                    'Content-Length': String((16 << 20) + 1),
                    'Content-Type': 'application/octet-stream',
                });
                response.end(Buffer.alloc((16 << 20) + 1));
                return;
            default:
                response.writeHead(404);
                response.end();
        }
    });

    await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(0, '127.0.0.1', resolve);
    });
    const address = httpServer.address() as AddressInfo;
    httpBaseURL = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
    httpServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
        httpServer.close((error) =>
            error == null ? resolve() : reject(error),
        );
    });
});

describe('Ferret WASM v2', () => {
    it('reports exact versions and executes JSON-compatible results', async () => {
        const engine = await create();
        try {
            expect(engine.version).toEqual({
                self: '2.0.0-alpha.2',
                ferret: '2.0.0-alpha.39',
            });
            await expect(
                engine.run('RETURN { value: [1, 2, 3], ok: TRUE }'),
            ).resolves.toEqual({ value: [1, 2, 3], ok: true });
        } finally {
            await engine.close();
        }
    });

    it('compiles plans, exposes params, and reuses explicit sessions', async () => {
        const engine = await create();
        expect(engine.closed).toBe(false);

        const planPromise = engine.compile('RETURN @factor * 2');
        expect(planPromise).toBeInstanceOf(Promise);
        const plan = await planPromise;
        expect(plan.closed).toBe(false);
        expect(plan.params).toEqual(['factor']);

        await expect(plan.run({ params: { factor: 3 } })).resolves.toBe(6);

        const sessionPromise = plan.createSession({
            params: { factor: 4 },
        });
        expect(sessionPromise).toBeInstanceOf(Promise);
        const session = await sessionPromise;
        expect(session.closed).toBe(false);
        await expect(session.run()).resolves.toBe(8);
        await expect(session.run()).resolves.toBe(8);

        await session.close();
        expect(session.closed).toBe(true);
        await plan.close();
        expect(plan.closed).toBe(true);
        await engine.close();
        expect(engine.closed).toBe(true);
        await engine.close();
        await expect(session.run()).rejects.toThrow('Session is closed');
    });

    it('binds canonical synchronous and asynchronous host functions', async () => {
        const engine = await create({
            functions: {
                echo: (value: unknown) => value,
                async_value: async () => ({
                    nested: ['ok', new Uint8Array([1, 2, 3])],
                }),
                'custom::value': () => 'namespaced',
                fail: async () => {
                    throw new Error('host failure');
                },
            },
        });
        try {
            await expect(
                engine.run("RETURN ECHO({ value: ['a', 2] })"),
            ).resolves.toEqual({ value: ['a', 2] });
            await expect(engine.run('RETURN ASYNC_VALUE()')).resolves.toEqual({
                nested: ['ok', 'AQID'],
            });
            await expect(engine.run('RETURN CUSTOM::VALUE()')).resolves.toBe(
                'namespaced',
            );
            await expect(engine.run('RETURN FAIL()')).rejects.toThrow(
                'host failure',
            );
        } finally {
            await engine.close();
        }
    });

    it('rejects duplicate canonical function names', async () => {
        await expect(
            create({
                functions: {
                    test: () => 1,
                    TEST: () => 2,
                },
            }),
        ).rejects.toThrow('duplicate function name');
    });

    it('rejects invalid HTTP options', async () => {
        await expect(create({ http: [] } as never)).rejects.toThrow(
            'http must be a plain JavaScript object',
        );
        await expect(
            create({ http: { allowLocalhost: 'yes' } } as never),
        ).rejects.toThrow('http.allowLocalhost must be a boolean');
    });

    it('denies localhost HTTP by default without dispatching it', async () => {
        const engine = await create();
        const requestsBefore = valueRequests;
        try {
            await expect(
                engine.run(`RETURN IO::NET::HTTP::GET('${httpBaseURL}/value')`),
            ).rejects.toThrow('localhost is not allowed');
            expect(valueRequests).toBe(requestsBefore);
        } finally {
            await engine.close();
        }
    });

    it('performs localhost HTTP and policy-checked redirects when enabled', async () => {
        const engine = await create({ http: { allowLocalhost: true } });
        try {
            await expect(
                engine.run(`RETURN IO::NET::HTTP::GET('${httpBaseURL}/value')`),
            ).resolves.toBe('bm9kZQ==');
            await expect(
                engine.run(
                    `RETURN IO::NET::HTTP::GET('${httpBaseURL}/redirect')`,
                ),
            ).resolves.toBe('bm9kZQ==');
            await expect(
                engine.run(
                    `RETURN IO::NET::HTTP::GET('${httpBaseURL}/blocked-redirect')`,
                ),
            ).rejects.toThrow('not allowed');
        } finally {
            await engine.close();
        }
    });

    it('aborts Node HTTP and bounds materialized responses', async () => {
        const engine = await create({ http: { allowLocalhost: true } });
        try {
            const controller = new AbortController();
            const pending = engine.run(
                `RETURN IO::NET::HTTP::GET('${httpBaseURL}/slow')`,
                { signal: controller.signal },
            );
            controller.abort();
            await expect(pending).rejects.toMatchObject({
                name: 'AbortError',
            });

            await expect(
                engine.run(
                    `RETURN IO::NET::HTTP::GET('${httpBaseURL}/oversized')`,
                ),
            ).rejects.toThrow('response body exceeds limit');
        } finally {
            await engine.close();
        }
    });

    it('cancels a run and rejects concurrent session reuse and close', async () => {
        const engine = await create({
            functions: {
                slow: () =>
                    new Promise((resolve) =>
                        setTimeout(() => resolve('done'), 50),
                    ),
            },
        });
        const plan = await engine.compile('RETURN SLOW()');
        const session = await plan.createSession();
        const controller = new AbortController();
        const running = session.run({ signal: controller.signal });

        await expect(session.run()).rejects.toThrow('already running');
        await expect(session.close()).rejects.toThrow('running session');
        await expect(engine.close()).rejects.toThrow('running session');

        controller.abort();
        await expect(running).rejects.toMatchObject({ name: 'AbortError' });
        await session.close();
        await plan.close();
        await engine.close();
    });

    it('isolates concurrently created engines', async () => {
        const [first, second] = await Promise.all([
            create({ functions: { VALUE: () => 'first' } }),
            create({ functions: { VALUE: () => 'second' } }),
        ]);
        try {
            await expect(first.run('RETURN VALUE()')).resolves.toBe('first');
            await expect(second.run('RETURN VALUE()')).resolves.toBe('second');
        } finally {
            await Promise.all([first.close(), second.close()]);
        }
    });

    it('rejects invalid host values and runtime errors', async () => {
        const engine = await create();
        try {
            const cyclic: Record<string, unknown> = {};
            cyclic.self = cyclic;
            await expect(
                engine.run('RETURN @value', {
                    params: { value: cyclic },
                }),
            ).rejects.toThrow('cyclic JavaScript value');
            await expect(engine.run('RETURN MISSING()')).rejects.toThrow(
                'unresolved function',
            );
        } finally {
            await engine.close();
        }
    });

    it('cascades close through idle plans and sessions', async () => {
        const engine = await create();
        const plan = await engine.compile('RETURN TRUE');
        const session = await plan.createSession();

        await engine.close();

        expect(engine.closed).toBe(true);
        expect(plan.closed).toBe(true);
        expect(session.closed).toBe(true);
        await expect(session.run()).rejects.toThrow('Session is closed');
        await expect(plan.run()).rejects.toThrow('Plan is closed');
        await expect(engine.compile('RETURN TRUE')).rejects.toThrow(
            'Engine is closed',
        );
    });

    it('loads through the CommonJS export', async () => {
        const require = createRequire(import.meta.url);
        const commonjs = require('../dist/index.node.cjs') as {
            create: typeof create;
        };
        const engine = await commonjs.create();
        try {
            await expect(engine.run('RETURN 42')).resolves.toBe(42);
        } finally {
            await engine.close();
        }
    });

    it('loads a custom Uint8Array WASM source', async () => {
        const bytes = await readFile(
            new URL('../dist/ferret.wasm', import.meta.url),
        );
        const engine = await create({
            wasm: new Uint8Array(bytes),
        });
        try {
            await expect(engine.run('RETURN 21 * 2')).resolves.toBe(42);
        } finally {
            await engine.close();
        }
    });

    it('surfaces source-aware compile errors', async () => {
        const engine = await create();
        try {
            await expect(
                engine.compile({ name: 'broken.fql', text: 'RETURN (' }),
            ).rejects.toThrow(/compile query/i);
        } finally {
            await engine.close();
        }
    });

    it('rejects cancelled resource creation and invalid session params', async () => {
        const engine = await create();

        try {
            const compileController = new AbortController();
            compileController.abort();
            await expect(
                engine.compile('RETURN TRUE', {
                    signal: compileController.signal,
                }),
            ).rejects.toMatchObject({ name: 'AbortError' });

            const plan = await engine.compile('RETURN @value');
            try {
                const sessionController = new AbortController();
                sessionController.abort();
                await expect(
                    plan.createSession({
                        signal: sessionController.signal,
                    }),
                ).rejects.toMatchObject({ name: 'AbortError' });

                const cyclic: Record<string, unknown> = {};
                cyclic.self = cyclic;
                await expect(
                    plan.createSession({
                        params: { value: cyclic },
                    }),
                ).rejects.toThrow('cyclic JavaScript value');
            } finally {
                await plan.close();
            }
        } finally {
            await engine.close();
        }
    });

    it('rejects close without partial cleanup while creation is pending', async () => {
        const engine = await create();
        const planPromise = engine.compile('RETURN TRUE');

        await expect(engine.close()).rejects.toThrow('compiling a plan');

        const plan = await planPromise;
        const idlePlan = await engine.compile('RETURN 1');
        const sessionPromise = plan.createSession();
        const planClose = plan.close();
        const engineClose = engine.close();

        await expect(planClose).rejects.toThrow('creating a session');
        await expect(engineClose).rejects.toThrow('creating a session');
        expect(plan.closed).toBe(false);
        expect(idlePlan.closed).toBe(false);

        const session = await sessionPromise;
        await session.close();
        await engine.close();

        expect(plan.closed).toBe(true);
        expect(idlePlan.closed).toBe(true);
        expect(engine.closed).toBe(true);
    });
});
