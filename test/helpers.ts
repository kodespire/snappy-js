// Tests run against the built package in dist/ (what users get), once per backend.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as nodeEntry from '../dist/entry-node.js';
import * as wasmEntry from '../dist/entry-wasm.js';

export type Snappy = typeof nodeEntry;

export const backends: [name: 'native' | 'wasm', api: Snappy][] = [
  ['native', nodeEntry],
  ['wasm', wasmEntry as Snappy],
];

const root = join(import.meta.dirname, '..');
export const fixture = (name: string): Buffer => readFileSync(join(import.meta.dirname, 'fixtures', name));

/** Files from google/snappy's own test corpus, read in place (they carry their own licenses). */
export const testdata = (name: string): Buffer => readFileSync(join(root, 'deps', 'snappy', 'testdata', name));
export const TESTDATA_FILES = [
  'alice29.txt', 'asyoulik.txt', 'fireworks.jpeg', 'geo.protodata', 'html', 'html_x_4',
  'kppkn.gtb', 'lcet10.txt', 'paper-100k.pdf', 'plrabn12.txt', 'urls.10K',
];

// ---- an independent snappy implementation, through Python ---------------------

const pythonCandidate =
  process.env['SNAPPY_PYTHON'] ?? join(root, 'out', 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

function findPython(): string | undefined {
  if (!existsSync(pythonCandidate) && !process.env['SNAPPY_PYTHON']) return undefined;
  try {
    execFileSync(pythonCandidate, ['-I', join(import.meta.dirname, 'interop.py'), 'versions'], { stdio: ['ignore', 'pipe', 'pipe'] });
    return pythonCandidate;
  } catch {
    return undefined;
  }
}

/**
 * Python with python-snappy and cramjam (Rust `snap`), if available: set SNAPPY_PYTHON or run
 * `node scripts/setup-python-snappy.mjs`. In CI its absence is an error, not a skip.
 */
export const python = findPython();
if (!python && process.env['CI']) {
  throw new Error('CI is set but python-snappy is not available: install test/interop-requirements.txt and set SNAPPY_PYTHON');
}

export type PythonCommand = 'compress-raw' | 'decompress-raw' | 'compress-framed' | 'decompress-framed';

let calls = 0;

/** Runs data through test/interop.py. Throws if Python reports an error. */
export function viaPython(command: PythonCommand, data: Uint8Array): Uint8Array {
  const input = join(tmpdir(), `snappy-js-interop-${process.pid}-${calls++}.bin`);
  writeFileSync(input, data, { flag: 'wx' });
  try {
    return new Uint8Array(
      execFileSync(python!, ['-I', join(import.meta.dirname, 'interop.py'), command, input], {
        maxBuffer: 1 << 30,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
      }),
    );
  } finally {
    rmSync(input, { force: true });
  }
}

// ---- data -------------------------------------------------------------------

/** Deterministic pseudo-random bytes (incompressible). */
export function randomBytes(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

/** Deterministic, moderately compressible bytes. */
export function textBytes(length: number, seed = 1): Uint8Array {
  const words = ['alpha ', 'beta ', 'gamma ', 'delta ', 'snappy ', 'chunk ', 'block ', '\n'];
  const out = new Uint8Array(length);
  const r = randomBytes(length, seed);
  let i = 0;
  let k = 0;
  while (i < length) {
    const w = words[r[k++ % length]! % words.length]!;
    for (let j = 0; j < w.length && i < length; j++) out[i++] = w.charCodeAt(j);
  }
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// ---- the framing format, written independently of csrc/ -------------------------

/** CRC-32C, bit by bit (deliberately not the table or hardware code in csrc/sjs.cc). */
export function crc32c(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0x82f63b78 & -(c & 1));
  }
  return ~c >>> 0;
}

export function maskedCrc(data: Uint8Array): number {
  const c = crc32c(data);
  return (((c >>> 15) | (c << 17)) + 0xa282ead8) >>> 0;
}

export const STREAM_IDENTIFIER = new Uint8Array([0xff, 0x06, 0x00, 0x00, 0x73, 0x4e, 0x61, 0x50, 0x70, 0x59]);

/** A chunk with the given type byte and data (no checksum added). */
export function chunk(type: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + data.length);
  out[0] = type;
  out[1] = data.length & 0xff;
  out[2] = (data.length >> 8) & 0xff;
  out[3] = (data.length >> 16) & 0xff;
  out.set(data, 4);
  return out;
}

function withCrc(crc: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, crc, true);
  out.set(payload, 4);
  return out;
}

/** An uncompressed data chunk (type 0x01) holding `data`. */
export function uncompressedChunk(data: Uint8Array, crc = maskedCrc(data)): Uint8Array {
  return chunk(0x01, withCrc(crc, data));
}

/** A compressed data chunk (type 0x00): `block` is a raw snappy block of `data`. */
export function compressedChunk(block: Uint8Array, data: Uint8Array, crc = maskedCrc(data)): Uint8Array {
  return chunk(0x00, withCrc(crc, block));
}

export interface ParsedChunk {
  type: number;
  offset: number;
  /** Offset just past the chunk. */
  end: number;
  data: Uint8Array;
}

/** Splits a framed stream into chunks. Throws if it is not well-formed at the chunk level. */
export function parseChunks(stream: Uint8Array): ParsedChunk[] {
  const chunks: ParsedChunk[] = [];
  for (let offset = 0; offset < stream.length; ) {
    if (stream.length - offset < 4) throw new Error(`partial chunk header at ${offset}`);
    const length = stream[offset + 1]! | (stream[offset + 2]! << 8) | (stream[offset + 3]! << 16);
    const end = offset + 4 + length;
    if (end > stream.length) throw new Error(`chunk at ${offset} runs past the end`);
    chunks.push({ type: stream[offset]!, offset, end, data: stream.subarray(offset + 4, end) });
    offset = end;
  }
  return chunks;
}

// ---- streams and errors -----------------------------------------------------

/** Runs bytes through a TransformStream, writing them in the given chunk sizes. */
export async function pipeChunks(
  stream: TransformStream<Uint8Array, Uint8Array>,
  data: Uint8Array,
  chunkSizes: (i: number) => number = () => 65536,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const reading = (async () => {
    for await (const part of stream.readable as unknown as AsyncIterable<Uint8Array>) parts.push(part);
  })();
  const writer = stream.writable.getWriter();
  try {
    for (let offset = 0, i = 0; offset < data.length; i++) {
      const size = Math.max(1, chunkSizes(i));
      await writer.write(data.subarray(offset, offset + size));
      offset += size;
    }
    await writer.close();
  } catch (error) {
    await reading.catch(() => {});
    throw error;
  }
  await reading;
  return concat(...parts);
}

/** Resolves to the SnappyError code thrown by fn, or 'no error'. */
export async function errorCode(fn: () => unknown): Promise<string> {
  try {
    await fn();
    return 'no error';
  } catch (error) {
    return (error as { code?: string }).code ?? `uncoded ${String(error)}`;
  }
}

export function syncErrorCode(fn: () => unknown): string {
  try {
    fn();
    return 'no error';
  } catch (error) {
    return (error as { code?: string }).code ?? `uncoded ${String(error)}`;
  }
}
