import { describe, expect, it, vi } from 'vitest';
import { create, OutputError } from '../dist/index.node.js';
import { OutputImpl, readOutputJSON } from '../js/output';
import type { GoBridge, OutputCompletion } from '../js/bridge';
import type { Content, Metadata } from '../js/types';

const metadata: Metadata = {
    contentType: 'application/json',
    length: 2,
    lengthKnown: true,
};

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

// These representations are not all produced by the native eager JSON codec.
function fixture(completion: OutputCompletion, signal?: AbortSignal) {
    const release = vi.fn();
    const bridge = {
        collectOutput: vi.fn((_id, _signal, callback) => {
            callback({ ok: true, data: completion });
            return { ok: true };
        }),
        closeOutput: vi.fn((_id, callback) => {
            callback(
                completion.closeError == null
                    ? { ok: true }
                    : { ok: false, error: completion.closeError },
            );
            return { ok: true };
        }),
    } as unknown as GoBridge;
    const output = new OutputImpl(
        bridge,
        { id: 'fixture', metadata },
        signal,
        release,
    );
    return { output, bridge, release };
}

describe('native output handles', () => {
    it('collects detached bytes and immutable metadata', async () => {
        const engine = await create();
        const output = await engine.run('RETURN { value: "héllo" }');
        try {
            expect(output.closed).toBe(false);
            expect(Object.isFrozen(output.metadata)).toBe(true);
            expect(output.metadata.contentType).toBe('application/json');
            const content = await output.collect();
            expect(content).not.toBeNull();
            expect(content!.data).toBeInstanceOf(Uint8Array);
            expect(content!.data.byteLength).toBe(output.metadata.length);
            expect(content!.metadata).toEqual(output.metadata);
            expect(JSON.parse(new TextDecoder().decode(content!.data))).toEqual(
                { value: 'héllo' },
            );
            expect(output.closed).toBe(true);
            await engine.close();
            expect(JSON.parse(new TextDecoder().decode(content!.data))).toEqual(
                { value: 'héllo' },
            );
            await output.close();
            await expect(output.collect()).rejects.toMatchObject({
                code: 'OUTPUT_CLOSED',
            });
        } finally {
            await engine.close();
        }
    });

    it('detaches outputs from session and plan closure and guards session reuse', async () => {
        const engine = await create();
        try {
            const plan = await engine.compile('RETURN @value');
            const session = await plan.createSession({ params: { value: 42 } });
            const first = await session.run();
            await expect(session.run()).rejects.toThrow('must be settled');
            expect(await first.json()).toBe(42);
            const second = await session.run();
            await session.close();
            await plan.close();
            expect(await second.json()).toBe(42);
        } finally {
            await engine.close();
        }
    });

    it('defers runtime failures until consumption', async () => {
        const engine = await create({
            functions: {
                fail: () => {
                    throw new Error('execution failed');
                },
            },
        });
        try {
            const output = await engine.run('RETURN FAIL()');
            await expect(output.collect()).rejects.toMatchObject({
                name: 'OutputError',
                content: null,
                message: expect.stringContaining('execution failed'),
            });
            expect(output.closed).toBe(true);
            await output.close();
            await expect(engine.run('RETURN (')).rejects.toThrow(
                'compile query',
            );
        } finally {
            await engine.close();
        }
    });

    it('attaches available content to hook and temporary cleanup failures', async () => {
        const engine = await create({
            modules: [
                {
                    name: 'failure',
                    lifecycle: {
                        afterRun() {
                            throw new Error('after run failed');
                        },
                        onSessionClose() {
                            throw new Error('session cleanup failed');
                        },
                        onPlanClose() {
                            throw new Error('plan cleanup failed');
                        },
                    },
                },
            ],
        });
        try {
            const output = await engine.run('RETURN 42');
            try {
                await output.collect();
                expect.fail('collection should reject');
            } catch (error) {
                expect(error).toBeInstanceOf(OutputError);
                const failure = error as OutputError;
                expect(failure.message).toContain('after run failed');
                expect(failure.message).toContain('session cleanup failed');
                expect(failure.message).toContain('plan cleanup failed');
                expect(new TextDecoder().decode(failure.content!.data)).toBe(
                    '42',
                );
            }
            for (let attempt = 0; attempt < 2; attempt++) {
                await expect(output.close()).rejects.toThrow(
                    'session cleanup failed',
                );
            }
        } finally {
            await engine.close();
        }
    });

    it('awaits callbacks, rejects competitors and shutdown, and retains callback causes', async () => {
        const engine = await create();
        try {
            const output = await engine.run('RETURN 42');
            const entered = deferred(),
                release = deferred();
            const original = new Error('consumer failed');
            let retained!: Uint8Array;
            const consuming = output.consume(async (chunk, signal) => {
                retained = chunk;
                expect(signal.aborted).toBe(false);
                await expect(output.collect()).rejects.toMatchObject({
                    code: 'OUTPUT_IN_USE',
                });
                entered.resolve();
                await release.promise;
                throw original;
            });
            // Attach immediately because the callback deliberately rejects later.
            const rejection = expect(consuming).rejects.toMatchObject({
                cause: expect.objectContaining({
                    errors: expect.arrayContaining([original]),
                }),
                message: expect.stringContaining('consumer failed'),
            });
            await entered.promise;
            await expect(engine.close()).rejects.toThrow('active output');
            expect(engine.closed).toBe(false);
            release.resolve();
            await rejection;
            expect(new TextDecoder().decode(retained)).toBe('42');
            expect(output.closed).toBe(true);
            await output.close();
        } finally {
            await engine.close();
        }
    });

    it('cancels active consumption and waits for the callback when closed', async () => {
        const engine = await create();
        try {
            const output = await engine.run('RETURN 42');
            const entered = deferred(),
                release = deferred();
            let effective!: AbortSignal;
            const consuming = output.consume(async (_chunk, signal) => {
                effective = signal;
                entered.resolve();
                await release.promise;
            });
            const rejection = expect(consuming).rejects.toMatchObject({
                code: 'OUTPUT_CLOSED',
            });
            await entered.promise;
            let closed = false;
            const closing = output.close().then(() => {
                closed = true;
            });
            expect(effective.aborted).toBe(true);
            await Promise.resolve();
            expect(closed).toBe(false);
            await expect(engine.close()).rejects.toThrow('active output');
            release.resolve();
            await Promise.all([rejection, closing]);
            expect(output.closed).toBe(true);
        } finally {
            await engine.close();
        }
    });

    it('keeps rejected consumption unclaimed and bounds lifetime by the invocation signal', async () => {
        const engine = await create();
        try {
            const output = await engine.run('RETURN NONE');
            const canceled = new AbortController();
            canceled.abort();
            await expect(
                output.collect({ signal: canceled.signal }),
            ).rejects.toMatchObject({ name: 'AbortError' });
            await expect(output.consume(null as never)).rejects.toThrow(
                'consumer must be callable',
            );
            await expect(
                output.collect({ signal: {} as AbortSignal }),
            ).rejects.toThrow('AbortSignal');
            expect(output.closed).toBe(false);
            expect(await output.json()).toBeNull();
            const invocation = new AbortController();
            const expired = await engine.run('RETURN 42', {
                signal: invocation.signal,
            });
            invocation.abort();
            await expect(expired.json()).rejects.toMatchObject({
                name: 'AbortError',
            });
            expect(expired.closed).toBe(false);
            await expired.close();
        } finally {
            await engine.close();
        }
    });

    it('propagates consumption cancellation to async callbacks', async () => {
        const engine = await create();
        try {
            const output = await engine.run('RETURN 42');
            const entered = deferred(),
                release = deferred();
            const controller = new AbortController();
            let effective!: AbortSignal;
            const consuming = output.consume(
                async (_chunk, signal) => {
                    effective = signal;
                    entered.resolve();
                    await release.promise;
                },
                { signal: controller.signal },
            );
            const rejection = expect(consuming).rejects.toMatchObject({
                name: 'AbortError',
            });
            await entered.promise;
            controller.abort();
            expect(effective.aborted).toBe(true);
            expect(output.closed).toBe(false);
            release.resolve();
            await rejection;
            expect(output.closed).toBe(true);
        } finally {
            await engine.close();
        }
    });

    it('closes all idle outputs before shutting down the engine', async () => {
        const engine = await create();
        const first = await engine.run('RETURN 1');
        const second = await engine.run('RETURN 2');
        const plan = await engine.compile('RETURN 3');
        const session = await plan.createSession();
        const closing = engine.close();
        const refusedRun = session.run();
        const refusedCreation = plan.createSession();
        await Promise.all([
            expect(second.collect()).rejects.toMatchObject({
                code: 'OUTPUT_CLOSED',
            }),
            expect(refusedRun).rejects.toThrow('closing'),
            expect(refusedCreation).rejects.toThrow('closing'),
            closing,
        ]);
        expect(first.closed).toBe(true);
        expect(second.closed).toBe(true);
        expect(first.metadata.length).toBe(1);
        await expect(first.json()).rejects.toMatchObject({
            code: 'OUTPUT_CLOSED',
        });
        await second.close();
    });
});

describe('output representation and cleanup fixtures', () => {
    it('preserves absent and present empty content', async () => {
        const absent = fixture({ content: null });
        expect(await absent.output.json()).toBeUndefined();
        const empty: Content = {
            metadata: { ...metadata, length: 0 },
            data: new Uint8Array(),
        };
        const present = fixture({ content: empty });
        expect(await present.output.collect()).toEqual(empty);
        expect(present.release).toHaveBeenCalledOnce();
    });

    it('preserves partial content and repeated native cleanup errors', async () => {
        const content = { metadata, data: new Uint8Array([123]) };
        const { output, bridge } = fixture({
            content,
            error: { message: 'incomplete payload' },
            closeError: { message: 'cleanup failed' },
        });
        await expect(output.collect()).rejects.toMatchObject({
            content,
            message: expect.stringContaining('cleanup failed'),
        });
        for (let attempt = 0; attempt < 2; attempt++)
            await expect(output.close()).rejects.toThrow('cleanup failed');
        expect(bridge.closeOutput).not.toHaveBeenCalled();
    });

    it('runJSON closes an output rejected before consumption and preserves cleanup failure', async () => {
        const controller = new AbortController();
        controller.abort();
        const { output, bridge } = fixture(
            { content: null, closeError: { message: 'cleanup failed' } },
            controller.signal,
        );
        await expect(
            readOutputJSON(Promise.resolve(output)),
        ).rejects.toMatchObject({
            name: 'AbortError',
            cause: expect.objectContaining({
                errors: expect.arrayContaining([
                    expect.objectContaining({ name: 'AbortError' }),
                    expect.objectContaining({ message: 'cleanup failed' }),
                ]),
            }),
        });
        expect(output.closed).toBe(true);
        expect(bridge.collectOutput).not.toHaveBeenCalled();
        expect(bridge.closeOutput).toHaveBeenCalledOnce();
        await expect(output.close()).rejects.toThrow('cleanup failed');
    });

    it('finalizes malformed JSON and retains the encoded bytes', async () => {
        const content = { metadata, data: new Uint8Array([123]) };
        const { output } = fixture({ content });
        await expect(output.json()).rejects.toMatchObject({
            content,
            cause: expect.any(SyntaxError),
        });
        expect(output.closed).toBe(true);
        await output.close();
    });
});
