import type {
  Bytes,
  CompressOptions,
  CompressStreamOptions,
  DecompressOptions,
  DecompressStreamOptions,
} from './types.js';
import { FORMAT_FRAMED, FORMAT_RAW } from './types.js';
import { DEFAULT_LEVEL, MAX_LEVEL, MIN_LEVEL } from './version.js';

const encoder = new TextEncoder();

function isArrayBufferLike(value: unknown): value is ArrayBufferLike {
  const tag = Object.prototype.toString.call(value);
  return tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]';
}

/** A Uint8Array view over the caller's bytes (no copy). */
export function toBytes(input: unknown, name: string): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (isArrayBufferLike(input)) return new Uint8Array(input);
  throw new TypeError(`${name} must be an ArrayBuffer, a typed array, a DataView or a Buffer`);
}

/** Like toBytes, and also accepts strings (encoded as UTF-8). */
export function toInputBytes(input: unknown): Uint8Array {
  return typeof input === 'string' ? encoder.encode(input) : toBytes(input, 'data');
}

const HINTS: [test: RegExp, option: string][] = [
  [/level/i, 'level'],
  [/fram|raw|format/i, 'format'],
  [/max|limit/i, 'maxOutputSize'],
];

// Unknown keys throw instead of being ignored, so a typo such as
// `{ framed: true }` cannot silently produce the other format.
function checkKeys(options: object, allowed: readonly string[], fn: string): void {
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) {
      const guess = HINTS.find(([test, option]) => test.test(key) && allowed.includes(option))?.[1];
      const hint = guess ? ` Did you mean "${guess}"?` : '';
      throw new TypeError(`${fn}: unknown option "${key}". Valid options: ${allowed.join(', ')}.${hint}`);
    }
  }
}

function checkOptionsObject(options: unknown, fn: string): void {
  if (options !== undefined && (options === null || typeof options !== 'object')) {
    throw new TypeError(`${fn}: options must be an object`);
  }
}

function resolveLevel(level: unknown, fn: string): number {
  level ??= DEFAULT_LEVEL;
  if (typeof level !== 'number' || !Number.isInteger(level) || level < MIN_LEVEL || level > MAX_LEVEL) {
    throw new RangeError(`${fn}: level must be an integer from ${MIN_LEVEL} to ${MAX_LEVEL}, got ${String(level)}`);
  }
  return level;
}

function resolveFormat(format: unknown, fn: string): number {
  if (format === undefined || format === 'raw') return FORMAT_RAW;
  if (format === 'framed') return FORMAT_FRAMED;
  throw new TypeError(`${fn}: format must be "raw" or "framed", got ${JSON.stringify(format) ?? String(format)}`);
}

function checkStreamFormat(format: unknown, fn: string): void {
  if (format !== undefined && format !== 'framed') {
    throw new TypeError(`${fn}: streams always use the framing format, so format can only be "framed"`);
  }
}

function resolveMaxOutputSize(value: unknown, fn: string): number {
  const maxOutputSize = value ?? Infinity;
  if (typeof maxOutputSize !== 'number' || Number.isNaN(maxOutputSize) || maxOutputSize < 0 ||
      (Number.isFinite(maxOutputSize) && !Number.isInteger(maxOutputSize))) {
    throw new RangeError(`${fn}: maxOutputSize must be a non-negative integer or Infinity`);
  }
  return maxOutputSize;
}

export interface ResolvedCompressOptions {
  level: number;
  /** FORMAT_RAW or FORMAT_FRAMED. */
  format: number;
}

const COMPRESS_KEYS = ['level', 'format'] as const;

export function resolveCompressOptions(options: CompressOptions | number | undefined, fn: string): ResolvedCompressOptions {
  if (typeof options === 'number') options = { level: options };
  checkOptionsObject(options, fn);
  if (options) checkKeys(options, COMPRESS_KEYS, fn);
  return { level: resolveLevel(options?.level, fn), format: resolveFormat(options?.format, fn) };
}

export interface ResolvedDecompressOptions {
  maxOutputSize: number;
  /** FORMAT_RAW or FORMAT_FRAMED. */
  format: number;
}

const DECOMPRESS_KEYS = ['maxOutputSize', 'format'] as const;

export function resolveDecompressOptions(options: DecompressOptions | undefined, fn: string): ResolvedDecompressOptions {
  checkOptionsObject(options, fn);
  if (options) checkKeys(options, DECOMPRESS_KEYS, fn);
  return { maxOutputSize: resolveMaxOutputSize(options?.maxOutputSize, fn), format: resolveFormat(options?.format, fn) };
}

export function resolveCompressStreamOptions(options: CompressStreamOptions | number | undefined, fn: string): number {
  if (typeof options === 'number') options = { level: options };
  checkOptionsObject(options, fn);
  if (options) checkKeys(options, COMPRESS_KEYS, fn);
  checkStreamFormat(options?.format, fn);
  return resolveLevel(options?.level, fn);
}

export function resolveDecompressStreamOptions(options: DecompressStreamOptions | undefined, fn: string): number {
  checkOptionsObject(options, fn);
  if (options) checkKeys(options, DECOMPRESS_KEYS, fn);
  checkStreamFormat(options?.format, fn);
  return resolveMaxOutputSize(options?.maxOutputSize, fn);
}

export type { Bytes };
