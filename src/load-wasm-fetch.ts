// Loads snappy.wasm with fetch(). Used by browsers, Deno and other non-Node runtimes.
// Bundlers (Vite, webpack, Parcel) recognise `new URL('./snappy.wasm', import.meta.url)`
// and emit the file as an asset.
import { SnappyError } from './errors.js';
import type { WasmSource } from './types.js';
import { compileFrom } from './wasm-source.js';

export async function compileWasm(source?: WasmSource): Promise<WebAssembly.Module> {
  const s = source ?? new URL('./snappy.wasm', import.meta.url);
  if (s instanceof URL || typeof s === 'string') return compileFrom(fetch(s));
  return compileFrom(s);
}

export function compileWasmSync(): WebAssembly.Module {
  throw new SnappyError(
    'ERR_SNAPPY_NOT_INITIALIZED',
    'snappy-js: call `await init()` before using synchronous functions in this runtime',
  );
}
