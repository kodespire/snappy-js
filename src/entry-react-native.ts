// React Native entry (the "react-native" export condition, which Metro uses on iOS
// and Android): the C++ TurboModule built from the same C++ sources as the native
// addon. Where the module is not linked (Expo Go, or a web bundler that picks this
// entry), it falls back to WebAssembly, which needs `await init(source)`.
// Keep the export list in sync with entry-wasm.ts, entry-node.ts and entry-workerd.js.
import * as ReactNative from 'react-native';

import { createApi } from './api.js';
import { createJsiBackend, type NativeModule } from './jsi-backend.js';
import { compileWasm, compileWasmSync } from './load-wasm-react-native.js';
import type { Backend, BackendProvider, Bytes } from './types.js';
import { createWasmProvider } from './wasm-provider.js';

const nativeModule = ReactNative.TurboModuleRegistry?.get<NativeModule>('KodespireSnappy');
const native: Backend | undefined = nativeModule ? createJsiBackend(nativeModule) : undefined;

const provider: BackendProvider = native
  ? {
      get: async () => native,
      getSync: () => native,
      init: async () => {},
      kind: () => 'native',
    }
  : createWasmProvider(compileWasm, compileWasmSync);

const api = createApi(provider);

// Bare React Native has no TransformStream (Expo installs one). Say so instead of
// failing with a ReferenceError.
function needsStreams<A extends unknown[]>(
  name: string,
  create: (...args: A) => TransformStream<Bytes, Uint8Array>,
): (...args: A) => TransformStream<Bytes, Uint8Array> {
  return (...args) => {
    if (typeof TransformStream === 'undefined') {
      throw new TypeError(
        `${name}: this runtime has no TransformStream. On React Native, install a polyfill such as ` +
          "web-streams-polyfill and import 'web-streams-polyfill/polyfill' before using streams.",
      );
    }
    return create(...args);
  };
}

export const { compress, compressSync, decompress, decompressSync, getUncompressedLength, init, activeBackend } = api;
export const createCompressStream = needsStreams('createCompressStream', api.createCompressStream);
export const createDecompressStream = needsStreams('createDecompressStream', api.createDecompressStream);

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
