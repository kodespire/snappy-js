/** Binary input accepted everywhere: any ArrayBuffer, typed array, DataView or Node Buffer. */
export type Bytes = ArrayBuffer | ArrayBufferView;

/**
 * `'raw'`: one snappy block (a length header, then the compressed data), with no checksum
 * and no magic number. What Parquet, LevelDB and Prometheus remote write store.
 *
 * `'framed'`: the snappy framing format: a `sNaPpY` stream identifier, then chunks of at
 * most 64 KiB, each with a CRC-32C of its data. What the streams read and write.
 */
export type Format = 'raw' | 'framed';

export interface CompressOptions {
  /**
   * 1 (the default, fastest) or 2 (a little denser and slower; marked experimental upstream).
   * Both produce standard snappy data that any decoder reads.
   */
  level?: number;
  /** `'raw'` (the default) or `'framed'`. */
  format?: Format;
}

export interface DecompressOptions {
  /**
   * Throw ERR_SNAPPY_OUTPUT_LIMIT instead of producing more than this many bytes.
   * Set it whenever the input is untrusted. Defaults to Infinity.
   */
  maxOutputSize?: number;
  /** `'raw'` (the default) or `'framed'`. Must match how the data was compressed. */
  format?: Format;
}

export interface CompressStreamOptions {
  /** 1 (the default) or 2. */
  level?: number;
  /** Streams always use the framing format; `'framed'` may be given for clarity. */
  format?: 'framed';
}

export interface DecompressStreamOptions {
  /** Error with ERR_SNAPPY_OUTPUT_LIMIT once more than this many bytes are produced in total. */
  maxOutputSize?: number;
  /** Streams always use the framing format; `'framed'` may be given for clarity. */
  format?: 'framed';
}

/** Where the WebAssembly module comes from, for `init()`. */
export type WasmSource =
  | WebAssembly.Module
  | Bytes
  | URL
  | string
  | Response
  | PromiseLike<Response>;

export type BackendKind = 'native' | 'wasm';

/** @internal Values match SJS_FORMAT_* in csrc/sjs.h. */
export const FORMAT_RAW = 0;
/** @internal */
export const FORMAT_FRAMED = 1;

/** @internal Mode values match SJS_MODE_* in csrc/sjs.h. */
export const MODE_CONTINUE = 0;
/** @internal */
export const MODE_END = 2;

/** @internal */
export interface CStreamHandle {
  push(chunk: Uint8Array, mode: number): Uint8Array;
  pushAsync(chunk: Uint8Array, mode: number): Promise<Uint8Array>;
  close(): void;
}

/** @internal */
export interface DStreamHandle {
  push(chunk: Uint8Array): Uint8Array;
  pushAsync(chunk: Uint8Array): Promise<Uint8Array>;
  finish(): void;
  close(): void;
}

/** @internal What each backend (native addon, WebAssembly) implements. Errors are SnappyError. */
export interface Backend {
  readonly kind: BackendKind;
  readonly version: string;
  compressSync(data: Uint8Array, level: number, format: number): Uint8Array;
  compress(data: Uint8Array, level: number, format: number): Promise<Uint8Array>;
  decompressSync(data: Uint8Array, format: number, maxOutput: number): Uint8Array;
  decompress(data: Uint8Array, format: number, maxOutput: number): Promise<Uint8Array>;
  uncompressedLength(data: Uint8Array): number;
  createCStream(level: number): CStreamHandle;
  createDStream(maxOutput: number): DStreamHandle;
}

/** @internal How an entry point supplies its backend to the public API. */
export interface BackendProvider {
  get(): Promise<Backend>;
  getSync(): Backend;
  /** The backend if it is already loaded, without loading it. */
  ready(): Backend | undefined;
  init(source?: WasmSource): Promise<void>;
  kind(): BackendKind;
}
