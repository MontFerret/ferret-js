import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const versionsScript = resolve(repositoryRoot, 'scripts/versions.sh');

const readVersion = (target: 'package' | 'ferret'): string =>
    execFileSync('sh', [versionsScript, target], {
        cwd: repositoryRoot,
        encoding: 'utf8',
    }).trim();

export const expectedVersions = {
    self: readVersion('package'),
    ferret: readVersion('ferret'),
};
