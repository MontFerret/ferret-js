import assert from 'node:assert/strict';

import { capabilities, create } from '../dist/index.node.js';

assert.equal(typeof globalThis.gc, 'function', 'run Node with --expose-gc');

const engine = await create();
const pressurePlan = await engine.compile(
    'RETURN (FOR value IN 1..4096 RETURN value * 2)',
);
const pressureSession = await pressurePlan.createSession();

async function crossHostTarget(value) {
    const reference = new WeakRef(value);
    await engine.run('RETURN @value.answer', { params: { value } });
    return reference;
}

const references = [];
try {
    for (let index = 0; index < 3; index++) {
        references.push(
            await crossHostTarget({
                [capabilities.keyReadable](key) {
                    return key === 'answer' ? index : undefined;
                },
            }),
        );
    }

    let collected = false;
    for (let attempt = 0; attempt < 100; attempt++) {
        // WeakRef targets remain alive through the JavaScript job in which
        // deref() is called. Start a fresh task before forcing each collection.
        await new Promise((resolve) => setTimeout(resolve, 0));
        globalThis.gc();
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (references.every((reference) => reference.deref() === undefined)) {
            collected = true;
            break;
        }

        await pressureSession.run();
    }

    assert.equal(
        collected,
        true,
        'the engine identity registry kept JavaScript host targets alive',
    );
} finally {
    await pressureSession.close();
    await pressurePlan.close();
    await engine.close();
}
