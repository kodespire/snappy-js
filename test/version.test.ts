// Guards for the parts of the build that are hand-maintained: the version
// constants and the two headers that stand in for snappy's CMake-generated ones.
// A snappy update that changes either template fails here, not silently.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import * as constants from '../src/version.js';

const root = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const [major, minor, patch] = /project\(Snappy VERSION (\d+)\.(\d+)\.(\d+)/.exec(read('deps/snappy/CMakeLists.txt'))!.slice(1);

describe('version and generated-header guards', () => {
  it('SNAPPY_VERSION matches deps/snappy/CMakeLists.txt', () => {
    expect(constants.SNAPPY_VERSION).toBe(`${major}.${minor}.${patch}`);
  });

  it('csrc/snappy-config/snappy-stubs-public.h is the upstream template with its substitutions made', () => {
    const expected = read('deps/snappy/snappy-stubs-public.h.in')
      .replaceAll('${HAVE_SYS_UIO_H_01}', '0')
      .replace('${PROJECT_VERSION_MAJOR}', major!)
      .replace('${PROJECT_VERSION_MINOR}', minor!)
      .replace('${PROJECT_VERSION_PATCH}', patch!);
    expect(expected).not.toContain('${');
    const ours = read('csrc/snappy-config/snappy-stubs-public.h');
    // Our preamble (comments only), then the template verbatim.
    expect(ours.endsWith(expected)).toBe(true);
    expect(ours.slice(0, ours.length - expected.length).split('\n').every((line) => line === '' || line.startsWith('//'))).toBe(true);
  });

  it('csrc/snappy-config/config.h defines exactly the knobs cmake/config.h.in declares', () => {
    const upstream = [...read('deps/snappy/cmake/config.h.in').matchAll(/^#cmakedefine01 (\w+)$/gm)].map((m) => m[1]);
    const ours = [...read('csrc/snappy-config/config.h').matchAll(/^#define ((?:HAVE|SNAPPY)_\w+)/gm)].map((m) => m[1]);
    expect(upstream.length).toBeGreaterThan(15);
    expect([...new Set(ours)].sort()).toEqual([...upstream].sort());
  });

  it('level constants and version match the compiled library (native addon)', () => {
    const require = createRequire(import.meta.url);
    const addon = require('node-gyp-build')(root);
    expect(addon.version).toBe(constants.SNAPPY_VERSION);
    expect(addon.minLevel).toBe(constants.MIN_LEVEL);
    expect(addon.maxLevel).toBe(constants.MAX_LEVEL);
    expect(addon.defaultLevel).toBe(constants.DEFAULT_LEVEL);
  });

  it('snappy.wasm imports nothing but the memory-growth hook', () => {
    // A stray libc++ path (exceptions, abort, stdio) would add imports that only
    // fail at instantiation in Deno, browsers or Workers.
    const module = new WebAssembly.Module(readFileSync(join(root, 'dist', 'snappy.wasm')));
    expect(WebAssembly.Module.imports(module)).toEqual([{ module: 'env', name: 'emscripten_notify_memory_growth', kind: 'function' }]);
  });
});
