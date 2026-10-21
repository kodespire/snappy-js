// What `npm pack` publishes. React Native apps compile the native module from the
// package, so it must carry the podspec, android/, cpp/ and every source and header
// those builds compile, and nothing else of the repo (the example app, build output,
// snappy's tests and their data).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const { sources } = createRequire(import.meta.url)('../scripts/snappy-sources.cjs') as { sources(): string[] };

const [pack] = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  }),
) as [{ files: { path: string; size: number }[] }];
const files = pack.files.map((f) => f.path.replaceAll('\\', '/'));

describe('npm package contents', () => {
  it('includes the React Native build', () => {
    for (const file of [
      'KodespireSnappy.podspec',
      'react-native.config.js',
      'ios/KodespireSnappyModuleProvider.h',
      'ios/KodespireSnappyModuleProvider.mm',
      'cpp/KodespireSnappyModule.h',
      'cpp/KodespireSnappyModule.cpp',
      'android/build.gradle',
      'android/CMakeLists.txt',
      'android/src/main/java/com/kodespire/snappy/KodespireSnappyPackage.java',
      'codegen/NativeKodespireSnappy.ts',
      'csrc/sjs.cc',
      'csrc/sjs.h',
      'csrc/snappy-config/config.h',
      'csrc/snappy-config/snappy-stubs-public.h',
      'deps/snappy/COPYING',
      'dist/entry-react-native.js',
    ]) {
      expect(files).toContain(file);
    }
  });

  it('includes every snappy source and header the native builds compile', () => {
    for (const source of sources()) expect(files).toContain(source);
    // Everything snappy.cc, snappy-sinksource.cc, snappy-stubs-internal.cc and csrc/sjs.cc include.
    for (const header of ['snappy.h', 'snappy-internal.h', 'snappy-sinksource.h', 'snappy-stubs-internal.h']) {
      expect(files).toContain(`deps/snappy/${header}`);
    }
  });

  it('leaves out the rest of the repo', () => {
    for (const file of files) {
      expect(file).not.toMatch(/^(example|test|scripts|src|out|build|\.github)\//);
      expect(file).not.toMatch(/^android\/(build|\.cxx|\.gradle)\//);
      // snappy's tests, benchmarks, fuzzers and their data (other licenses), and its C API.
      expect(file).not.toMatch(/^deps\/snappy\/(testdata|third_party|docs|cmake)\//);
      expect(file).not.toMatch(/^deps\/snappy\/(snappy[-_](test|unittest|benchmark|c)|snappy_\w+_fuzzer|snappy_test_)/);
    }
    expect(files).not.toContain('binding.gyp');
    expect(files).not.toContain('csrc/addon.cc');
    expect(files).not.toContain('deps/snappy/COPYING.notestdata');
  });

  it('accepts any react-native version as a peer', () => {
    // npm treats "*" as always satisfied. A range such as ">=0.84" made zstd-js installs
    // fail (ERESOLVE) next to older or prerelease React Native, even for web-only use.
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.peerDependencies).toEqual({ 'react-native': '*' });
    expect(pkg.peerDependenciesMeta).toEqual({ 'react-native': { optional: true } });
  });

  it('keeps the React Native sources small', () => {
    // Everything except the JavaScript build and the Node prebuilds, unpacked.
    const native = pack.files.filter((f) => !/^(dist|prebuilds)\//.test(f.path.replaceAll('\\', '/')));
    const bytes = native.reduce((n, f) => n + f.size, 0);
    expect(bytes).toBeLessThan(500e3);
  });
});
