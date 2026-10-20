// Loader and bindings for out/wasm/snappy.wasm (a standalone module with no
// Emscripten JS glue). Memory can grow during any call, which replaces
// memory.buffer, so views are created fresh after every call into WebAssembly
// and never cached. Pointers and sizes coming back are unsigned 32-bit (>>> 0).

import { errorFromCore, SnappyError } from './errors.js';
import type { Backend, CStreamHandle, DStreamHandle } from './types.js';

interface SjsExports {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  malloc(size: number): number;
  free(ptr: number): void;
  sjs_buf_free(buf: number): void;
  sjs_compress(src: number, srcSize: number, level: number, format: number, out: number, detail: number): number;
  sjs_decompress(src: number, srcSize: number, format: number, maxOutput: number, out: number, detail: number): number;
  sjs_uncompressed_length(src: number, srcSize: number, size: number, detail: number): number;
  sjs_cstream_create(level: number, stream: number, detail: number): number;
  sjs_cstream_push(stream: number, src: number, srcSize: number, mode: number, out: number, detail: number): number;
  sjs_cstream_free(stream: number): void;
  sjs_dstream_create(maxOutput: number, stream: number, detail: number): number;
  sjs_dstream_push(stream: number, src: number, srcSize: number, out: number, detail: number): number;
  sjs_dstream_finish(stream: number, detail: number): number;
  sjs_dstream_free(stream: number): void;
  sjs_version(): number;
}

const imports = {
  env: {
    // Called by the module after memory.grow; views are rebuilt per call anyway.
    emscripten_notify_memory_growth() {},
  },
};

// Scratch block layout (allocated once per instance):
//   +0  sjs_buf { data, size, cap }   (3 x u32)
//   +12 const char* detail            (u32)
//   +16 stream pointer out-param      (u32)
//   +24 double out-param              (f64)
const SCRATCH_SIZE = 32;
const BUF = 0;
const DETAIL = 12;
const STREAM = 16;
const DOUBLE = 24;

// wasm32 size_t: anything at or above 2^32 - 1 means "no limit".
const NO_LIMIT = 0xffffffff;

const decoder = new TextDecoder();

class Wasm {
  readonly e: SjsExports;
  readonly scratch: number;

  constructor(instance: WebAssembly.Instance) {
    this.e = instance.exports as unknown as SjsExports;
    this.e._initialize?.();
    this.scratch = this.e.malloc(SCRATCH_SIZE) >>> 0;
    if (this.scratch === 0) throw new SnappyError('ERR_SNAPPY_OUT_OF_MEMORY', 'out of memory');
  }

  u8(): Uint8Array {
    return new Uint8Array(this.e.memory.buffer);
  }

  view(): DataView {
    return new DataView(this.e.memory.buffer);
  }

  resetScratch(): void {
    this.u8().fill(0, this.scratch, this.scratch + SCRATCH_SIZE);
  }

  /** Copies bytes into WebAssembly memory. Returns 0 for empty input. Caller frees. */
  copyIn(bytes: Uint8Array): number {
    if (bytes.length === 0) return 0;
    const ptr = this.e.malloc(bytes.length) >>> 0;
    if (ptr === 0) throw new SnappyError('ERR_SNAPPY_OUT_OF_MEMORY', 'out of memory');
    this.u8().set(bytes, ptr);
    return ptr;
  }

  free(ptr: number): void {
    if (ptr !== 0) this.e.free(ptr);
  }

  cString(ptr: number): string {
    if (ptr === 0) return 'snappy error';
    const mem = this.u8();
    let end = ptr;
    while (mem[end] !== 0) end++;
    return decoder.decode(mem.subarray(ptr, end));
  }

  /** Copies the scratch sjs_buf out to a new Uint8Array and frees it. */
  takeBuf(): Uint8Array {
    const view = this.view();
    const data = view.getUint32(this.scratch + BUF, true);
    const size = view.getUint32(this.scratch + BUF + 4, true);
    const out = this.u8().slice(data, data + size);
    this.e.sjs_buf_free(this.scratch + BUF);
    return out;
  }

  /** Frees the scratch sjs_buf and returns the error for rc. */
  fail(rc: number): SnappyError {
    const detail = this.cString(this.view().getUint32(this.scratch + DETAIL, true));
    this.e.sjs_buf_free(this.scratch + BUF);
    return errorFromCore(rc, detail);
  }

  readPointer(offset: number): number {
    return this.view().getUint32(this.scratch + offset, true);
  }
}

function limit(maxOutput: number): number {
  return maxOutput >= NO_LIMIT ? NO_LIMIT : maxOutput;
}

const registry =
  typeof FinalizationRegistry === 'function'
    ? new FinalizationRegistry<() => void>((free) => free())
    : undefined;

function createBackend(w: Wasm): Backend {
  const { e } = w;

  function withInput<T>(input: Uint8Array | null, fn: (ptr: number) => T): T {
    const ptr = input ? w.copyIn(input) : 0;
    try {
      w.resetScratch();
      return fn(ptr);
    } finally {
      w.free(ptr);
    }
  }

  function compressSync(data: Uint8Array, level: number, format: number): Uint8Array {
    return withInput(data, (src) => {
      const rc = e.sjs_compress(src, data.length, level, format, w.scratch + BUF, w.scratch + DETAIL);
      if (rc !== 0) throw w.fail(rc);
      return w.takeBuf();
    });
  }

  function decompressSync(data: Uint8Array, format: number, maxOutput: number): Uint8Array {
    return withInput(data, (src) => {
      const rc = e.sjs_decompress(src, data.length, format, limit(maxOutput), w.scratch + BUF, w.scratch + DETAIL);
      if (rc !== 0) throw w.fail(rc);
      return w.takeBuf();
    });
  }

  function createCStream(level: number): CStreamHandle {
    let ptr = withInput(null, () => {
      const rc = e.sjs_cstream_create(level, w.scratch + STREAM, w.scratch + DETAIL);
      if (rc !== 0) throw w.fail(rc);
      return w.readPointer(STREAM);
    });
    const token = {};
    registry?.register(token, ((p: number) => () => e.sjs_cstream_free(p))(ptr), token);
    const handle: CStreamHandle & { token: object } = {
      token,
      push(chunk, mode) {
        if (ptr === 0) throw new SnappyError('ERR_SNAPPY_INVALID_ARGUMENT', 'stream is closed');
        return withInput(chunk, (src) => {
          const rc = e.sjs_cstream_push(ptr, src, chunk.length, mode, w.scratch + BUF, w.scratch + DETAIL);
          if (rc !== 0) throw w.fail(rc);
          return w.takeBuf();
        });
      },
      async pushAsync(chunk, mode) {
        return handle.push(chunk, mode);
      },
      close() {
        if (ptr === 0) return;
        registry?.unregister(token);
        e.sjs_cstream_free(ptr);
        ptr = 0;
      },
    };
    return handle;
  }

  function createDStream(maxOutput: number): DStreamHandle {
    let ptr = withInput(null, () => {
      const rc = e.sjs_dstream_create(limit(maxOutput), w.scratch + STREAM, w.scratch + DETAIL);
      if (rc !== 0) throw w.fail(rc);
      return w.readPointer(STREAM);
    });
    const token = {};
    registry?.register(token, ((p: number) => () => e.sjs_dstream_free(p))(ptr), token);
    const closed = () => new SnappyError('ERR_SNAPPY_INVALID_ARGUMENT', 'stream is closed');
    const handle: DStreamHandle & { token: object } = {
      token,
      push(chunk) {
        if (ptr === 0) throw closed();
        return withInput(chunk, (src) => {
          const rc = e.sjs_dstream_push(ptr, src, chunk.length, w.scratch + BUF, w.scratch + DETAIL);
          if (rc !== 0) throw w.fail(rc);
          return w.takeBuf();
        });
      },
      async pushAsync(chunk) {
        return handle.push(chunk);
      },
      finish() {
        if (ptr === 0) throw closed();
        w.resetScratch();
        const rc = e.sjs_dstream_finish(ptr, w.scratch + DETAIL);
        if (rc !== 0) throw w.fail(rc);
      },
      close() {
        if (ptr === 0) return;
        registry?.unregister(token);
        e.sjs_dstream_free(ptr);
        ptr = 0;
      },
    };
    return handle;
  }

  function uncompressedLength(data: Uint8Array): number {
    return withInput(data, (src) => {
      const rc = e.sjs_uncompressed_length(src, data.length, w.scratch + DOUBLE, w.scratch + DETAIL);
      if (rc !== 0) throw w.fail(rc);
      return w.view().getFloat64(w.scratch + DOUBLE, true);
    });
  }

  return {
    kind: 'wasm',
    version: w.cString(e.sjs_version() >>> 0),
    compressSync,
    compress: async (...args) => compressSync(...args),
    decompressSync,
    decompress: async (...args) => decompressSync(...args),
    uncompressedLength,
    createCStream,
    createDStream,
  };
}

export async function instantiateWasmBackend(module: WebAssembly.Module): Promise<Backend> {
  const instance = await WebAssembly.instantiate(module, imports);
  return createBackend(new Wasm(instance));
}

export function instantiateWasmBackendSync(module: WebAssembly.Module): Backend {
  return createBackend(new Wasm(new WebAssembly.Instance(module, imports)));
}
