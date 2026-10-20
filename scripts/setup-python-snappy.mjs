// Creates out/venv with the pinned python-snappy and cramjam from
// test/interop-requirements.txt, for the interop tests and for regenerating
// fixtures. Needs Python 3. CI installs the same packages with setup-python.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const venv = join(root, 'out', 'venv');
export const venvPython = join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

export function setupPython() {
  if (!existsSync(venvPython)) {
    execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-m', 'venv', venv], { stdio: 'inherit' });
  }
  execFileSync(venvPython, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '-r', join(root, 'test', 'interop-requirements.txt')], {
    stdio: 'inherit',
  });
  return venvPython;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(setupPython());
}
