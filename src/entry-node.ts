// Node.js and Bun entry: the native addon, falling back to WebAssembly when no
// prebuilt binary matches this platform. Set SNAPPY_JS_BACKEND=wasm to force WebAssembly.
// Keep the export list in sync with entry-wasm.ts, entry-workerd.js and entry-react-native.ts.
import { createApi } from './api.js';
import { compileWasm, compileWasmSync } from './load-wasm-node.js';
import { loadNativeBackend } from './native-backend.js';
import type { Backend, BackendProvider } from './types.js';
import { createWasmProvider } from './wasm-provider.js';

const wasm = createWasmProvider(compileWasm, compileWasmSync);
let native: Backend | undefined;
let nativeUnavailable = process.env['SNAPPY_JS_BACKEND'] === 'wasm';

function tryNative(): Backend | undefined {
  if (native || nativeUnavailable) return native;
  try {
    native = loadNativeBackend();
  } catch {
    nativeUnavailable = true;
  }
  return native;
}

const provider: BackendProvider = {
  get: async () => tryNative() ?? wasm.get(),
  getSync: () => tryNative() ?? wasm.getSync(),
  init: async (source) => {
    if (!tryNative()) await wasm.init(source);
  },
  kind: () => (tryNative() ? 'native' : 'wasm'),
};

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
} = createApi(provider);

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
