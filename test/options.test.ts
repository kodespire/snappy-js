import { describe, expect, it } from 'vitest';

import { backends, fixture, pipeChunks, STREAM_IDENTIFIER, syncErrorCode, textBytes } from './helpers.js';

describe.each(backends)('%s backend: options', (_name, z) => {
  const corpus = new Uint8Array(fixture('corpus.txt'));

  it('level 2 compresses denser than level 1, and both decode', () => {
    for (const format of ['raw', 'framed'] as const) {
      const one = z.compressSync(corpus, { level: 1, format });
      const two = z.compressSync(corpus, { level: 2, format });
      expect(two.length).toBeLessThan(one.length);
      expect(z.decompressSync(one, { format })).toEqual(corpus);
      expect(z.decompressSync(two, { format })).toEqual(corpus);
    }
  });

  it('the level shorthand matches the options form, and the default is level 1, raw', async () => {
    expect(z.compressSync(corpus, 2)).toEqual(z.compressSync(corpus, { level: 2 }));
    expect(await z.compress(corpus, 2)).toEqual(z.compressSync(corpus, { level: 2 }));
    expect(z.compressSync(corpus)).toEqual(z.compressSync(corpus, { level: 1, format: 'raw' }));
    expect(z.DEFAULT_LEVEL).toBe(1);
  });

  it('the level reaches streaming compression too', async () => {
    const one = await pipeChunks(z.createCompressStream(), corpus);
    const two = await pipeChunks(z.createCompressStream({ level: 2 }), corpus);
    expect(two.length).toBeLessThan(one.length);
    expect(await pipeChunks(z.createCompressStream(2), corpus)).toEqual(two);
  });

  it('format selects raw blocks or framed streams, and must match on decompression', () => {
    const raw = z.compressSync(corpus);
    const framed = z.compressSync(corpus, { format: 'framed' });
    expect(z.isSnappyFramed(raw)).toBe(false);
    expect(z.isSnappyFramed(framed)).toBe(true);
    expect(z.getUncompressedLength(raw)).toBe(corpus.length);
    expect(syncErrorCode(() => z.decompressSync(raw, { format: 'framed' }))).toBe('ERR_SNAPPY_CORRUPT');
    expect(syncErrorCode(() => z.decompressSync(framed))).not.toBe('no error');
  });

  it('accepts every binary input type', () => {
    const src = textBytes(10_000);
    const block = z.compressSync(src);
    const padded = new Uint8Array(block.length + 10);
    padded.set(block, 5);
    const inputs: unknown[] = [
      block,
      Buffer.from(block),
      block.buffer.slice(block.byteOffset, block.byteOffset + block.byteLength),
      padded.subarray(5, 5 + block.length),
      new DataView(padded.buffer, 5, block.length),
    ];
    for (const input of inputs) expect(z.decompressSync(input as Uint8Array)).toEqual(src);
    expect(z.decompressSync(z.compressSync('héllo ✓'))).toEqual(new TextEncoder().encode('héllo ✓'));
  });

  it('results are plain Uint8Arrays, not Buffers', async () => {
    for (const out of [z.compressSync('abc'), await z.compress('abc'), z.decompressSync(z.compressSync('abc'))]) {
      expect(Object.getPrototypeOf(out)).toBe(Uint8Array.prototype);
    }
  });

  it('rejects unknown option names instead of ignoring them', () => {
    expect(() => z.compressSync('x', { compressionLevel: 2 } as never)).toThrow(/unknown option "compressionLevel".*Did you mean "level"/);
    expect(() => z.compressSync('x', { framed: true } as never)).toThrow(/unknown option "framed".*Did you mean "format"/);
    expect(() => z.decompressSync(z.compressSync('x'), { maxOutput: 10 } as never)).toThrow(/unknown option "maxOutput".*Did you mean "maxOutputSize"/);
    expect(() => z.createCompressStream({ checksum: true } as never)).toThrow(/unknown option "checksum"/);
    expect(() => z.createDecompressStream({ level: 1 } as never)).toThrow(/unknown option "level"/);
  });

  it('validates option values', () => {
    expect(() => z.compressSync('x', { level: 0 })).toThrow(RangeError);
    expect(() => z.compressSync('x', { level: 3 })).toThrow(RangeError);
    expect(() => z.compressSync('x', { level: 1.5 })).toThrow(RangeError);
    expect(() => z.compressSync('x', { level: '1' as never })).toThrow(RangeError);
    expect(() => z.compressSync('x', { format: 'sz' as never })).toThrow(TypeError);
    expect(() => z.decompressSync(new Uint8Array(1), { format: 'Framed' as never })).toThrow(TypeError);
    expect(() => z.decompressSync(new Uint8Array(1), { maxOutputSize: -1 })).toThrow(RangeError);
    expect(() => z.decompressSync(new Uint8Array(1), { maxOutputSize: 1.5 })).toThrow(RangeError);
    expect(() => z.decompressSync('abc' as never)).toThrow(TypeError);
    expect(() => z.compressSync(123 as never)).toThrow(TypeError);
    expect(() => z.compressSync('x', null as never)).toThrow(TypeError);
  });

  it('streams are framed only: format "framed" is accepted, "raw" is not', async () => {
    const src = textBytes(1000, 1);
    const stream = await pipeChunks(z.createCompressStream({ format: 'framed' }), src);
    expect(await pipeChunks(z.createDecompressStream({ format: 'framed' }), stream)).toEqual(src);
    expect(() => z.createCompressStream({ format: 'raw' } as never)).toThrow(/streams always use the framing format/);
    expect(() => z.createDecompressStream({ format: 'raw' } as never)).toThrow(/streams always use the framing format/);
  });

  it('getUncompressedLength and isSnappyFramed', () => {
    expect(z.getUncompressedLength(z.compressSync(new Uint8Array(0)))).toBe(0);
    expect(z.getUncompressedLength(new Uint8Array([0xfe, 0xff, 0xff, 0xff, 0x0f]))).toBe(0xfffffffe);
    expect(syncErrorCode(() => z.getUncompressedLength(new Uint8Array(0)))).toBe('ERR_SNAPPY_TRUNCATED');
    expect(syncErrorCode(() => z.getUncompressedLength(new Uint8Array([0x80, 0x80])))).toBe('ERR_SNAPPY_TRUNCATED');
    expect(syncErrorCode(() => z.getUncompressedLength(new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80])))).toBe('ERR_SNAPPY_CORRUPT');
    expect(z.isSnappyFramed(STREAM_IDENTIFIER)).toBe(true);
    expect(z.isSnappyFramed(STREAM_IDENTIFIER.subarray(0, 9))).toBe(false);
    expect(z.isSnappyFramed(corpus)).toBe(false);
  });

  it('constants', () => {
    expect([z.MIN_LEVEL, z.MAX_LEVEL, z.DEFAULT_LEVEL]).toEqual([1, 2, 1]);
    for (const level of [z.MIN_LEVEL, z.MAX_LEVEL]) {
      expect(z.decompressSync(z.compressSync(corpus, { level }))).toEqual(corpus);
    }
  });
});
