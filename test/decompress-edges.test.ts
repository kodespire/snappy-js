// The decompression paths are where snappy bindings usually go wrong: output that
// fills a buffer exactly, chunk boundaries, untrusted length headers, and input that
// ends early. Every case runs on both backends and, where it applies, both formats.
import { describe, expect, it } from 'vitest';

import {
  backends,
  chunk,
  compressedChunk,
  concat,
  errorCode,
  maskedCrc,
  parseChunks,
  pipeChunks,
  randomBytes,
  STREAM_IDENTIFIER,
  syncErrorCode,
  textBytes,
  uncompressedChunk,
  type Snappy,
} from './helpers.js';

// Sizes around snappy's 64 KiB fragment and the framing format's 64 KiB chunk,
// and the 1.5x growth steps of the output buffer.
const BOUNDARY_SIZES = [
  0, 1, 2, 65535, 65536, 65537, 98303, 98304, 98305, 131071, 131072, 131073,
  196607, 196608, 196609, 262143, 262144, 262145, 1 << 20, (1 << 20) + 1,
];

const FORMATS = ['raw', 'framed'] as const;

/** A raw block declaring `length` bytes, followed by `rest`. */
function rawHeader(length: number, rest: number[] = []): Uint8Array {
  const out: number[] = [];
  let v = length;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return new Uint8Array([...out, ...rest]);
}

/** Expected decoded output after each complete chunk of a framed stream. */
function decodedPrefixes(z: Snappy, stream: Uint8Array): Map<number, Uint8Array> {
  const prefixes = new Map<number, Uint8Array>([[0, new Uint8Array(0)]]);
  let out = new Uint8Array(0);
  for (const c of parseChunks(stream)) {
    if (c.type === 0x00) out = concat(out, z.decompressSync(c.data.subarray(4)));
    if (c.type === 0x01) out = concat(out, c.data.subarray(4));
    prefixes.set(c.end, out);
  }
  return prefixes;
}

describe.each(backends)('%s backend: decompression edge cases', (name, z) => {
  it('reports the expected backend', () => {
    expect(z.activeBackend()).toBe(name);
  });

  it.each(BOUNDARY_SIZES)('raw block, %i bytes', async (size) => {
    const src = textBytes(size, size + 1);
    const block = z.compressSync(src);
    expect(z.getUncompressedLength(block)).toBe(size);
    expect(z.decompressSync(block)).toEqual(src);
    expect(await z.decompress(block)).toEqual(src);
    // A limit equal to the exact size must pass; one byte less must not.
    expect(z.decompressSync(block, { maxOutputSize: size })).toEqual(src);
    if (size > 0) expect(syncErrorCode(() => z.decompressSync(block, { maxOutputSize: size - 1 }))).toBe('ERR_SNAPPY_OUTPUT_LIMIT');
  });

  it.each(BOUNDARY_SIZES)('framed stream, %i bytes', async (size) => {
    const src = randomBytes(size, size + 7).map((b, i) => (i % 3 === 0 ? b : 0x61)); // partly compressible
    const stream = z.compressSync(src, { format: 'framed' });
    expect(z.decompressSync(stream, { format: 'framed' })).toEqual(src);
    expect(await z.decompress(stream, { format: 'framed', maxOutputSize: size })).toEqual(src);
    if (size > 0) {
      expect(syncErrorCode(() => z.decompressSync(stream, { format: 'framed', maxOutputSize: size - 1 }))).toBe('ERR_SNAPPY_OUTPUT_LIMIT');
    }
    // Chunks hold 64 KiB of input each, except the last.
    const dataChunks = parseChunks(stream).filter((c) => c.type <= 1);
    expect(dataChunks.length).toBe(Math.ceil(size / 65536));
  });

  it('highly compressible input: 64 MiB of zeros', async () => {
    const src = new Uint8Array(64 << 20);
    for (const format of FORMATS) {
      const packed = await z.compress(src, { format });
      expect(packed.length).toBeLessThan(4 << 20);
      const out = await z.decompress(packed, { format });
      expect(out.length).toBe(src.length);
      expect(out.every((b) => b === 0)).toBe(true);
    }
  });

  it('empty input compresses to a 1-byte block or a bare stream identifier', () => {
    expect(z.compressSync(new Uint8Array(0))).toEqual(new Uint8Array([0]));
    expect(z.compressSync(new Uint8Array(0), { format: 'framed' })).toEqual(STREAM_IDENTIFIER);
    expect(z.decompressSync(new Uint8Array([0]))).toEqual(new Uint8Array(0));
    expect(z.decompressSync(STREAM_IDENTIFIER, { format: 'framed' })).toEqual(new Uint8Array(0));
  });
});

describe.each(backends)('%s backend: raw blocks, truncated and invalid', (_name, z) => {
  it('empty input is an error: a raw block always has a length header', async () => {
    expect(syncErrorCode(() => z.decompressSync(new Uint8Array(0)))).toBe('ERR_SNAPPY_TRUNCATED');
    expect(await errorCode(() => z.decompress(new Uint8Array(0)))).toBe('ERR_SNAPPY_TRUNCATED');
  });

  it('every proper prefix of a block is rejected as truncated', () => {
    for (const [label, src] of [['text', textBytes(3000, 9)], ['random', randomBytes(700, 9)], ['long', textBytes(70_000, 9).subarray(0, 1500)]] as const) {
      for (const level of [1, 2]) {
        const block = z.compressSync(src, { level });
        for (let cut = 0; cut < block.length; cut++) {
          const code = syncErrorCode(() => z.decompressSync(block.subarray(0, cut)));
          expect(code, `${label}, level ${level}: cut at ${cut}/${block.length}`).toBe('ERR_SNAPPY_TRUNCATED');
        }
        expect(z.decompressSync(block)).toEqual(src);
      }
    }
  });

  it('truncating a large block is rejected (sampled offsets)', async () => {
    const src = textBytes(3 << 20, 10);
    const block = await z.compress(src);
    for (const cut of [1, 2, 3, 4, 5, 100, block.length >> 2, block.length >> 1, block.length - 5, block.length - 2, block.length - 1]) {
      expect(await errorCode(() => z.decompress(block.subarray(0, cut))), `cut at ${cut}`).toBe('ERR_SNAPPY_TRUNCATED');
    }
  });

  it('regression: 1 MB of zeros with the last 3 bytes cut is an error, not partial output', async () => {
    const block = await z.compress(new Uint8Array(1_000_000));
    expect(await errorCode(() => z.decompress(block.subarray(0, block.length - 3)))).toBe('ERR_SNAPPY_TRUNCATED');
  });

  it('a damaged block never decodes to the wrong length', () => {
    // Raw blocks have no checksum: damage inside literal bytes decodes to wrong bytes,
    // as with any snappy decoder. Damage anywhere else must be caught, and nothing may
    // ever come back shorter or longer than the header says.
    const src = textBytes(200_000, 11);
    const block = z.compressSync(src);
    let rejected = 0;
    for (let i = 0; i < block.length; i += 97) {
      const bad = block.slice();
      bad[i]! ^= 0x5a;
      try {
        const out = z.decompressSync(bad);
        expect(out.length, `flip at ${i}`).toBe(z.getUncompressedLength(bad));
      } catch (error) {
        expect(['ERR_SNAPPY_CORRUPT', 'ERR_SNAPPY_TRUNCATED'], `flip at ${i}`).toContain((error as { code: string }).code);
        rejected++;
      }
    }
    expect(rejected).toBeGreaterThan(50);
  });

  it('trailing bytes after a complete block are rejected', () => {
    const block = z.compressSync(textBytes(1000, 1));
    expect(syncErrorCode(() => z.decompressSync(concat(block, new Uint8Array([0]))))).toBe('ERR_SNAPPY_CORRUPT');
  });

  it('invalid elements and headers are corrupt, not truncated', () => {
    expect(syncErrorCode(() => z.decompressSync(new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80, 0x01])))).toBe('ERR_SNAPPY_CORRUPT'); // 6-byte varint
    expect(syncErrorCode(() => z.decompressSync(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x10])))).toBe('ERR_SNAPPY_CORRUPT'); // over 32 bits
    expect(syncErrorCode(() => z.decompressSync(rawHeader(4, [0x01, 0x00])))).toBe('ERR_SNAPPY_CORRUPT'); // copy, nothing to copy from
    expect(syncErrorCode(() => z.decompressSync(rawHeader(8, [0x00, 0x61, 0x01, 0x00])))).toBe('ERR_SNAPPY_CORRUPT'); // offset 0
    expect(syncErrorCode(() => z.decompressSync(rawHeader(1, [0x04, 0x61, 0x62])))).toBe('ERR_SNAPPY_CORRUPT'); // literal past the end
    expect(syncErrorCode(() => z.decompressSync(rawHeader(2, [0x04, 0x61])))).toBe('ERR_SNAPPY_TRUNCATED'); // literal cut short
    expect(syncErrorCode(() => z.decompressSync(new TextEncoder().encode('definitely not snappy')))).not.toBe('no error');
  });

  it('regression: a 2^32-byte literal length is rejected in WebAssembly too', () => {
    // A literal whose 4-byte length field is 0xffffffff means 2^32 bytes. snappy
    // relies on a 64-bit size_t to reject it; in wasm32 it wraps to 0 and snappy
    // alone would accept the block below as the single byte "a".
    const block = rawHeader(1, [0xfc, 0xff, 0xff, 0xff, 0xff, 0x00, 0x61]);
    expect(syncErrorCode(() => z.decompressSync(block))).toBe('ERR_SNAPPY_CORRUPT');
    const a = new TextEncoder().encode('a');
    expect(syncErrorCode(() => z.decompressSync(concat(STREAM_IDENTIFIER, compressedChunk(block, a)), { format: 'framed' }))).toBe('ERR_SNAPPY_CORRUPT');
    // The largest representable literal length is still parsed, and rejected as too long.
    expect(syncErrorCode(() => z.decompressSync(rawHeader(1, [0xfc, 0xfe, 0xff, 0xff, 0xff, 0x61])))).toBe('ERR_SNAPPY_CORRUPT');
  });

  it('a lying length header is caught before anything is allocated', async () => {
    // 5 bytes claiming 4 GiB - 1 of output.
    const liar = rawHeader(0xffffffff, [0x00, 0x61]);
    expect(z.getUncompressedLength(liar)).toBe(0xffffffff);
    const started = performance.now();
    expect(await errorCode(() => z.decompress(liar, { maxOutputSize: 10 << 20 }))).toBe('ERR_SNAPPY_OUTPUT_LIMIT');
    // With no limit, validation runs before allocation and fails fast.
    expect(await errorCode(() => z.decompress(liar))).toBe('ERR_SNAPPY_TRUNCATED');
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('maxOutputSize stops a decompression bomb before decoding', async () => {
    const bomb = await z.compress(new Uint8Array(256 << 20));
    expect(bomb.length).toBeLessThan(13 << 20);
    const started = performance.now();
    expect(await errorCode(() => z.decompress(bomb, { maxOutputSize: 10 << 20 }))).toBe('ERR_SNAPPY_OUTPUT_LIMIT');
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('maxOutputSize: 0 accepts only empty output', () => {
    expect(z.decompressSync(z.compressSync(new Uint8Array(0)), { maxOutputSize: 0 })).toEqual(new Uint8Array(0));
    expect(syncErrorCode(() => z.decompressSync(z.compressSync('x'), { maxOutputSize: 0 }))).toBe('ERR_SNAPPY_OUTPUT_LIMIT');
  });
});

describe.each(backends)('%s backend: framed streams, truncated and invalid', (_name, z) => {
  const framed = { format: 'framed' } as const;
  const decodeFramed = (data: Uint8Array) => z.decompressSync(data, framed);

  it('empty input is a valid empty stream (Go and Rust encoders write it), unlike raw', async () => {
    expect(decodeFramed(new Uint8Array(0))).toEqual(new Uint8Array(0));
    expect(await z.decompress(new Uint8Array(0), framed)).toEqual(new Uint8Array(0));
  });

  it('a cut is an error unless it falls between chunks, which the format cannot detect', () => {
    // Several streams joined, with padding and skippable chunks: many kinds of boundary.
    const a = textBytes(3000, 1);
    const b = randomBytes(700, 2);
    const c = textBytes(2000, 3);
    const stream = concat(
      z.compressSync(a, framed),
      chunk(0xfe, new Uint8Array(5)),
      uncompressedChunk(b),
      chunk(0x80, new TextEncoder().encode('skip me')),
      z.compressSync(c, { format: 'framed', level: 2 }),
      chunk(0xfd, new Uint8Array(0)),
    );
    const prefixes = decodedPrefixes(z, stream);
    expect(prefixes.size).toBe(9); // offset 0 and the end of each of the 8 chunks
    expect(prefixes.get(stream.length)).toEqual(concat(a, b, c));
    for (let cut = 0; cut <= stream.length; cut++) {
      const expected = prefixes.get(cut);
      const label = `cut at ${cut}/${stream.length}`;
      if (expected) expect(decodeFramed(stream.subarray(0, cut)), label).toEqual(expected);
      else expect(syncErrorCode(() => decodeFramed(stream.subarray(0, cut))), label).toBe('ERR_SNAPPY_TRUNCATED');
    }
  });

  it('a partial stream identifier is truncated; a wrong one is corrupt at once', () => {
    for (let cut = 1; cut < STREAM_IDENTIFIER.length; cut++) {
      expect(syncErrorCode(() => decodeFramed(STREAM_IDENTIFIER.subarray(0, cut)))).toBe('ERR_SNAPPY_TRUNCATED');
    }
    expect(syncErrorCode(() => decodeFramed(new TextEncoder().encode('abc')))).toBe('ERR_SNAPPY_CORRUPT');
    expect(syncErrorCode(() => decodeFramed(new TextEncoder().encode('\xff\x06\x00\x00sNa')))).toBe('ERR_SNAPPY_CORRUPT');
    expect(syncErrorCode(() => decodeFramed(chunk(0xff, new TextEncoder().encode('snappy'))))).toBe('ERR_SNAPPY_CORRUPT');
    expect(syncErrorCode(() => decodeFramed(chunk(0xff, new TextEncoder().encode('sNaPpY!'))))).toBe('ERR_SNAPPY_CORRUPT');
  });

  it('the first chunk must be the stream identifier', () => {
    const data = textBytes(100, 1);
    expect(syncErrorCode(() => decodeFramed(uncompressedChunk(data)))).toBe('ERR_SNAPPY_CORRUPT');
    expect(syncErrorCode(() => decodeFramed(concat(chunk(0xfe, new Uint8Array(4)), STREAM_IDENTIFIER)))).toBe('ERR_SNAPPY_CORRUPT');
    // A raw block is not a framed stream.
    expect(syncErrorCode(() => decodeFramed(z.compressSync(data)))).toBe('ERR_SNAPPY_CORRUPT');
  });

  it('repeated stream identifiers are ignored only when exact', () => {
    const data = textBytes(500, 4);
    expect(decodeFramed(concat(STREAM_IDENTIFIER, STREAM_IDENTIFIER, uncompressedChunk(data), STREAM_IDENTIFIER))).toEqual(data);
    const bad = concat(STREAM_IDENTIFIER, uncompressedChunk(data), chunk(0xff, new TextEncoder().encode('SNAPPY')));
    expect(syncErrorCode(() => decodeFramed(bad))).toBe('ERR_SNAPPY_CORRUPT');
  });

  it('padding and reserved skippable chunks are skipped wherever they appear', () => {
    const a = textBytes(5000, 3);
    const b = randomBytes(7000, 4);
    const stream = concat(
      STREAM_IDENTIFIER,
      chunk(0xfe, new Uint8Array(0)),
      compressedChunk(z.compressSync(a), a),
      chunk(0x80, randomBytes(100_000, 5)), // skippable chunks can be large
      chunk(0xfe, new Uint8Array(13)),
      uncompressedChunk(b),
      chunk(0xfd, new Uint8Array([1, 2, 3])),
    );
    expect(decodeFramed(stream)).toEqual(concat(a, b));
  });

  it('reserved unskippable chunks (0x02-0x7f) are rejected', () => {
    for (const type of [0x02, 0x10, 0x7f]) {
      const stream = concat(STREAM_IDENTIFIER, chunk(type, new Uint8Array(8)));
      expect(syncErrorCode(() => decodeFramed(stream)), `type ${type}`).toBe('ERR_SNAPPY_CORRUPT');
    }
  });

  it('checksum mismatches are rejected for compressed and uncompressed chunks', () => {
    const data = textBytes(2000, 6);
    const crc = maskedCrc(data) ^ 1;
    expect(syncErrorCode(() => decodeFramed(concat(STREAM_IDENTIFIER, uncompressedChunk(data, crc))))).toBe('ERR_SNAPPY_CORRUPT');
    expect(syncErrorCode(() => decodeFramed(concat(STREAM_IDENTIFIER, compressedChunk(z.compressSync(data), data, crc))))).toBe('ERR_SNAPPY_CORRUPT');
    // The checksum covers the uncompressed data, not the compressed bytes.
    expect(syncErrorCode(() => decodeFramed(concat(STREAM_IDENTIFIER, compressedChunk(z.compressSync(data), data, maskedCrc(z.compressSync(data))))))).toBe('ERR_SNAPPY_CORRUPT');
  });

  it('chunk sizes are limited to 64 KiB of data', () => {
    const full = randomBytes(65536, 7);
    expect(decodeFramed(concat(STREAM_IDENTIFIER, uncompressedChunk(full)))).toEqual(full);
    expect(decodeFramed(concat(STREAM_IDENTIFIER, compressedChunk(z.compressSync(full), full)))).toEqual(full);
    const over = randomBytes(65537, 7);
    expect(syncErrorCode(() => decodeFramed(concat(STREAM_IDENTIFIER, uncompressedChunk(over))))).toBe('ERR_SNAPPY_CORRUPT');
    expect(syncErrorCode(() => decodeFramed(concat(STREAM_IDENTIFIER, compressedChunk(z.compressSync(over), over))))).toBe('ERR_SNAPPY_CORRUPT');
    // Too long to be any encoding of 64 KiB: rejected from the header, before buffering.
    const huge = concat(STREAM_IDENTIFIER, chunk(0x00, new Uint8Array(200_000)).subarray(0, 4));
    expect(syncErrorCode(() => decodeFramed(huge))).toBe('ERR_SNAPPY_CORRUPT');
    // Data chunks need room for their checksum.
    expect(syncErrorCode(() => decodeFramed(concat(STREAM_IDENTIFIER, chunk(0x01, new Uint8Array(3)))))).toBe('ERR_SNAPPY_CORRUPT');
    expect(syncErrorCode(() => decodeFramed(concat(STREAM_IDENTIFIER, chunk(0x00, new Uint8Array(0)))))).toBe('ERR_SNAPPY_CORRUPT');
  });

  it('a corrupt block inside a chunk is corrupt, not truncated', () => {
    const data = textBytes(2000, 8);
    const block = z.compressSync(data);
    expect(syncErrorCode(() => decodeFramed(concat(STREAM_IDENTIFIER, compressedChunk(block.subarray(0, block.length - 1), data))))).toBe('ERR_SNAPPY_CORRUPT');
  });

  it('a damaged stream never decodes to wrong data', () => {
    // The checksums cover the decoded data, so damage is caught unless it leaves the
    // output unchanged (a copy offset moved to an identical earlier run, say).
    const src = textBytes(200_000, 11);
    const stream = z.compressSync(src, framed);
    let rejected = 0;
    let probes = 0;
    for (let i = 0; i < stream.length; i += Math.max(1, Math.floor(stream.length / 300))) {
      const bad = stream.slice();
      bad[i]! ^= 0x5a;
      probes++;
      try {
        expect(decodeFramed(bad), `flip at ${i}`).toEqual(src);
      } catch (error) {
        if (!(error as { code?: string }).code) throw error;
        expect(['ERR_SNAPPY_CORRUPT', 'ERR_SNAPPY_TRUNCATED'], `flip at ${i}`).toContain((error as { code: string }).code);
        rejected++;
      }
    }
    expect(rejected).toBeGreaterThan(probes * 0.9);
  });

  it('a stream cut inside its last chunk is rejected even though earlier chunks are complete', async () => {
    const stream = await z.compress(new Uint8Array(1_000_000), framed);
    expect(await errorCode(() => z.decompress(stream.subarray(0, stream.length - 3), framed))).toBe('ERR_SNAPPY_TRUNCATED');
  });

  it('maxOutputSize stops a decompression bomb early', async () => {
    // 256 MiB of zeros, compressed by streaming 16 MiB writes.
    const bomb = await pipeChunks(z.createCompressStream(), new Uint8Array(256 << 20), () => 16 << 20);
    expect(bomb.length).toBeLessThan(13 << 20);
    const started = performance.now();
    expect(await errorCode(() => z.decompress(bomb, { format: 'framed', maxOutputSize: 10 << 20 }))).toBe('ERR_SNAPPY_OUTPUT_LIMIT');
    expect(await errorCode(() => pipeChunks(z.createDecompressStream({ maxOutputSize: 10 << 20 }), bomb, () => 1 << 20))).toBe('ERR_SNAPPY_OUTPUT_LIMIT');
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it('maxOutputSize: 0 accepts only empty output', () => {
    expect(z.decompressSync(STREAM_IDENTIFIER, { format: 'framed', maxOutputSize: 0 })).toEqual(new Uint8Array(0));
    expect(syncErrorCode(() => z.decompressSync(z.compressSync('x', framed), { format: 'framed', maxOutputSize: 0 }))).toBe('ERR_SNAPPY_OUTPUT_LIMIT');
  });
});
