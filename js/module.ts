import type {
    ModuleDefinition,
    ModuleLifecycle,
    RuntimeFunction,
} from './types';

const lifecycleNames = [
    'onInit',
    'onClose',
    'beforeCompile',
    'afterCompile',
    'onPlanClose',
    'beforeRun',
    'afterRun',
    'onSessionClose',
] as const satisfies readonly (keyof ModuleLifecycle)[];

const lifecycleNameSet = new Set<string>(lifecycleNames);

export function defineModule<const T extends ModuleDefinition>(
    definition: T,
): T {
    validateModuleDefinition(definition);
    return definition;
}

/** @internal */
export function snapshotModules(
    modules: readonly ModuleDefinition[] | undefined,
): ModuleDefinition[] {
    if (modules === undefined) {
        return [];
    }

    if (!Array.isArray(modules)) {
        throw new TypeError('modules must be an array');
    }

    const names = new Set<string>();

    return modules.map((definition, index) => {
        validateModuleDefinition(definition, `modules[${index}]`);

        if (names.has(definition.name)) {
            throw new TypeError(`duplicate module name "${definition.name}"`);
        }

        names.add(definition.name);

        return {
            name: definition.name,
            ...(definition.functions === undefined
                ? {}
                : { functions: snapshotFunctions(definition.functions) }),
            ...(definition.lifecycle === undefined
                ? {}
                : { lifecycle: snapshotLifecycle(definition.lifecycle) }),
        };
    });
}

function validateModuleDefinition(
    definition: ModuleDefinition,
    path = 'module definition',
): void {
    if (!isPlainObject(definition)) {
        throw new TypeError(`${path} must be a plain JavaScript object`);
    }

    if (
        typeof definition.name !== 'string' ||
        definition.name.trim().length === 0
    ) {
        throw new TypeError(`${path}.name must be a non-empty string`);
    }

    if (
        definition.functions !== undefined &&
        !isPlainObject(definition.functions)
    ) {
        throw new TypeError(
            `${path}.functions must be a plain JavaScript object`,
        );
    }

    if (
        definition.lifecycle !== undefined &&
        !isPlainObject(definition.lifecycle)
    ) {
        throw new TypeError(
            `${path}.lifecycle must be a plain JavaScript object`,
        );
    }

    if (definition.functions !== undefined) {
        for (const [name, fn] of Object.entries(definition.functions)) {
            if (typeof fn !== 'function') {
                throw new TypeError(
                    `${path}.functions[${JSON.stringify(name)}] must be callable`,
                );
            }
        }
    }

    if (definition.lifecycle !== undefined) {
        for (const name of Object.keys(definition.lifecycle)) {
            if (!lifecycleNameSet.has(name)) {
                throw new TypeError(
                    `${path}.lifecycle.${name} is not a supported lifecycle callback`,
                );
            }

            const callback =
                definition.lifecycle[name as keyof ModuleLifecycle];
            if (typeof callback !== 'function') {
                throw new TypeError(
                    `${path}.lifecycle.${name} must be callable`,
                );
            }
        }
    }
}

function snapshotFunctions(
    functions: Readonly<Record<string, RuntimeFunction>>,
): Record<string, RuntimeFunction> {
    const snapshot = Object.create(null) as Record<string, RuntimeFunction>;

    for (const [name, fn] of Object.entries(functions)) {
        snapshot[name] = fn;
    }

    return snapshot;
}

function snapshotLifecycle(
    lifecycle: Readonly<ModuleLifecycle>,
): ModuleLifecycle {
    const snapshot = Object.create(null) as ModuleLifecycle;

    for (const name of lifecycleNames) {
        const callback = lifecycle[name];
        if (callback !== undefined) {
            Object.defineProperty(snapshot, name, {
                configurable: false,
                enumerable: true,
                writable: false,
                value: callback,
            });
        }
    }

    return snapshot;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }

    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
