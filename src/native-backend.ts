import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { rethrowNative } from './errors.js';
import type { Backend, CStreamHandle, DStreamHandle } from './types.js';

interface NativeCStream {
  push(chunk: Uint8Array, mode: number): Uint8Array;
  pushAsync(chunk: Uint8Array, mode: number): Promise<Uint8Array>;
  close(): void;
}

interface NativeDStream {
  push(chunk: Uint8Array): Uint8Array;
  pushAsync(chunk: Uint8Array): Promise<Uint8Array>;
  finish(): void;
  close(): void;
}

interface NativeAddon {
  version: string;
  compressSync(data: Uint8Array, level: number, format: number): Uint8Array;
  compress(data: Uint8Array, level: number, format: number): Promise<Uint8Array>;
  decompressSync(data: Uint8Array, format: number, maxOutput: number): Uint8Array;
  decompress(data: Uint8Array, format: number, maxOutput: number): Promise<Uint8Array>;
  uncompressedLength(data: Uint8Array): number;
  CStream: new (level: number) => NativeCStream;
  DStream: new (maxOutput: number) => NativeDStream;
}

// The addon returns Node Buffers; expose plain Uint8Array views (no copy) so results
// behave the same in every runtime.
const view = (b: Uint8Array): Uint8Array => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

function wrapSync<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return (...args) => {
    try {
      return fn(...args);
    } catch (error) {
      rethrowNative(error);
    }
  };
}

/** Loads the prebuilt (or locally built) addon. Throws if none matches this platform. */
export function loadNativeBackend(): Backend {
  const require = createRequire(import.meta.url);
  const nodeGypBuild = require('node-gyp-build') as (dir: string) => NativeAddon;
  const addon = nodeGypBuild(fileURLToPath(new URL('..', import.meta.url)));

  return {
    kind: 'native',
    version: addon.version,
    compressSync: wrapSync((data, level, format) => view(addon.compressSync(data, level, format))),
    compress: (data, level, format) => addon.compress(data, level, format).then(view, rethrowNative),
    decompressSync: wrapSync((data, format, maxOutput) => view(addon.decompressSync(data, format, maxOutput))),
    decompress: (data, format, maxOutput) => addon.decompress(data, format, maxOutput).then(view, rethrowNative),
    uncompressedLength: wrapSync((data) => addon.uncompressedLength(data)),
    createCStream: wrapSync((level): CStreamHandle => {
      const s = new addon.CStream(level);
      return {
        push: wrapSync((chunk, mode) => view(s.push(chunk, mode))),
        pushAsync: (chunk, mode) => s.pushAsync(chunk, mode).then(view, rethrowNative),
        close: wrapSync(() => s.close()),
      };
    }),
    createDStream: wrapSync((maxOutput): DStreamHandle => {
      const s = new addon.DStream(maxOutput);
      return {
        push: wrapSync((chunk) => view(s.push(chunk))),
        pushAsync: (chunk) => s.pushAsync(chunk).then(view, rethrowNative),
        finish: wrapSync(() => s.finish()),
        close: wrapSync(() => s.close()),
      };
    }),
  };
}
