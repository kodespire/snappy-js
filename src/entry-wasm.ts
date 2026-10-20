// WebAssembly entry: browsers, Deno, and anything without the native addon.
// Keep the export list in sync with entry-node.ts and entry-workerd.js.
import { compileWasm, compileWasmSync } from '#load-wasm';

import { createApi } from './api.js';
import { createWasmProvider } from './wasm-provider.js';

export const {
  compress,
  compressSync,
  decompress,
  decompressSync,
  getUncompressedLength,
  createCompressStream,
  createDecompressStream,
  init,
  activeBackend,
} = createApi(createWasmProvider(compileWasm, compileWasmSync));

export { isSnappyFramed } from './api.js';
export { SnappyError, type SnappyErrorCode } from './errors.js';
export type {
  BackendKind,
  Bytes,
  CompressOptions,
  CompressStreamOptions,
  DecompressOptions,
  DecompressStreamOptions,
  Format,
  WasmSource,
} from './types.js';
export { DEFAULT_LEVEL, MAX_LEVEL, MIN_LEVEL, SNAPPY_VERSION } from './version.js';
