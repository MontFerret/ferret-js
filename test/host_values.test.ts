import { describe, expect, it } from 'vitest';

// @ts-ignore The generated declaration exists only after the build step.
import { capabilities, create } from '../dist/index.node.js';

class RemoteMap {
    readonly data: Map<unknown, unknown>;

    constructor(entries: Iterable<readonly [unknown, unknown]> = []) {
        this.data = new Map(entries);
    }

    async [capabilities.keyReadable](key: unknown): Promise<unknown> {
        await Promise.resolve();
        return this.data.has(key) ? this.data.get(key) : undefined;
    }

    [capabilities.keyWritable](key: unknown, value: unknown): void {
        this.data.set(key, value);
    }

    [capabilities.keyRemovable](key: unknown): void {
        this.data.delete(key);
    }

    [capabilities.measurable](): number {
        return this.data.size;
    }

    [capabilities.spawnable](): RemoteMap {
        return new RemoteMap();
    }

    [Symbol.iterator](): MapIterator<[unknown, unknown]> {
        return this.data.entries();
    }
}

class RemoteList {
    readonly values: unknown[];
    readonly directions: string[];

    constructor(values: unknown[] = [], directions: string[] = []) {
        this.values = values;
        this.directions = directions;
    }

    [capabilities.indexReadable](index: number): unknown {
        return this.values[index];
    }

    [capabilities.indexWritable](index: number, value: unknown): void {
        this.values[index] = value;
    }

    [capabilities.indexRemovable](index: number): void {
        this.values.splice(index, 1);
    }

    [capabilities.indexInsertable](index: number, value: unknown): void {
        this.values.splice(index, 0, value);
    }

    [capabilities.appendable](value: unknown): void {
        this.values.push(value);
    }

    [capabilities.swappable](first: number, second: number): void {
        [this.values[first], this.values[second]] = [
            this.values[second],
            this.values[first],
        ];
    }

    [capabilities.measurable](): number {
        return this.values.length;
    }

    [capabilities.spawnable](): RemoteList {
        return new RemoteList([], this.directions);
    }

    [capabilities.sortable](direction: 'asc' | 'desc'): void {
        this.directions.push(direction);
        this.values.sort((left, right) =>
            direction === 'asc'
                ? Number(left) - Number(right)
                : Number(right) - Number(left),
        );
    }

    [Symbol.iterator](): ArrayIterator<unknown> {
        return this.values.values();
    }
}

describe('JavaScript host values', () => {
    it('exports frozen global capability symbols', () => {
        expect(Object.isFrozen(capabilities)).toBe(true);
        expect(capabilities.keyReadable).toBe(
            Symbol.for('ferret.capability.keyReadable'),
        );
        expect(capabilities.serializable).toBe(
            Symbol.for('ferret.capability.serializable'),
        );
    });

    it('preserves built-in conversion and ignores unrelated symbols', async () => {
        const unrelated = Symbol('unrelated');
        const value = { answer: 42, [unrelated]: () => 'ignored' };
        const array = [1, 2, 3];
        array[Symbol.iterator] = () => [99].values();

        const engine = await create();
        try {
            await expect(
                engine.run('RETURN [@value.answer, @array]', {
                    params: { value, array },
                }),
            ).resolves.toEqual([42, [1, 2, 3]]);
        } finally {
            await engine.close();
        }
    });

    it('supports inherited async reads, missing values, NONE, and nested hosts', async () => {
        const receivers: unknown[] = [];
        class Readable {
            readonly data = new Map<unknown, unknown>();

            async [capabilities.keyReadable](key: unknown): Promise<unknown> {
                receivers.push(this);
                await Promise.resolve();
                return this.data.has(key) ? this.data.get(key) : undefined;
            }
        }

        const child = new Readable();
        child.data.set('answer', 42);
        const readable = new Readable();
        readable.data.set('none', null);
        readable.data.set('child', child);

        const engine = await create();
        try {
            await expect(
                engine.run(
                    'RETURN [@value.missing, @value.none, @value.child.answer]',
                    { params: { value: readable } },
                ),
            ).resolves.toEqual([null, null, 42]);
            expect(receivers).toEqual([readable, readable, readable, child]);
        } finally {
            await engine.close();
        }
    });

    it('snapshots protocols per crossing and keeps composite identity stable', async () => {
        const value = new RemoteMap([['answer', 1]]);
        const other = new RemoteMap([['answer', 1]]);
        const engine = await create();
        const plan = await engine.compile(
            'RETURN [@first.answer, @first == @same, @first == @other]',
        );
        const session = await plan.createSession({
            params: { first: value, same: value, other },
        });

        const original = value[capabilities.keyReadable];
        value[capabilities.keyReadable] = async () => 99;

        try {
            await expect(session.run()).resolves.toEqual([1, true, false]);
            await expect(
                plan.run({ params: { first: value, same: value, other } }),
            ).resolves.toEqual([99, true, false]);
        } finally {
            value[capabilities.keyReadable] = original;
            await session.close();
            await plan.close();
            await engine.close();
        }
    });

    it('uses explicit equality, hashing, and normalized comparison', async () => {
        class RankedValue {
            constructor(readonly rank: number) {}

            [capabilities.hashable](): number {
                return this.rank;
            }

            [capabilities.equatable](other: unknown): boolean {
                return other instanceof RankedValue && other.rank === this.rank;
            }

            [capabilities.comparable](other: unknown): number {
                if (!(other instanceof RankedValue)) return Number.NaN;
                return (this.rank - other.rank) * 100;
            }
        }

        const engine = await create();
        try {
            await expect(
                engine.run(
                    'RETURN [@first == @sameRank, @first == @higher, @first < @higher, @higher > @first]',
                    {
                        params: {
                            first: new RankedValue(1),
                            sameRank: new RankedValue(1),
                            higher: new RankedValue(2),
                        },
                    },
                ),
            ).resolves.toEqual([true, false, true, true]);
        } finally {
            await engine.close();
        }
    });

    it('derives canonical Map behavior and recursively serializes host results', async () => {
        const value = new RemoteMap([
            ['a', 1],
            ['b', 2],
        ]);
        const engine = await create();
        try {
            await expect(
                engine.run(
                    `LET value = @value
                     value.c = 3
                     DELETE value.b
                     RETURN {
                       value,
                       length: LENGTH(value),
                       keys: SORTED(KEYS(value)),
                       values: SORTED(VALUES(value)),
                       iterated: (FOR item IN value SORT item RETURN item)
                     }`,
                    { params: { value } },
                ),
            ).resolves.toEqual({
                value: { a: 1, c: 3 },
                length: 2,
                keys: ['a', 'c'],
                values: [1, 3],
                iterated: [1, 3],
            });
        } finally {
            await engine.close();
        }
    });

    it('derives List behavior and routes sorting through one symbol', async () => {
        const directions: string[] = [];
        const value = new RemoteList([3, 1, 2], directions);
        const engine = await create();
        try {
            await expect(
                engine.run(
                    `RETURN {
                       original: @value,
                       sorted: SORTED(@value),
                       length: LENGTH(@value),
                       contains: 2 IN @value,
                       iterated: (FOR item IN @value RETURN item)
                     }`,
                    { params: { value } },
                ),
            ).resolves.toEqual({
                original: [3, 1, 2],
                sorted: [1, 2, 3],
                length: 3,
                contains: true,
                iterated: [3, 1, 2],
            });
            expect(directions).toEqual(['asc']);
        } finally {
            await engine.close();
        }
    });

    it('prefers async iteration and closes iterators after early termination', async () => {
        let syncUsed = false;
        let returned = false;
        class BothIterable {
            [Symbol.iterator]() {
                syncUsed = true;
                return [9][Symbol.iterator]();
            }

            [Symbol.asyncIterator]() {
                let index = 0;
                return {
                    async next() {
                        return { value: ++index, done: false };
                    },
                    async return() {
                        returned = true;
                        return { done: true };
                    },
                };
            }
        }
        const value = new BothIterable();

        const engine = await create();
        try {
            await expect(
                engine.run('RETURN FOR item IN @value LIMIT 1 RETURN item', {
                    params: { value },
                }),
            ).resolves.toEqual([1]);
            expect(syncUsed).toBe(false);
            expect(returned).toBe(true);
        } finally {
            await engine.close();
        }
    });

    it('closes a pending async iterator when execution is cancelled', async () => {
        let returned = false;
        let started!: () => void;
        const pending = new Promise<void>((resolve) => {
            started = resolve;
        });
        let finishNext!: (value: IteratorResult<number>) => void;
        class PendingIterable {
            [Symbol.asyncIterator]() {
                return {
                    next() {
                        started();
                        return new Promise<IteratorResult<number>>(
                            (resolve) => {
                                finishNext = resolve;
                            },
                        );
                    },
                    return() {
                        returned = true;
                        finishNext({ value: undefined, done: true });
                        return { value: undefined, done: true };
                    },
                };
            }
        }
        const value = new PendingIterable();

        const engine = await create();
        try {
            const controller = new AbortController();
            const running = engine.run(
                'RETURN FOR item IN @value RETURN item',
                {
                    params: { value },
                    signal: controller.signal,
                },
            );
            const cancellation = expect(running).rejects.toMatchObject({
                name: 'AbortError',
            });

            await pending;
            controller.abort();

            await new Promise((resolve) => setTimeout(resolve, 100));
            const returnedPromptly = returned;
            if (!returnedPromptly) {
                finishNext({ value: undefined, done: true });
            }

            await cancellation;
            expect(returnedPromptly).toBe(true);
        } finally {
            await engine.close();
        }
    });

    it('uses serializable for opaque output and rejects recursive output', async () => {
        const serializable = {
            [capabilities.keyReadable](key: unknown) {
                return key === 'answer' ? 42 : undefined;
            },
            [capabilities.serializable]() {
                return { answer: 42, nested: [true, null] };
            },
        };
        const recursive = {
            [capabilities.keyReadable]() {
                return undefined;
            },
            [capabilities.serializable](): unknown {
                return recursive;
            },
        };
        const opaque = {
            [capabilities.keyReadable]() {
                return 1;
            },
        };

        const engine = await create();
        try {
            await expect(
                engine.run('RETURN @value', {
                    params: { value: serializable },
                }),
            ).resolves.toEqual({ answer: 42, nested: [true, null] });
            await expect(
                engine.run('RETURN @value', { params: { value: opaque } }),
            ).rejects.toThrow('host value is not serializable');
            await expect(
                engine.run('RETURN @value', {
                    params: { value: recursive },
                }),
            ).rejects.toThrow('serializable returned its host value');
        } finally {
            await engine.close();
        }
    });

    it('preserves host targets through shorthand and module functions', async () => {
        const value = new RemoteMap([['answer', 42]]);
        const seen: unknown[] = [];
        const nested: unknown[] = [];
        const echo = (input: unknown) => {
            seen.push(input);
            return input;
        };
        const engine = await create({
            functions: {
                shorthand_echo: echo,
                nested_echo: (input: unknown) => {
                    const value = input as { values: unknown[] };
                    nested.push(value.values[0]);
                    return input;
                },
            },
            modules: [
                {
                    name: 'host-values',
                    namespace: 'HOST',
                    functions: { module_echo: echo },
                },
            ],
        });
        try {
            await expect(
                engine.run(
                    `RETURN [
                       SHORTHAND_ECHO(@value).answer,
                       HOST::MODULE_ECHO(@value).answer,
                       NESTED_ECHO({ values: [@value] }).values[0].answer
                     ]`,
                    { params: { value } },
                ),
            ).resolves.toEqual([42, 42, 42]);
            expect(seen).toEqual([value, value]);
            expect(nested).toEqual([value]);
        } finally {
            await engine.close();
        }
    });

    it('propagates protocol throws and rejections and isolates capabilities', async () => {
        const throwing = {
            [capabilities.keyReadable]() {
                throw new Error('read threw');
            },
        };
        const rejecting = {
            async [capabilities.keyReadable]() {
                throw new Error('read rejected');
            },
        };
        const readableOnly = {
            [capabilities.keyReadable]() {
                return 1;
            },
        };
        const engine = await create();
        try {
            await expect(
                engine.run('RETURN @value.x', {
                    params: { value: throwing },
                }),
            ).rejects.toThrow('read threw');
            await expect(
                engine.run('RETURN @value.x', {
                    params: { value: rejecting },
                }),
            ).rejects.toThrow('read rejected');
            await expect(
                engine.run('RETURN LENGTH(@value)', {
                    params: { value: readableOnly },
                }),
            ).rejects.toThrow('invalid type');
        } finally {
            await engine.close();
        }
    });

    it('validates recognized methods and synchronous protocol results', async () => {
        const engine = await create();
        try {
            await expect(
                engine.run('RETURN @value', {
                    params: {
                        value: { [capabilities.keyReadable]: 1 },
                    },
                }),
            ).rejects.toThrow('keyReadable] must be callable');
            await expect(
                engine.run('RETURN @value', {
                    params: {
                        value: {
                            [capabilities.equatable]: () => true,
                        },
                    },
                }),
            ).rejects.toThrow('equatable requires hashable');
            await expect(
                engine.run('RETURN @value', {
                    params: {
                        value: {
                            [capabilities.hashable]: () => -1,
                        },
                    },
                }),
            ).rejects.toThrow('non-negative safe integer');
            await expect(
                engine.run('RETURN @value', {
                    params: {
                        value: {
                            [capabilities.serializable]: async () => ({
                                ok: true,
                            }),
                        },
                    },
                }),
            ).rejects.toThrow('must return synchronously');
        } finally {
            await engine.close();
        }
    });

    it('rejects malformed Map entries and closes the iterator', async () => {
        let returned = false;
        class MalformedMap extends RemoteMap {
            override [Symbol.iterator](): MapIterator<[unknown, unknown]> {
                let yielded = false;
                return {
                    next() {
                        if (yielded) return { done: true, value: undefined };
                        yielded = true;
                        return { done: false, value: ['missing-value'] };
                    },
                    return() {
                        returned = true;
                        return { done: true, value: undefined };
                    },
                } as unknown as MapIterator<[unknown, unknown]>;
            }
        }

        const engine = await create();
        try {
            await expect(
                engine.run('RETURN @value', {
                    params: { value: new MalformedMap() },
                }),
            ).rejects.toThrow('must yield [key, value]');
            expect(returned).toBe(true);
        } finally {
            await engine.close();
        }
    });

    it('adapts query, dispatch, and observable protocols', async () => {
        const queries: unknown[] = [];
        const events: unknown[] = [];
        const subscriptions: unknown[] = [];
        const value = {
            [capabilities.queryable](query: unknown) {
                queries.push(query);
                return ['first', 'second'];
            },
            [capabilities.dispatchable](event: unknown) {
                events.push(event);
            },
        };
        const observable = {
            [capabilities.observable](subscription: unknown) {
                subscriptions.push(subscription);
                return (async function* () {
                    yield { type: 'ready' };
                })();
            },
        };

        const engine = await create();
        try {
            await expect(
                engine.run('RETURN QUERY ONE ".item" IN @value USING css', {
                    params: { value },
                }),
            ).resolves.toBe('first');
            await expect(
                engine.run(
                    'RETURN DISPATCH "click" IN @value WITH { id: 1 } OPTIONS { bubbles: true }',
                    { params: { value } },
                ),
            ).resolves.toBeNull();
            await expect(
                engine.run(
                    'LET source = @obs RETURN WAITFOR EVENT "ready" IN source',
                    { params: { obs: observable } },
                ),
            ).resolves.toEqual({ type: 'ready' });
            expect(subscriptions).toHaveLength(1);
            expect(queries).toHaveLength(1);
            expect(events).toEqual([
                {
                    name: 'click',
                    payload: { id: 1 },
                    options: { bubbles: true },
                },
            ]);
            expect(subscriptions).toEqual([
                { eventName: 'ready', options: null },
            ]);
        } finally {
            await engine.close();
        }
    });

    it('does not leave callbacks unhandled across repeated engine teardown', async () => {
        const unhandled: unknown[] = [];
        const listener = (reason: unknown) => unhandled.push(reason);
        process.on('unhandledRejection', listener);

        try {
            for (let index = 0; index < 8; index++) {
                const engine = await create();
                await engine.run('RETURN @value.answer', {
                    params: {
                        value: {
                            async [capabilities.keyReadable](key: unknown) {
                                await Promise.resolve();
                                return key === 'answer' ? index : undefined;
                            },
                        },
                    },
                });
                await engine.close();
            }

            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(unhandled).toEqual([]);
        } finally {
            process.off('unhandledRejection', listener);
        }
    });
});
