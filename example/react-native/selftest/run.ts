// Self-test of @kodespire/snappy-js on a device or simulator. Each result is logged as
// one `SNAPPY_SELFTEST ...` line, which scripts/selftest.mjs reads from the device log,
// and the last line is `SNAPPY_SELFTEST DONE passed=N failed=M`.
import {
  activeBackend,
  compress,
  compressSync,
  createCompressStream,
  createDecompressStream,
  decompress,
  decompressSync,
  getUncompressedLength,
  init,
  isSnappyFramed,
  SNAPPY_VERSION,
  SnappyError,
  type CompressOptions,
} from '@kodespire/snappy-js';

// @ts-ignore generated plain JS
import fixtureData from './fixtures.generated';

declare const require: (id: string) => unknown;

type Log = (line: string) => void;

function fixture(name: string): Uint8Array {
  const binary = atob((fixtureData as Record<string, string>)[name]!);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Deterministic, moderately compressible bytes (the same generator as test/helpers.ts). */
function textBytes(length: number, seed = 1): Uint8Array {
  const words = ['alpha ', 'beta ', 'gamma ', 'delta ', 'snappy ', 'chunk ', 'block ', '\n'];
  const out = new Uint8Array(length);
  let x = seed >>> 0 || 1;
  let i = 0;
  while (i < length) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    const w = words[(x & 0xff) % words.length]!;
    for (let j = 0; j < w.length && i < length; j++) out[i++] = w.charCodeAt(j);
  }
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// ---- hand-built snappy data (as in test/helpers.ts and test/decompress-edges.test.ts) ----

const STREAM_IDENTIFIER = new Uint8Array([0xff, 0x06, 0x00, 0x00, 0x73, 0x4e, 0x61, 0x50, 0x70, 0x59]);

/** A raw block: the varint uncompressed length, then `rest` as the elements. */
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

function maskedCrc(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0x82f63b78 & -(c & 1));
  }
  c = ~c >>> 0;
  return (((c >>> 15) | (c << 17)) + 0xa282ead8) >>> 0;
}

/** A framed compressed-data chunk holding `block`, with the checksum of `data`. */
function compressedChunk(block: Uint8Array, data: Uint8Array): Uint8Array {
  const length = 4 + block.length;
  const crc = maskedCrc(data);
  return concat(
    new Uint8Array([0x00, length & 0xff, (length >> 8) & 0xff, length >> 16]),
    new Uint8Array([crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, crc >>> 24]),
    block,
  );
}

// ---- assertions ----

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertBytes(actual: Uint8Array, expected: Uint8Array, what: string): void {
  assert(actual instanceof Uint8Array, `${what}: not a Uint8Array`);
  assert(actual.length === expected.length, `${what}: length ${actual.length}, expected ${expected.length}`);
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) throw new Error(`${what}: differs at byte ${i}`);
  }
}

async function assertCode(run: () => unknown, code: string, what: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    assert(error instanceof SnappyError, `${what}: threw ${String(error)}, expected a SnappyError`);
    assert(error.code === code, `${what}: code ${error.code}, expected ${code}`);
    return;
  }
  throw new Error(`${what}: did not throw ${code}`);
}

async function pipe(stream: TransformStream<Uint8Array, Uint8Array>, chunks: Uint8Array[]): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const parts: Uint8Array[] = [];
  const reading = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      parts.push(value);
    }
  })();
  const writing = (async () => {
    for (const chunk of chunks) await writer.write(chunk);
    await writer.close();
  })();
  await Promise.all([reading, writing]);
  return concat(...parts);
}

function split(data: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += size) chunks.push(data.subarray(i, i + size));
  return chunks;
}

const FRAMED = { format: 'framed' } as const;

// A literal whose 4-byte length field is 0xffffffff means 2^32 bytes. snappy relies on
// a 64-bit size_t to reject it; where size_t is 32 bits (armeabi-v7a, x86) the length
// wraps to 0 and snappy alone would accept this block as the byte "a". csrc/sjs.cc
// validates raw blocks a second time there.
const WRAPS = rawHeader(1, [0xfc, 0xff, 0xff, 0xff, 0xff, 0x00, 0x61]);
const framedWraps = () => concat(STREAM_IDENTIFIER, compressedChunk(WRAPS, new TextEncoder().encode('a')));

const tests: [name: string, run: (log: Log) => Promise<void>][] = [
  ['native backend', async (log) => {
    await init();
    assert(activeBackend() === 'native', `activeBackend() is ${activeBackend()}`);
    log(`info snappy ${SNAPPY_VERSION}`);
  }],

  ['round trip, raw and framed', async () => {
    const data = textBytes(1 << 20);
    const cases: (CompressOptions | number | undefined)[] = [undefined, 2, FRAMED, { level: 2, format: 'framed' }];
    for (const options of cases) {
      const format = typeof options === 'object' ? options.format ?? 'raw' : 'raw';
      const what = `options ${JSON.stringify(options)}`;
      const packed = await compress(data, options);
      assert(isSnappyFramed(packed) === (format === 'framed'), `${what}: isSnappyFramed`);
      if (format === 'raw') assert(getUncompressedLength(packed) === data.length, `${what}: uncompressed length`);
      assertBytes(await decompress(packed, { format }), data, `async, ${what}`);
      assertBytes(decompressSync(compressSync(data, options), { format }), data, `sync, ${what}`);
    }
    const text = 'héllo € 😀 '.repeat(100);
    assertBytes(decompressSync(compressSync(text)), new TextEncoder().encode(text), 'string input');
    assertBytes(await decompress(await compress(new Uint8Array(0))), new Uint8Array(0), 'empty input, raw');
    assertBytes(await decompress(await compress(new Uint8Array(0), FRAMED), FRAMED), new Uint8Array(0), 'empty input, framed');
    // A view into a larger buffer: only the viewed bytes are compressed.
    const view = new Uint8Array(data.buffer, 1000, 5000);
    assertBytes(await decompress(await compress(view)), data.subarray(1000, 6000), 'subarray input, raw');
    assertBytes(await decompress(await compress(view, FRAMED), FRAMED), data.subarray(1000, 6000), 'subarray input, framed');
  }],

  ['same compressed bytes as every other build', async () => {
    // test/smoke/smoke.mjs checks these fingerprints on every Node prebuild and in
    // WebAssembly. A build that compiles snappy with other options (a hardware-CRC
    // hash, a missing config.h) gives different bytes.
    const words = ['snappy ', 'block ', 'chunk ', 'frame ', 'literal ', 'copy ', 'offset ', '\n'];
    const sample = new Uint8Array(300_000);
    let x = 2463534242;
    for (let i = 0; i < sample.length; ) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      x >>>= 0;
      if (x % 5 === 0) {
        sample[i++] = x & 0xff;
        continue;
      }
      for (const c of words[x % words.length]!) if (i < sample.length) sample[i++] = c.charCodeAt(0);
    }
    const fingerprint = (c: Uint8Array) => `${c.length}:0x${c.reduce((h, b) => Math.imul(h ^ b, 0x01000193) >>> 0, 0x811c9dc5).toString(16)}`;
    const expected: [string, string, Uint8Array][] = [
      ['raw, level 1', '105221:0xe70ee9e4', compressSync(sample, 1)],
      ['raw, level 2', '89842:0x6a46212c', await compress(sample, 2)],
      ['framed', '105283:0xf9204094', compressSync(sample, FRAMED)],
    ];
    for (const [label, want, got] of expected) assert(fingerprint(got) === want, `${label}: ${fingerprint(got)}, expected ${want}`);
    // cramjam (Rust snap) stores incompressible chunks uncompressed, as this package does.
    assertBytes(compressSync(fixture('random.bin'), FRAMED), fixture('random.sz'), 'random.bin framed, against cramjam');
  }],

  ['data from other encoders', async () => {
    const corpus = fixture('corpus.txt');
    assertBytes(await decompress(fixture('corpus.raw')), corpus, 'corpus.raw (python-snappy)');
    assertBytes(decompressSync(fixture('corpus.sz'), FRAMED), corpus, 'corpus.sz (cramjam)');
    assertBytes(decompressSync(concat(fixture('corpus.sz'), fixture('corpus.sz')), FRAMED), concat(corpus, corpus), 'concatenated streams');
    assertBytes(decompressSync(fixture('empty.raw')), new Uint8Array(0), 'empty.raw');
    assertBytes(await decompress(fixture('empty.sz'), FRAMED), new Uint8Array(0), 'empty.sz');
  }],

  ['truncated and corrupt input', async () => {
    const block = compressSync(textBytes(100_000));
    for (const end of [1, 2, block.length >> 1, block.length - 1]) {
      const cut = block.subarray(0, end);
      await assertCode(() => decompress(cut), 'ERR_SNAPPY_TRUNCATED', `raw, decompress, ${end} bytes`);
      await assertCode(() => decompressSync(cut), 'ERR_SNAPPY_TRUNCATED', `raw, decompressSync, ${end} bytes`);
    }
    await assertCode(() => decompress(new Uint8Array(0)), 'ERR_SNAPPY_TRUNCATED', 'raw, empty input');
    // Cuts inside a chunk. A cut between chunks (offset 10 is right after the stream
    // identifier) is a valid, shorter stream: the format has no end marker.
    const framed = compressSync(textBytes(200_000), FRAMED);
    for (const end of [5, 14, framed.length >> 1, framed.length - 1]) {
      const cut = framed.subarray(0, end);
      await assertCode(() => decompress(cut, FRAMED), 'ERR_SNAPPY_TRUNCATED', `framed, decompress, ${end} bytes`);
      await assertCode(() => decompressSync(cut, FRAMED), 'ERR_SNAPPY_TRUNCATED', `framed, decompressSync, ${end} bytes`);
    }
    const corrupt = framed.slice();
    corrupt[corrupt.length >> 1] ^= 0xff;
    await assertCode(() => decompress(corrupt, FRAMED), 'ERR_SNAPPY_LIBRARY', 'framed, corrupt data (checksum)');
  }],

  ['malformed raw blocks are rejected', async () => {
    await assertCode(() => decompressSync(WRAPS), 'ERR_SNAPPY_LIBRARY', '2^32-byte literal, sync');
    await assertCode(() => decompress(WRAPS), 'ERR_SNAPPY_LIBRARY', '2^32-byte literal, async');
    await assertCode(() => decompress(framedWraps(), FRAMED), 'ERR_SNAPPY_LIBRARY', '2^32-byte literal in a framed chunk');
    // (The "streams" test feeds the same chunk to a decompress stream.)
    const a = new TextEncoder().encode('a');
    // The same chunk with a valid block decodes, so the rejection above is the literal's.
    assertBytes(decompressSync(concat(STREAM_IDENTIFIER, compressedChunk(compressSync(a), a)), FRAMED), a, 'valid chunk');
    await assertCode(() => decompressSync(rawHeader(1, [0xfc, 0xfe, 0xff, 0xff, 0xff, 0x61])), 'ERR_SNAPPY_LIBRARY', 'literal longer than the block');
    await assertCode(() => decompressSync(rawHeader(4, [0x01, 0x00])), 'ERR_SNAPPY_LIBRARY', 'copy with nothing to copy from');
    await assertCode(() => decompressSync(rawHeader(8, [0x00, 0x61, 0x01, 0x00])), 'ERR_SNAPPY_LIBRARY', 'copy offset 0');
    await assertCode(() => decompressSync(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x10])), 'ERR_SNAPPY_LIBRARY', 'length over 32 bits');
    await assertCode(() => decompressSync(rawHeader(2, [0x04, 0x61])), 'ERR_SNAPPY_TRUNCATED', 'literal cut short');
  }],

  ['maxOutputSize', async () => {
    // 3 bytes claiming 4 GiB - 1 of output: rejected from the header, before allocating.
    const liar = rawHeader(0xffffffff, [0x00, 0x61]);
    assert(getUncompressedLength(liar) === 0xffffffff, 'getUncompressedLength of the lying header');
    const started = performance.now();
    await assertCode(() => decompress(liar, { maxOutputSize: 10 << 20 }), 'ERR_SNAPPY_OUTPUT_LIMIT', 'lying header with a limit');
    await assertCode(() => decompress(liar), 'ERR_SNAPPY_TRUNCATED', 'lying header without a limit');
    assert(performance.now() - started < 1000, 'the lying header was not rejected quickly');
    const data = textBytes(200_000);
    for (const format of ['raw', 'framed'] as const) {
      const packed = await compress(data, { format });
      await assertCode(() => decompress(packed, { format, maxOutputSize: data.length - 1 }), 'ERR_SNAPPY_OUTPUT_LIMIT', `${format}, one byte short`);
      await assertCode(() => decompressSync(packed, { format, maxOutputSize: 0 }), 'ERR_SNAPPY_OUTPUT_LIMIT', `${format}, limit 0`);
      assertBytes(await decompress(packed, { format, maxOutputSize: data.length }), data, `${format}, exact limit`);
    }
  }],

  ['async work runs off the JS thread', async (log) => {
    // Snappy is fast, so time one synchronous call first and grow the input until a
    // job takes long enough to tell apart from timer jitter. Then run the same job
    // asynchronously while a timer measures the longest JS stall. Only the time a job
    // is in flight counts: the call itself copies the input on the JS thread, which
    // takes a fair share of the time snappy needs to compress it.
    const tile = textBytes(1 << 20, 3);
    const options = { level: 2, format: 'framed' } as const;
    let data = tile;
    let syncMs = 0;
    for (let size = 16 << 20; size <= 128 << 20; size *= 2) {
      data = new Uint8Array(size);
      for (let i = 0; i < size; i += tile.length) data.set(tile, i);
      const start = performance.now();
      compressSync(data, options);
      syncMs = performance.now() - start;
      if (syncMs >= 150) break;
    }
    let measuring = false;
    let last = 0;
    let maxGap = 0;
    let ticks = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      if (measuring) {
        maxGap = Math.max(maxGap, now - last);
        ticks++;
      }
      last = now;
    }, 10);
    let inFlight = 0;
    let callMs = 0;
    let jobs = 0;
    let packed: Uint8Array = new Uint8Array(0);
    try {
      while (inFlight < 500 && jobs < 20) {
        const called = performance.now();
        const job = compress(data, options);
        await new Promise((r) => setTimeout(r, 0)); // the input has been copied by now
        const start = performance.now();
        callMs = Math.max(callMs, start - called);
        last = start;
        measuring = true;
        packed = await job;
        measuring = false;
        inFlight += performance.now() - start;
        jobs++;
      }
    } finally {
      clearInterval(timer);
    }
    assertBytes(decompressSync(packed, FRAMED), data, 'output');
    log(
      `info compress(${data.length >> 20} MiB, framed, level 2): ${syncMs.toFixed(0)} ms sync; ${jobs} async jobs, ` +
        `call and copy up to ${callMs.toFixed(0)} ms, then ${inFlight.toFixed(0)} ms in flight with ${ticks} timer ticks, ` +
        `longest JS stall ${maxGap.toFixed(0)} ms`,
    );
    assert(syncMs >= 50, `a ${data.length >> 20} MiB job takes only ${syncMs.toFixed(0)} ms: too fast to measure`);
    assert(ticks >= 10, `only ${ticks} timer ticks in ${inFlight.toFixed(0)} ms of jobs in flight`);
    assert(maxGap < syncMs / 2, `JS thread stalled for ${maxGap.toFixed(0)} ms while a job was in flight; one job takes ${syncMs.toFixed(0)} ms`);
    // Several jobs at once, and inputs captured at call time.
    const format = (i: number) => (i % 2 ? 'framed' : 'raw');
    const inputs = [1, 2, 3, 4].map((seed) => textBytes(500_000, seed));
    const expected = inputs.map((input) => input.slice());
    const pending = inputs.map((input, i) => compress(input, { format: format(i) }));
    for (const input of inputs) input.fill(0);
    const outputs = await Promise.all(pending);
    for (let i = 0; i < outputs.length; i++) assertBytes(decompressSync(outputs[i]!, { format: format(i) }), expected[i]!, `compress job ${i}`);
    const packed2 = outputs.map((output) => output.slice());
    const unpacking = packed2.map((data, i) => decompress(data, { format: format(i) }));
    for (const data of packed2) data.fill(0);
    const unpacked = await Promise.all(unpacking);
    for (let i = 0; i < unpacked.length; i++) assertBytes(unpacked[i]!, expected[i]!, `decompress job ${i}`);
  }],

  ['streams', async (log) => {
    if (typeof TransformStream === 'undefined') {
      let message = '';
      try {
        createCompressStream();
      } catch (error) {
        message = String(error);
      }
      assert(/TransformStream/.test(message), `without a TransformStream: ${message || 'no error'}`);
      require('web-streams-polyfill/polyfill');
      log('info no global TransformStream: using web-streams-polyfill');
    }
    const data = textBytes(1 << 20, 5);
    // Input is cut into 64 KiB chunks however it arrives, so the stream writes the
    // same bytes as one-shot framed compression.
    const packed = await pipe(createCompressStream({ level: 2 }), split(data, 65_537));
    assertBytes(packed, compressSync(data, { level: 2, format: 'framed' }), 'compress stream against compressSync');
    assertBytes(await pipe(createDecompressStream(), split(packed, 7_000)), data, 'decompress stream');
    await assertCode(() => pipe(createDecompressStream(), [packed.subarray(0, packed.length - 3)]), 'ERR_SNAPPY_TRUNCATED', 'truncated stream');
    await assertCode(() => pipe(createDecompressStream({ maxOutputSize: 1000 }), [packed]), 'ERR_SNAPPY_OUTPUT_LIMIT', 'stream over maxOutputSize');
    const corrupt = packed.slice();
    corrupt[corrupt.length >> 1] ^= 0xff;
    await assertCode(() => pipe(createDecompressStream(), split(corrupt, 10_000)), 'ERR_SNAPPY_LIBRARY', 'corrupt stream');
    await assertCode(() => pipe(createDecompressStream(), [framedWraps()]), 'ERR_SNAPPY_LIBRARY', 'stream with a 2^32-byte literal');
  }],

  ['options are checked', async () => {
    const throws = (run: () => unknown, type: ErrorConstructor) => {
      try {
        run();
      } catch (error) {
        return error instanceof type;
      }
      return false;
    };
    assert(throws(() => compressSync(new Uint8Array(1), { framed: true } as never), TypeError), 'an unknown option did not throw a TypeError');
    assert(throws(() => compressSync(new Uint8Array(1), { format: 'sz' } as never), TypeError), 'an unknown format did not throw a TypeError');
    assert(throws(() => compressSync(new Uint8Array(1), 3), RangeError), 'level 3 did not throw a RangeError');
    assert(throws(() => createDecompressStream({ format: 'raw' } as never), TypeError), 'a raw stream did not throw a TypeError');
  }],

  ['speed', async (log) => {
    const data = textBytes(8 << 20);
    for (const format of ['raw', 'framed'] as const) {
      let start = performance.now();
      const packed = compressSync(data, { format });
      const compressMs = performance.now() - start;
      start = performance.now();
      decompressSync(packed, { format });
      const decompressMs = performance.now() - start;
      const mbps = (ms: number) => (data.length / 1e6 / (ms / 1000)).toFixed(0);
      log(`info ${format}, level 1, 8 MiB: compress ${mbps(compressMs)} MB/s, decompress ${mbps(decompressMs)} MB/s, ratio ${(data.length / packed.length).toFixed(2)}`);
    }
  }],
];

export async function runSelfTest(log: Log): Promise<boolean> {
  let passed = 0;
  let failed = 0;
  for (const [name, run] of tests) {
    const start = performance.now();
    try {
      await run(log);
      passed++;
      log(`ok ${name} (${(performance.now() - start).toFixed(0)} ms)`);
    } catch (error) {
      failed++;
      log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  log(`DONE passed=${passed} failed=${failed}`);
  return failed === 0;
}
