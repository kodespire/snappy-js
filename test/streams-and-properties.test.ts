import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  backends,
  chunk,
  compressedChunk,
  concat,
  errorCode,
  pipeChunks,
  randomBytes,
  STREAM_IDENTIFIER,
  textBytes,
  uncompressedChunk,
} from './helpers.js';

const framed = { format: 'framed' } as const;

describe.each(backends)('%s backend: streams', (_name, z) => {
  it('compress stream output is byte-identical to one-shot framed output, however the input is split', async () => {
    // Chunks always hold 64 KiB of input, so the split never shows in the output.
    const src = concat(textBytes(500_000, 21), randomBytes(200_000, 21));
    const oneShot = z.compressSync(src, framed);
    for (const size of [1_000, 65_535, 65_536, 65_537, 300_000, 2_000_000]) {
      expect(await pipeChunks(z.createCompressStream(), src, () => size), `chunk ${size}`).toEqual(oneShot);
    }
    expect(await pipeChunks(z.createCompressStream(), src, (i) => [1, 7, 65_535, 3, 100_000][i % 5]!)).toEqual(oneShot);
  });

  it('decompress stream handles input split at every kind of boundary', async () => {
    const src = textBytes(400_000, 22);
    const stream = z.compressSync(src, { format: 'framed', level: 2 });
    for (const size of [1, 3, 4, 10, 4096, 65_536, stream.length]) {
      expect(await pipeChunks(z.createDecompressStream(), stream, () => size), `chunk ${size}`).toEqual(src);
    }
  });

  it('decompress stream skips padding and skippable chunks split across writes', async () => {
    const a = textBytes(100_000, 1);
    const b = randomBytes(5_000, 2);
    const stream = concat(z.compressSync(a, framed), chunk(0xfe, new Uint8Array(70_000)), chunk(0x85, randomBytes(10, 3)), uncompressedChunk(b));
    expect(await pipeChunks(z.createDecompressStream(), stream, () => 999)).toEqual(concat(a, b));
    expect(await pipeChunks(z.createDecompressStream(), stream, () => 1)).toEqual(concat(a, b));
  });

  it('decompress stream handles concatenated streams split mid-chunk', async () => {
    const a = textBytes(100_000, 1);
    const b = randomBytes(50_000, 2);
    const data = concat(z.compressSync(a, framed), z.compressSync(b, framed));
    expect(await pipeChunks(z.createDecompressStream(), data, () => 999)).toEqual(concat(a, b));
  });

  it('decompress stream errors on input that ends mid-chunk', async () => {
    const stream = z.compressSync(textBytes(100_000, 3), framed);
    expect(await errorCode(() => pipeChunks(z.createDecompressStream(), stream.subarray(0, stream.length - 1)))).toBe('ERR_SNAPPY_TRUNCATED');
    expect(await errorCode(() => pipeChunks(z.createDecompressStream(), STREAM_IDENTIFIER.subarray(0, 4), () => 1))).toBe('ERR_SNAPPY_TRUNCATED');
  });

  it('decompress stream with no input at all is an empty stream', async () => {
    expect(await pipeChunks(z.createDecompressStream(), new Uint8Array(0))).toEqual(new Uint8Array(0));
  });

  it('compress stream with no input writes just the stream identifier', async () => {
    expect(await pipeChunks(z.createCompressStream(), new Uint8Array(0))).toEqual(STREAM_IDENTIFIER);
  });

  it('decompress stream enforces maxOutputSize across chunks', async () => {
    const stream = z.compressSync(new Uint8Array(5 << 20), framed);
    expect(await errorCode(() => pipeChunks(z.createDecompressStream({ maxOutputSize: 1 << 20 }), stream, () => 10)))
      .toBe('ERR_SNAPPY_OUTPUT_LIMIT');
    expect((await pipeChunks(z.createDecompressStream({ maxOutputSize: 5 << 20 }), stream, () => 10)).length).toBe(5 << 20);
  });

  it('decompress stream errors on corrupt input, and on input that is not framed', async () => {
    const stream = z.compressSync(textBytes(100_000, 4), framed);
    stream[stream.length >> 1]! ^= 0xff;
    expect(await errorCode(() => pipeChunks(z.createDecompressStream(), stream))).toBe('ERR_SNAPPY_CORRUPT');
    expect(await errorCode(() => pipeChunks(z.createDecompressStream(), z.compressSync(textBytes(1000, 4))))).toBe('ERR_SNAPPY_CORRUPT');
  });

  it('cancelling a stream while a chunk is being processed is clean', async () => {
    const big = textBytes(8 << 20, 31);
    const stream = z.compressSync(big, framed);
    const cases: [TransformStream<Uint8Array, Uint8Array>, Uint8Array][] = [
      [z.createCompressStream(2), big],
      [z.createDecompressStream(), stream],
    ];
    for (const [s, input] of cases) {
      // transform() only runs once the readable side has demand, so read first.
      const reader = s.readable.getReader();
      const read = reader.read().catch(() => {});
      const pending = s.writable.getWriter().write(input).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 5)); // the push is now in flight
      await expect(reader.cancel('stop')).resolves.toBeUndefined();
      await Promise.all([read, pending]);
    }
    // The backend still works afterwards.
    expect(z.decompressSync(z.compressSync('after cancel'))).toEqual(new TextEncoder().encode('after cancel'));
  });

  it('many concurrent async calls return the right results', async () => {
    const inputs = Array.from({ length: 64 }, (_, i) => textBytes(20_000 + i * 997, i));
    const formats = (i: number) => (i % 2 ? 'raw' : 'framed') as 'raw' | 'framed';
    const packed = await Promise.all(inputs.map((src, i) => z.compress(src, { level: (i % 2) + 1, format: formats(i) })));
    const outputs = await Promise.all(packed.map((p, i) => z.decompress(p, { format: formats(i) })));
    outputs.forEach((out, i) => expect(out).toEqual(inputs[i]));
  });
});

describe.each(backends)('%s backend: properties', (_name, z) => {
  const formatArb = fc.constantFrom('raw' as const, 'framed' as const);

  it('decompress(compress(x)) === x for arbitrary bytes, levels and formats', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 20_000 }), fc.integer({ min: 1, max: 2 }), formatArb, (src, level, format) => {
        expect(z.decompressSync(z.compressSync(src, { level, format }), { format })).toEqual(src);
      }),
      { numRuns: 300 },
    );
  });

  it('chunked streaming matches one-shot for arbitrary splits', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 1, maxLength: 200_000 }).map((a) => a.map((b, i) => (i % 4 ? b & 0x0f : b))),
        fc.array(fc.integer({ min: 1, max: 70_000 }), { minLength: 1, maxLength: 20 }),
        async (src, sizes) => {
          const stream = await pipeChunks(z.createCompressStream(), src, (i) => sizes[i % sizes.length]!);
          expect(stream).toEqual(z.compressSync(src, framed));
          const out = await pipeChunks(z.createDecompressStream(), stream, (i) => sizes[(i + 1) % sizes.length]!);
          expect(out).toEqual(src);
        },
      ),
      { numRuns: 40 },
    );
  });

  it('arbitrary input never crashes the decoder or yields output of the wrong size', () => {
    const header = (n: number) => {
      const out: number[] = [];
      for (; n >= 0x80; n >>>= 7) out.push((n & 0x7f) | 0x80);
      return [...out, n];
    };
    fc.assert(
      fc.property(
        fc.oneof(
          fc.uint8Array({ maxLength: 300 }),
          // Plausible raw blocks: a small length header, then random elements.
          fc.tuple(fc.integer({ min: 0, max: 400 }), fc.uint8Array({ maxLength: 300 })).map(([n, rest]) => new Uint8Array([...header(n), ...rest])),
          // Plausible framed streams: the stream identifier, then random chunks.
          fc.uint8Array({ maxLength: 300 }).map((rest) => concat(STREAM_IDENTIFIER, rest)),
        ),
        formatArb,
        (data, format) => {
          try {
            const out = z.decompressSync(data, { format });
            if (format === 'raw') expect(out.length).toBe(z.getUncompressedLength(data));
          } catch (error) {
            expect(['ERR_SNAPPY_CORRUPT', 'ERR_SNAPPY_TRUNCATED']).toContain((error as { code?: string }).code);
          }
        },
      ),
      { numRuns: 3000 },
    );
  });

  it('a damaged framed stream either errors or decodes to the original data', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1, maxLength: 5_000 }).map((a) => a.map((b, i) => (i % 3 ? b & 0x07 : b))),
        fc.integer({ min: 0 }),
        fc.integer({ min: 1, max: 255 }),
        (src, where, xor) => {
          const stream = z.compressSync(src, framed);
          stream[where % stream.length]! ^= xor;
          try {
            const out = z.decompressSync(stream, framed);
            // Undetectable only when the damage cannot matter: the bytes still decode to
            // the same data, or a data chunk's type byte became a skippable type.
            if (out.length === src.length) expect(out).toEqual(src);
            else expect(stream[where % stream.length]!).toBeGreaterThanOrEqual(0x80);
          } catch (error) {
            expect(['ERR_SNAPPY_CORRUPT', 'ERR_SNAPPY_TRUNCATED']).toContain((error as { code?: string }).code);
          }
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe('native and wasm agree', () => {
  const [[, native], [, wasm]] = backends;

  it('produce byte-identical output, so a payload does not depend on the platform', async () => {
    // csrc/snappy-config/config.h keeps the hardware-CRC hash options off for this.
    const inputs = [textBytes(300_000, 50), randomBytes(100_000, 51), new Uint8Array(200_000), concat(textBytes(70_000, 52), randomBytes(70_000, 53))];
    for (const src of inputs) {
      for (const level of [1, 2]) {
        for (const format of ['raw', 'framed'] as const) {
          const a = native.compressSync(src, { level, format });
          expect(wasm.compressSync(src, { level, format })).toEqual(a);
          expect(wasm.decompressSync(a, { format })).toEqual(src);
          expect(native.decompressSync(wasm.compressSync(src, { level, format }), { format })).toEqual(src);
        }
        const streamed = await pipeChunks(native.createCompressStream({ level }), src, () => 50_000);
        expect(await pipeChunks(wasm.createCompressStream({ level }), src, () => 77_777)).toEqual(streamed);
        expect(await pipeChunks(wasm.createDecompressStream(), streamed, () => 1234)).toEqual(src);
      }
    }
  });

  it('accept and reject exactly the same input', () => {
    // Elements with extreme length and offset fields, where 32-bit (wasm) and
    // 64-bit arithmetic could disagree.
    const u32 = fc.oneof(fc.constantFrom(0, 1, 0x7fffffff, 0xfffffffe, 0xffffffff), fc.nat({ max: 0xffffffff }));
    const le = (v: number, n: number) => Array.from({ length: n }, (_, i) => Math.floor(v / 2 ** (8 * i)) & 0xff);
    const element = fc.oneof(
      fc.tuple(fc.integer({ min: 1, max: 4 }), u32).map(([n, v]) => [((59 + n) << 2) | 0, ...le(v, n)]), // long literal
      fc.tuple(fc.integer({ min: 0, max: 63 }), u32).map(([len, v]) => [(len << 2) | 3, ...le(v, 4)]), // copy, 4-byte offset
      fc.tuple(fc.integer({ min: 0, max: 63 }), fc.nat({ max: 0xffff })).map(([len, v]) => [(len << 2) | 2, ...le(v, 2)]),
      fc.uint8Array({ minLength: 1, maxLength: 8 }).map((a) => [...a]),
    );
    const block = fc.tuple(u32, fc.array(element, { maxLength: 6 })).map(([n, parts]) => {
      const header: number[] = [];
      for (let v = n; ; v = Math.floor(v / 128)) {
        if (v < 128) {
          header.push(v);
          break;
        }
        header.push((v & 0x7f) | 0x80);
      }
      return new Uint8Array([...header, ...parts.flat()]);
    });
    const outcome = (z: typeof native, data: Uint8Array, format: 'raw' | 'framed') => {
      try {
        return Array.from(z.decompressSync(data, { format, maxOutputSize: 1 << 20 })).join(',');
      } catch (error) {
        return (error as { code?: string }).code ?? String(error);
      }
    };
    fc.assert(
      fc.property(block, (data) => {
        const raw = outcome(native, data, 'raw');
        expect(outcome(wasm, data, 'raw')).toBe(raw);
        // The same block as a compressed chunk, with the right checksum when it decodes.
        let decoded = new Uint8Array(0);
        try {
          decoded = native.decompressSync(data, { maxOutputSize: 1 << 20 });
        } catch {}
        const stream = concat(STREAM_IDENTIFIER, compressedChunk(data, decoded));
        expect(outcome(wasm, stream, 'framed')).toBe(outcome(native, stream, 'framed'));
      }),
      { numRuns: 5000 },
    );
  });

  it('report the same snappy version', () => {
    expect(native.SNAPPY_VERSION).toBe(wasm.SNAPPY_VERSION);
  });
});
