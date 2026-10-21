// React Native backend: the C++ TurboModule in cpp/ (the sjs C layer, as in the
// Node-API addon), reached through JSI. It returns ArrayBuffers that own the
// native output, and throws or rejects with errors carrying `sjsCode`.
import { rethrowNative } from './errors.js';
import type { Backend, CStreamHandle, DStreamHandle } from './types.js';

interface NativeCStream {
  push(chunk: Uint8Array, mode: number): ArrayBuffer;
  pushAsync(chunk: Uint8Array, mode: number): Promise<ArrayBuffer>;
  close(): void;
}

interface NativeDStream {
  push(chunk: Uint8Array): ArrayBuffer;
  pushAsync(chunk: Uint8Array): Promise<ArrayBuffer>;
  finish(): void;
  close(): void;
}

/** @internal What cpp/KodespireSnappyModule.cpp exposes. */
export interface NativeModule {
  version(): string;
  compressSync(data: Uint8Array, level: number, format: number): ArrayBuffer;
  compress(data: Uint8Array, level: number, format: number): Promise<ArrayBuffer>;
  decompressSync(data: Uint8Array, format: number, maxOutput: number): ArrayBuffer;
  decompress(data: Uint8Array, format: number, maxOutput: number): Promise<ArrayBuffer>;
  uncompressedLength(data: Uint8Array): number;
  createCStream(level: number): NativeCStream;
  createDStream(maxOutput: number): NativeDStream;
}

const bytes = (buffer: ArrayBuffer): Uint8Array => new Uint8Array(buffer);

function wrapSync<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return (...args) => {
    try {
      return fn(...args);
    } catch (error) {
      rethrowNative(error);
    }
  };
}

export function createJsiBackend(m: NativeModule): Backend {
  return {
    kind: 'native',
    version: m.version(),
    compressSync: wrapSync((data, level, format) => bytes(m.compressSync(data, level, format))),
    compress: (data, level, format) => m.compress(data, level, format).then(bytes, rethrowNative),
    decompressSync: wrapSync((data, format, maxOutput) => bytes(m.decompressSync(data, format, maxOutput))),
    decompress: (data, format, maxOutput) => m.decompress(data, format, maxOutput).then(bytes, rethrowNative),
    uncompressedLength: wrapSync((data) => m.uncompressedLength(data)),
    // The stream methods are plain functions bound to their native context.
    createCStream: wrapSync((level): CStreamHandle => {
      const { push, pushAsync, close } = m.createCStream(level);
      return {
        push: wrapSync((chunk, mode) => bytes(push(chunk, mode))),
        pushAsync: (chunk, mode) => pushAsync(chunk, mode).then(bytes, rethrowNative),
        close: wrapSync(() => close()),
      };
    }),
    createDStream: wrapSync((maxOutput): DStreamHandle => {
      const { push, pushAsync, finish, close } = m.createDStream(maxOutput);
      return {
        push: wrapSync((chunk) => bytes(push(chunk))),
        pushAsync: (chunk) => pushAsync(chunk).then(bytes, rethrowNative),
        finish: wrapSync(() => finish()),
        close: wrapSync(() => close()),
      };
    }),
  };
}
