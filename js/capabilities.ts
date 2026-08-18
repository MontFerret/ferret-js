import type { MaybePromise } from './types';

declare const keyReadableSymbol: unique symbol;
declare const keyWritableSymbol: unique symbol;
declare const keyRemovableSymbol: unique symbol;
declare const indexReadableSymbol: unique symbol;
declare const indexWritableSymbol: unique symbol;
declare const indexRemovableSymbol: unique symbol;
declare const indexInsertableSymbol: unique symbol;
declare const appendableSymbol: unique symbol;
declare const swappableSymbol: unique symbol;
declare const valueRemovableSymbol: unique symbol;
declare const clearableSymbol: unique symbol;
declare const measurableSymbol: unique symbol;
declare const containableSymbol: unique symbol;
declare const spawnableSymbol: unique symbol;
declare const cloneableSymbol: unique symbol;
declare const hashableSymbol: unique symbol;
declare const equatableSymbol: unique symbol;
declare const comparableSymbol: unique symbol;
declare const sortableSymbol: unique symbol;
declare const dispatchableSymbol: unique symbol;
declare const observableSymbol: unique symbol;
declare const queryableSymbol: unique symbol;
declare const serializableSymbol: unique symbol;

export interface CapabilitySymbols {
    readonly keyReadable: typeof keyReadableSymbol;
    readonly keyWritable: typeof keyWritableSymbol;
    readonly keyRemovable: typeof keyRemovableSymbol;
    readonly indexReadable: typeof indexReadableSymbol;
    readonly indexWritable: typeof indexWritableSymbol;
    readonly indexRemovable: typeof indexRemovableSymbol;
    readonly indexInsertable: typeof indexInsertableSymbol;
    readonly appendable: typeof appendableSymbol;
    readonly swappable: typeof swappableSymbol;
    readonly valueRemovable: typeof valueRemovableSymbol;
    readonly clearable: typeof clearableSymbol;
    readonly measurable: typeof measurableSymbol;
    readonly containable: typeof containableSymbol;
    readonly spawnable: typeof spawnableSymbol;
    readonly cloneable: typeof cloneableSymbol;
    readonly hashable: typeof hashableSymbol;
    readonly equatable: typeof equatableSymbol;
    readonly comparable: typeof comparableSymbol;
    readonly sortable: typeof sortableSymbol;
    readonly dispatchable: typeof dispatchableSymbol;
    readonly observable: typeof observableSymbol;
    readonly queryable: typeof queryableSymbol;
    readonly serializable: typeof serializableSymbol;
}

const capability = (name: keyof CapabilitySymbols): symbol =>
    Symbol.for(`ferret.capability.${name}`);

export const capabilities = Object.freeze({
    keyReadable: capability('keyReadable'),
    keyWritable: capability('keyWritable'),
    keyRemovable: capability('keyRemovable'),
    indexReadable: capability('indexReadable'),
    indexWritable: capability('indexWritable'),
    indexRemovable: capability('indexRemovable'),
    indexInsertable: capability('indexInsertable'),
    appendable: capability('appendable'),
    swappable: capability('swappable'),
    valueRemovable: capability('valueRemovable'),
    clearable: capability('clearable'),
    measurable: capability('measurable'),
    containable: capability('containable'),
    spawnable: capability('spawnable'),
    cloneable: capability('cloneable'),
    hashable: capability('hashable'),
    equatable: capability('equatable'),
    comparable: capability('comparable'),
    sortable: capability('sortable'),
    dispatchable: capability('dispatchable'),
    observable: capability('observable'),
    queryable: capability('queryable'),
    serializable: capability('serializable'),
}) as CapabilitySymbols;

export interface KeyReadable {
    [capabilities.keyReadable](key: unknown): MaybePromise<unknown>;
}

export interface KeyWritable {
    [capabilities.keyWritable](
        key: unknown,
        value: unknown,
    ): MaybePromise<void>;
}

export interface KeyRemovable {
    [capabilities.keyRemovable](key: unknown): MaybePromise<void>;
}

export interface IndexReadable {
    [capabilities.indexReadable](index: number): MaybePromise<unknown>;
}

export interface IndexWritable {
    [capabilities.indexWritable](
        index: number,
        value: unknown,
    ): MaybePromise<void>;
}

export interface IndexRemovable {
    [capabilities.indexRemovable](index: number): MaybePromise<void>;
}

export interface IndexInsertable {
    [capabilities.indexInsertable](
        index: number,
        value: unknown,
    ): MaybePromise<void>;
}

export interface Appendable {
    [capabilities.appendable](value: unknown): MaybePromise<void>;
}

export interface Swappable {
    [capabilities.swappable](first: number, second: number): MaybePromise<void>;
}

export interface ValueRemovable {
    [capabilities.valueRemovable](value: unknown): MaybePromise<void>;
}

export interface Clearable {
    [capabilities.clearable](): MaybePromise<void>;
}

export interface Measurable {
    [capabilities.measurable](): MaybePromise<number>;
}

export interface Containable {
    [capabilities.containable](value: unknown): MaybePromise<boolean>;
}

export interface Spawnable {
    [capabilities.spawnable](): MaybePromise<unknown>;
}

export interface Cloneable {
    [capabilities.cloneable](): MaybePromise<unknown>;
}

export interface Hashable {
    [capabilities.hashable](): number;
}

export interface Equatable extends Hashable {
    [capabilities.equatable](other: unknown): MaybePromise<boolean>;
}

export interface Comparable {
    [capabilities.comparable](other: unknown): MaybePromise<number>;
}

export interface Sortable {
    [capabilities.sortable](direction: 'asc' | 'desc'): MaybePromise<void>;
}

export interface DispatchEvent {
    readonly name: string;
    readonly payload: unknown;
    readonly options: unknown;
}

export interface Dispatchable {
    [capabilities.dispatchable](event: DispatchEvent): MaybePromise<void>;
}

export interface Subscription {
    readonly eventName: string;
    readonly options: unknown;
}

export type ObservableResult = Iterable<unknown> | AsyncIterable<unknown>;

export interface Observable {
    [capabilities.observable](
        subscription: Subscription,
    ): MaybePromise<ObservableResult>;
}

export interface HostQuery {
    readonly kind: string;
    readonly expression: string;
    readonly params: unknown;
    readonly options: unknown;
}

export type QueryResult =
    readonly unknown[] | Iterable<unknown> | AsyncIterable<unknown>;

export interface Queryable {
    [capabilities.queryable](query: HostQuery): MaybePromise<QueryResult>;
}

export interface Serializable {
    [capabilities.serializable](): unknown;
}

export type FerretMap = KeyReadable &
    KeyWritable &
    KeyRemovable &
    Measurable &
    Spawnable &
    (
        | Iterable<readonly [unknown, unknown]>
        | AsyncIterable<readonly [unknown, unknown]>
    );

export type FerretList = IndexReadable &
    IndexWritable &
    IndexRemovable &
    IndexInsertable &
    Swappable &
    Appendable &
    Measurable &
    Spawnable &
    Sortable &
    (Iterable<unknown> | AsyncIterable<unknown>);

export type FerretCollection = (Iterable<unknown> | AsyncIterable<unknown>) &
    Measurable &
    Containable &
    Clearable &
    Cloneable;
