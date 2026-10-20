// Interoperability with an implementation independent of google/snappy:
// python-snappy and cramjam, which wrap the Rust `snap` crate.
//   - test/fixtures were written by it (scripts/make-fixtures.mjs, see
//     test/fixtures/README.md) and always run.
//   - The live round trips need Python with test/interop-requirements.txt
//     (SNAPPY_PYTHON, or `node scripts/setup-python-snappy.mjs`); in CI they
//     are required, not skipped (see test/helpers.ts).
// google/snappy's own test corpus (deps/snappy/testdata) is read in place.
import { describe, expect, it } from 'vitest';

import {
  backends,
  chunk,
  concat,
  fixture,
  maskedCrc,
  parseChunks,
  pipeChunks,
  python,
  randomBytes,
  STREAM_IDENTIFIER,
  syncErrorCode,
  testdata,
  TESTDATA_FILES,
  textBytes,
  uncompressedChunk,
  viaPython,
} from './helpers.js';

const corpus = new Uint8Array(fixture('corpus.txt'));
const framed = { format: 'framed' } as const;

describe.each(backends)('%s backend: decodes python-snappy / cramjam output', (_name, z) => {
  it('raw block', async () => {
    expect(z.decompressSync(fixture('corpus.raw'))).toEqual(corpus);
    expect(await z.decompress(fixture('corpus.raw'))).toEqual(corpus);
    expect(z.getUncompressedLength(fixture('corpus.raw'))).toBe(corpus.length);
  });

  it('framed stream, one-shot and streamed', async () => {
    expect(z.decompressSync(fixture('corpus.sz'), framed)).toEqual(corpus);
    expect(await pipeChunks(z.createDecompressStream(), fixture('corpus.sz'), () => 4321)).toEqual(corpus);
    expect(z.isSnappyFramed(fixture('corpus.sz'))).toBe(true);
  });

  it('empty input, in both formats', async () => {
    expect(z.decompressSync(fixture('empty.raw'))).toEqual(new Uint8Array(0));
    // cramjam writes nothing at all for an empty framed stream.
    expect(fixture('empty.sz').length).toBe(0);
    expect(z.decompressSync(fixture('empty.sz'), framed)).toEqual(new Uint8Array(0));
    expect(await pipeChunks(z.createDecompressStream(), fixture('empty.sz'))).toEqual(new Uint8Array(0));
  });

  it('concatenated streams decode to the concatenated data', () => {
    const joined = concat(fixture('corpus.sz'), fixture('random.sz'), z.compressSync('tail', framed));
    expect(z.decompressSync(joined, framed)).toEqual(concat(corpus, fixture('random.bin'), new TextEncoder().encode('tail')));
  });

  it('framed output for incompressible input is byte-identical to cramjam’s', () => {
    // Both follow the spec: 64 KiB chunks, stored uncompressed when compression saves
    // less than 12.5%, with the masked CRC-32C of the data.
    expect(z.compressSync(fixture('random.bin'), framed)).toEqual(new Uint8Array(fixture('random.sz')));
  });

  it('our framed output is well-formed, with correct checksums', () => {
    // Checked with test/helpers.ts's own chunk parser and bitwise CRC-32C.
    const src = concat(textBytes(150_000, 1), randomBytes(70_000, 2));
    const stream = z.compressSync(src, framed);
    const chunks = parseChunks(stream);
    expect(chunks[0]!.type).toBe(0xff);
    expect(stream.subarray(0, 10)).toEqual(STREAM_IDENTIFIER);
    let offset = 0;
    for (const c of chunks.slice(1)) {
      expect([0x00, 0x01]).toContain(c.type);
      const data = c.type === 0x01 ? c.data.subarray(4) : z.decompressSync(c.data.subarray(4));
      expect(data.length).toBeLessThanOrEqual(65536);
      expect(new DataView(c.data.buffer, c.data.byteOffset).getUint32(0, true)).toBe(maskedCrc(data));
      expect(data).toEqual(src.subarray(offset, offset + data.length));
      offset += data.length;
    }
    expect(offset).toBe(src.length);
    // Incompressible chunks are stored, compressible ones compressed.
    expect(chunks.map((c) => c.type)).toEqual([0xff, 0, 0, 0, 1]);
  });
});

describe.each(backends)('%s backend: google/snappy test vectors (deps/snappy/testdata)', (_name, z) => {
  it.each(TESTDATA_FILES)('%s round-trips in both formats and levels', (name) => {
    const data = new Uint8Array(testdata(name));
    for (const format of ['raw', 'framed'] as const) {
      for (const level of [1, 2]) {
        expect(z.decompressSync(z.compressSync(data, { format, level }), { format })).toEqual(data);
      }
    }
  });

  it.each(['baddata1.snappy', 'baddata2.snappy', 'baddata3.snappy'])('%s is rejected', async (name) => {
    expect(syncErrorCode(() => z.decompressSync(testdata(name)))).toBe('ERR_SNAPPY_LIBRARY');
    await expect(z.decompress(testdata(name))).rejects.toMatchObject({ code: 'ERR_SNAPPY_LIBRARY' });
  });
});

describe.skipIf(!python).each(backends)('%s backend: live round trips with python-snappy / cramjam', (_name, z) => {
  it.each(TESTDATA_FILES)('raw: %s both ways', (name) => {
    const data = new Uint8Array(testdata(name));
    for (const level of [1, 2]) expect(viaPython('decompress-raw', z.compressSync(data, { level }))).toEqual(data);
    expect(z.decompressSync(viaPython('compress-raw', data))).toEqual(data);
  });

  it.each(TESTDATA_FILES)('framed: %s both ways', (name) => {
    const data = new Uint8Array(testdata(name));
    for (const level of [1, 2]) expect(viaPython('decompress-framed', z.compressSync(data, { format: 'framed', level }))).toEqual(data);
    expect(z.decompressSync(viaPython('compress-framed', data), framed)).toEqual(data);
  });

  it('streamed output, empty input and boundary sizes', async () => {
    for (const size of [0, 1, 65535, 65536, 65537, 300_000]) {
      const src = textBytes(size, size);
      expect(viaPython('decompress-raw', z.compressSync(src)), `raw ${size}`).toEqual(src);
      expect(viaPython('decompress-framed', z.compressSync(src, framed)), `framed ${size}`).toEqual(src);
      const streamed = await pipeChunks(z.createCompressStream(), src, () => 10_007);
      expect(viaPython('decompress-framed', streamed), `streamed ${size}`).toEqual(src);
    }
  });

  it('cramjam accepts the padding and skippable chunks we skip', () => {
    const data = textBytes(5000, 9);
    const stream = concat(STREAM_IDENTIFIER, chunk(0xfe, new Uint8Array(7)), uncompressedChunk(data), chunk(0x99, new Uint8Array(3)));
    expect(viaPython('decompress-framed', stream)).toEqual(data);
    expect(z.decompressSync(stream, framed)).toEqual(data);
  });
});
