// The documented public API. This file only declares; each entry point
// (entry-node.ts, entry-wasm.ts, entry-workerd.js) implements it, and
// test/types.test-d.ts checks that they match. package.json points "types" here.
import type {
  BackendKind,
  Bytes,
  CompressOptions,
  CompressStreamOptions,
  DecompressOptions,
  DecompressStreamOptions,
  WasmSource,
} from './types.js';

/**
 * Compresses `data` into one raw snappy block (the default) or, with `format: 'framed'`, a
 * complete stream in the snappy framing format.
 *
 * A raw block holds at most 4 GiB - 1 bytes of input; larger input throws
 * `ERR_SNAPPY_INVALID_ARGUMENT` (use the framing format).
 *
 * @param data Bytes to compress. Strings are encoded as UTF-8.
 * @param options Options, or just a compression level (`compress(data, 2)`).
 * @example
 * const block = await compress(data);
 * const stream = await compress(data, { format: 'framed' });
 */
export declare function compress(data: Bytes | string, options?: CompressOptions | number): Promise<Uint8Array>;

/**
 * Synchronous {@link compress}. In browsers, Deno and Workers, `await init()` must have run first.
 */
export declare function compressSync(data: Bytes | string, options?: CompressOptions | number): Uint8Array;

/**
 * Decompresses one raw snappy block (the default) or, with `format: 'framed'`, every chunk of a
 * framed stream (concatenated streams are joined, skippable chunks skipped).
 *
 * Throws a {@link SnappyError} with code `ERR_SNAPPY_TRUNCATED` if the input ends partway through
 * a block or chunk (empty raw input included; empty framed input is an empty stream), `ERR_SNAPPY_OUTPUT_LIMIT` if the output would exceed
 * `maxOutputSize`, and `ERR_SNAPPY_CORRUPT` if the data is not valid snappy in the given
 * format. It never returns partial output.
 *
 * @example
 * const data = await decompress(block, { maxOutputSize: 64 * 1024 * 1024 });
 */
export declare function decompress(data: Bytes, options?: DecompressOptions): Promise<Uint8Array>;

/**
 * Synchronous {@link decompress}. In browsers, Deno and Workers, `await init()` must have run first.
 */
export declare function decompressSync(data: Bytes, options?: DecompressOptions): Uint8Array;

/**
 * The uncompressed length recorded in a raw block's header (raw format only). Throws
 * `ERR_SNAPPY_TRUNCATED` or `ERR_SNAPPY_CORRUPT` if the header is cut off or invalid. Headers
 * are untrusted input: still set `maxOutputSize`.
 */
export declare function getUncompressedLength(data: Bytes): number;

/**
 * A TransformStream that compresses everything written to it into one framed snappy stream.
 *
 * @example
 * const compressed = file.stream().pipeThrough(createCompressStream());
 */
export declare function createCompressStream(options?: CompressStreamOptions | number): TransformStream<Bytes, Uint8Array>;

/**
 * A TransformStream that decompresses a framed snappy stream. The stream errors if the input is
 * corrupt, ends partway through a chunk, or exceeds `maxOutputSize` in total.
 *
 * @example
 * const body = response.body.pipeThrough(createDecompressStream());
 */
export declare function createDecompressStream(options?: DecompressStreamOptions): TransformStream<Bytes, Uint8Array>;

/**
 * Loads the backend ahead of time. Needed before the synchronous functions in browsers, Deno and
 * Workers; optional elsewhere.
 *
 * @param source Where to load `snappy.wasm` from (URL, path, `Response`, bytes or a compiled
 *   `WebAssembly.Module`). Ignored when the native addon is in use.
 */
export declare function init(source?: WasmSource): Promise<void>;

/** Which implementation is running: `'native'` (Node-API addon) or `'wasm'`. */
export declare function activeBackend(): BackendKind;

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
