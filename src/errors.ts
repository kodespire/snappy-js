export type SnappyErrorCode =
  /** The data is not valid snappy: a bad block, a checksum mismatch, an unknown required chunk. */
  | 'ERR_SNAPPY_CORRUPT'
  /** The input ended partway through a raw block or a framed chunk, or was empty. */
  | 'ERR_SNAPPY_TRUNCATED'
  /** Decompressed output would exceed `maxOutputSize`. */
  | 'ERR_SNAPPY_OUTPUT_LIMIT'
  | 'ERR_SNAPPY_OUT_OF_MEMORY'
  | 'ERR_SNAPPY_INVALID_ARGUMENT'
  /** A synchronous call was made before the WebAssembly module was loaded with `init()`. */
  | 'ERR_SNAPPY_NOT_INITIALIZED';

export class SnappyError extends Error {
  readonly code: SnappyErrorCode;

  constructor(code: SnappyErrorCode, message: string) {
    super(message);
    this.name = 'SnappyError';
    this.code = code;
  }
}

// Indexed by the SJS_ERR_* values in csrc/sjs.h.
const CODES: readonly (SnappyErrorCode | undefined)[] = [
  undefined,
  'ERR_SNAPPY_CORRUPT',
  'ERR_SNAPPY_TRUNCATED',
  'ERR_SNAPPY_OUTPUT_LIMIT',
  'ERR_SNAPPY_OUT_OF_MEMORY',
  'ERR_SNAPPY_INVALID_ARGUMENT',
];

export function errorFromCore(rc: number, detail: string): SnappyError {
  return new SnappyError(CODES[rc] ?? 'ERR_SNAPPY_CORRUPT', detail);
}

/** Converts an error thrown by the native addon into a SnappyError with a JavaScript stack. */
export function rethrowNative(error: unknown): never {
  if (error !== null && typeof error === 'object' && typeof (error as { sjsCode?: unknown }).sjsCode === 'number') {
    throw errorFromCore((error as { sjsCode: number }).sjsCode, (error as Error).message);
  }
  throw error;
}
