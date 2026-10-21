import {
  resolveCompressOptions,
  resolveCompressStreamOptions,
  resolveDecompressOptions,
  resolveDecompressStreamOptions,
  toBytes,
  toInputBytes,
} from './options.js';
import {
  MODE_CONTINUE,
  MODE_END,
  type Backend,
  type BackendKind,
  type BackendProvider,
  type Bytes,
  type CompressOptions,
  type CompressStreamOptions,
  type CStreamHandle,
  type DecompressOptions,
  type DecompressStreamOptions,
  type DStreamHandle,
  type WasmSource,
} from './types.js';

const EMPTY = new Uint8Array(0);
const STREAM_IDENTIFIER = [0xff, 0x06, 0x00, 0x00, 0x73, 0x4e, 0x61, 0x50, 0x70, 0x59]; // "sNaPpY"

/** True if `data` starts with the framing format's stream identifier. Does not validate the rest. */
export function isSnappyFramed(data: Bytes): boolean {
  const b = toBytes(data, 'data');
  return b.length >= STREAM_IDENTIFIER.length && STREAM_IDENTIFIER.every((v, i) => b[i] === v);
}

export function createApi(provider: BackendProvider) {
  // Starts `call` with the caller's bytes as they are right now. A loaded backend is
  // called immediately, and every backend copies its input before returning. While
  // the backend is still loading, the input is copied first (new Uint8Array copies;
  // Buffer#slice would return a view), so changes made after the call are not seen.
  function withBackend<T>(input: Uint8Array, call: (backend: Backend, input: Uint8Array) => Promise<T>): Promise<T> {
    const backend = provider.ready();
    if (backend) return call(backend, input);
    const copy = new Uint8Array(input);
    return provider.get().then((loaded) => call(loaded, copy));
  }

  /** Compresses `data` into a raw snappy block, or a framed stream. Strings are encoded as UTF-8. */
  async function compress(data: Bytes | string, options?: CompressOptions | number): Promise<Uint8Array> {
    const o = resolveCompressOptions(options, 'compress');
    return withBackend(toInputBytes(data), (backend, input) => backend.compress(input, o.level, o.format));
  }

  /** Synchronous `compress`. In browsers and edge runtimes, call `await init()` first. */
  function compressSync(data: Bytes | string, options?: CompressOptions | number): Uint8Array {
    const o = resolveCompressOptions(options, 'compressSync');
    return provider.getSync().compressSync(toInputBytes(data), o.level, o.format);
  }

  /**
   * Decompresses a raw block, or every chunk of a framed stream. Throws SnappyError if the data is
   * corrupt, cut off (ERR_SNAPPY_TRUNCATED) or would exceed `maxOutputSize` (ERR_SNAPPY_OUTPUT_LIMIT).
   */
  async function decompress(data: Bytes, options?: DecompressOptions): Promise<Uint8Array> {
    const o = resolveDecompressOptions(options, 'decompress');
    return withBackend(toBytes(data, 'data'), (backend, input) => backend.decompress(input, o.format, o.maxOutputSize));
  }

  /** Synchronous `decompress`. In browsers and edge runtimes, call `await init()` first. */
  function decompressSync(data: Bytes, options?: DecompressOptions): Uint8Array {
    const o = resolveDecompressOptions(options, 'decompressSync');
    return provider.getSync().decompressSync(toBytes(data, 'data'), o.format, o.maxOutputSize);
  }

  /**
   * The uncompressed length recorded in a raw block's header. Headers are untrusted: still pass
   * `maxOutputSize` when decompressing.
   */
  function getUncompressedLength(data: Bytes): number {
    return provider.getSync().uncompressedLength(toBytes(data, 'data'));
  }

  /** A TransformStream that compresses its input into a framed snappy stream. */
  function createCompressStream(options?: CompressStreamOptions | number): TransformStream<Bytes, Uint8Array> {
    const level = resolveCompressStreamOptions(options, 'createCompressStream');
    let handle: CStreamHandle | undefined;
    const close = () => {
      handle?.close();
      handle = undefined;
    };
    return new TransformStream<Bytes, Uint8Array>({
      async start() {
        handle = (await provider.get()).createCStream(level);
      },
      async transform(chunk, controller) {
        try {
          const out = await handle!.pushAsync(toBytes(chunk, 'chunk'), MODE_CONTINUE);
          if (out.length > 0) controller.enqueue(out);
        } catch (error) {
          close();
          throw error;
        }
      },
      async flush(controller) {
        try {
          const out = await handle!.pushAsync(EMPTY, MODE_END);
          if (out.length > 0) controller.enqueue(out);
        } finally {
          close();
        }
      },
      cancel: close,
    } as Transformer<Bytes, Uint8Array>);
  }

  /**
   * A TransformStream that decompresses a framed snappy stream. Errors if the input is corrupt,
   * ends partway through a chunk or exceeds `maxOutputSize` in total.
   */
  function createDecompressStream(options?: DecompressStreamOptions): TransformStream<Bytes, Uint8Array> {
    const maxOutputSize = resolveDecompressStreamOptions(options, 'createDecompressStream');
    let handle: DStreamHandle | undefined;
    const close = () => {
      handle?.close();
      handle = undefined;
    };
    return new TransformStream<Bytes, Uint8Array>({
      async start() {
        handle = (await provider.get()).createDStream(maxOutputSize);
      },
      async transform(chunk, controller) {
        try {
          const out = await handle!.pushAsync(toBytes(chunk, 'chunk'));
          if (out.length > 0) controller.enqueue(out);
        } catch (error) {
          close();
          throw error;
        }
      },
      flush() {
        try {
          handle!.finish();
        } finally {
          close();
        }
      },
      cancel: close,
    } as Transformer<Bytes, Uint8Array>);
  }

  /**
   * Loads the backend ahead of time. Required before synchronous calls in browsers and edge
   * runtimes. `source` overrides where the WebAssembly module is loaded from; it is ignored
   * when the native addon is in use.
   */
  async function init(source?: WasmSource): Promise<void> {
    await provider.init(source);
  }

  /** Which implementation is running: the native addon or WebAssembly. */
  function activeBackend(): BackendKind {
    return provider.kind();
  }

  return {
    compress,
    compressSync,
    decompress,
    decompressSync,
    getUncompressedLength,
    createCompressStream,
    createDecompressStream,
    init,
    activeBackend,
  };
}
