import { expect, test } from '@playwright/test';

test('loads the browser package and executes Ferret', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(async () => {
        const modulePath = '/dist/index.js';
        const { create } = await import(modulePath);
        const engine = await create({
            http: { allowLocalhost: true },
        });
        try {
            const plan = await engine.compile('RETURN @value * 2');
            const session = await plan.createSession({
                params: { value: 21 },
            });

            return {
                version: engine.version,
                session: await session.run(),
                value: await engine.run(
                    'RETURN (FOR value IN 1..3 RETURN value * @factor)',
                    { params: { factor: 2 } },
                ),
                http: await engine.run(
                    `RETURN IO::NET::HTTP::GET('${location.origin}/api/value')`,
                ),
            };
        } finally {
            await engine.close();
        }
    });

    expect(result.version).toEqual({
        self: '2.0.0-alpha.7',
        ferret: '2.0.0-alpha.52',
    });
    expect(result.session).toBe(42);
    expect(result.value).toEqual([2, 4, 6]);
    expect(result.http).toBe('YnJvd3Nlcg==');
});

test('blocks localhost HTTP by default', async ({ page }) => {
    await page.goto('/');
    const message = await page.evaluate(async () => {
        const modulePath = '/dist/index.js';
        const { create } = await import(modulePath);
        const engine = await create();
        try {
            await engine.run(
                `RETURN IO::NET::HTTP::GET('${location.origin}/api/value')`,
            );
            return '';
        } catch (error) {
            return (error as Error).message;
        } finally {
            await engine.close();
        }
    });

    expect(message).toContain('localhost is not allowed');
});

test('rejects browser cross-origin HTTP and redirects', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(async () => {
        const modulePath = '/dist/index.js';
        const { create } = await import(modulePath);
        const engine = await create({
            http: { allowLocalhost: true },
        });

        const failure = async (query: string): Promise<string> => {
            try {
                await engine.run(query);
                return '';
            } catch (error) {
                return (error as Error).message;
            }
        };

        try {
            return {
                crossOrigin: await failure(
                    `RETURN IO::NET::HTTP::GET('http://localhost:4173/api/value')`,
                ),
                redirect: await failure(
                    `RETURN IO::NET::HTTP::GET('${location.origin}/api/redirect')`,
                ),
            };
        } finally {
            await engine.close();
        }
    });

    expect(result.crossOrigin).toContain(
        'browser HTTP requests must be same-origin',
    );
    expect(result.redirect).not.toBe('');
});

test('aborts browser HTTP requests', async ({ page }) => {
    await page.goto('/');
    const cancellation = await page.evaluate(async () => {
        const modulePath = '/dist/index.js';
        const { create } = await import(modulePath);
        const engine = await create({
            http: { allowLocalhost: true },
        });
        try {
            const controller = new AbortController();
            const pending = engine.run(
                `RETURN IO::NET::HTTP::GET('${location.origin}/api/slow')`,
                { signal: controller.signal },
            );
            controller.abort();
            try {
                await pending;
                return '';
            } catch (error) {
                return (error as Error).name;
            }
        } finally {
            await engine.close();
        }
    });

    expect(cancellation).toBe('AbortError');
});

test('supports host functions and cancellation in a browser', async ({
    page,
}) => {
    await page.goto('/');
    const result = await page.evaluate(async () => {
        const modulePath = '/dist/index.js';
        const { create } = await import(modulePath);
        const wasmBuffer: ArrayBuffer = await fetch('/dist/ferret.wasm').then(
            (response) => response.arrayBuffer(),
        );
        const wasm = new Uint8Array(wasmBuffer);
        const engine = await create({
            wasm,
            functions: {
                value: (value: unknown) => ({ wrapped: value }),
                slow: () =>
                    new Promise((resolve) =>
                        setTimeout(() => resolve('late'), 100),
                    ),
            },
        });
        try {
            const value = await engine.run("RETURN VALUE('ok')");
            const controller = new AbortController();
            const pending = engine.run('RETURN SLOW()', {
                signal: controller.signal,
            });
            controller.abort();
            let cancellation = '';
            try {
                await pending;
            } catch (error) {
                cancellation = (error as Error).name;
            }
            return { value, cancellation };
        } finally {
            await engine.close();
        }
    });

    expect(result).toEqual({
        value: { wrapped: 'ok' },
        cancellation: 'AbortError',
    });
});

test('supports JavaScript modules and async lifecycle hooks', async ({
    page,
}) => {
    await page.goto('/');
    const result = await page.evaluate(async () => {
        const modulePath = '/dist/index.js';
        const { create, defineModule } = await import(modulePath);
        const events: string[] = [];
        const engine = await create({
            modules: [
                defineModule({
                    name: 'browser-module',
                    namespace: 'BROWSER::MODULE',
                    functions: {
                        browser_value: () => 'browser-module',
                    },
                    lifecycle: {
                        async onInit() {
                            await Promise.resolve();
                            events.push('init');
                        },
                        async beforeRun() {
                            await Promise.resolve();
                            events.push('beforeRun');
                        },
                        async afterRun() {
                            await Promise.resolve();
                            events.push('afterRun');
                        },
                        async onClose() {
                            await Promise.resolve();
                            events.push('close');
                        },
                    },
                }),
            ],
        });

        const value = await engine.run(
            'RETURN BROWSER::MODULE::BROWSER_VALUE()',
        );
        await engine.close();

        return { value, events };
    });

    expect(result).toEqual({
        value: 'browser-module',
        events: ['init', 'beforeRun', 'afterRun', 'close'],
    });
});
