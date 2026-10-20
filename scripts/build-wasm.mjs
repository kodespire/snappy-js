// Builds out/wasm/snappy.wasm from the same C++ sources as the native addon.
// Requires Emscripten (em++) on PATH: https://emscripten.org/docs/getting_started/
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { sources } = require('./snappy-sources.cjs');

const exported = [
  'malloc',
  'free',
  'sjs_buf_free',
  'sjs_compress',
  'sjs_decompress',
  'sjs_uncompressed_length',
  'sjs_cstream_create',
  'sjs_cstream_push',
  'sjs_cstream_free',
  'sjs_dstream_create',
  'sjs_dstream_push',
  'sjs_dstream_finish',
  'sjs_dstream_free',
  'sjs_version',
  'sjs_min_level',
  'sjs_max_level',
  'sjs_default_level',
].map((name) => `_${name}`);

const out = join(root, 'out', 'wasm', 'snappy.wasm');
mkdirSync(dirname(out), { recursive: true });

const args = [
  '-O3',
  '-flto',
  '-std=c++17',
  // csrc/sjs.cc never throws and calls only the snappy overloads that do not
  // allocate, so no exception or RTTI support is linked in.
  '-fno-exceptions',
  '-fno-rtti',
  '-DNDEBUG',
  '-DHAVE_CONFIG_H=1',
  '-Icsrc/snappy-config',
  '-Ideps/snappy',
  'csrc/sjs.cc',
  ...sources(),
  '--no-entry',
  // A plain .wasm with no Emscripten JS glue; src/wasm-backend.ts is the loader.
  '-sSTANDALONE_WASM=1',
  '-sFILESYSTEM=0',
  '-sALLOW_MEMORY_GROWTH=1',
  '-sINITIAL_MEMORY=2MB',
  '-sMAXIMUM_MEMORY=4GB',
  '-sSTACK_SIZE=256KB',
  '-sERROR_ON_UNDEFINED_SYMBOLS=1',
  `-sEXPORTED_FUNCTIONS=${exported.join(',')}`,
  '-o',
  out,
];

try {
  execFileSync('em++', args, { cwd: root, stdio: 'inherit' });
} catch (error) {
  if (error.code === 'ENOENT') {
    console.error('em++ not found. Install Emscripten and run `source <emsdk>/emsdk_env.sh` first.');
    process.exit(1);
  }
  throw error;
}
console.log(`built ${out} (${statSync(out).size} bytes)`);
