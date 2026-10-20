// Smoke test for an installed copy of the package, runnable under Node, Bun and Deno:
//   EXPECT_BACKEND=native node smoke.mjs
//   EXPECT_BACKEND=native bun smoke.mjs
//   EXPECT_BACKEND=wasm deno run -A --node-modules-dir=manual smoke.mjs
// Copy it next to a node_modules that has @kodespire/snappy-js installed.
import * as z from '@kodespire/snappy-js';

const fail = (message) => {
  console.error(`FAIL: ${message}`);
  globalThis.process?.exit?.(1);
  globalThis.Deno?.exit?.(1);
  throw new Error(message);
};
const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const codeOf = async (fn) => {
  try {
    await fn();
    return 'no error';
  } catch (error) {
    return error.code;
  }
};

const runtime = globalThis.Deno ? `deno ${Deno.version.deno}` : globalThis.Bun ? `bun ${Bun.version}` : `node ${process.version}`;
const src = new TextEncoder().encode('smoke test '.repeat(50_000));

const block = await z.compress(src, { level: 2 });
if (!equal(await z.decompress(block), src)) fail('async raw round trip');
const framed = await z.compress(src, { format: 'framed' });
if (!equal(await z.decompress(framed, { format: 'framed' }), src)) fail('async framed round trip');
await z.init();
if (!equal(z.decompressSync(z.compressSync(src)), src)) fail('sync round trip');

const truncated = await codeOf(() => z.decompress(block.subarray(0, block.length - 3)));
if (truncated !== 'ERR_SNAPPY_TRUNCATED') fail(`truncated raw block gave ${truncated}`);
const truncatedFramed = await codeOf(() => z.decompress(framed.subarray(0, framed.length - 3), { format: 'framed' }));
if (truncatedFramed !== 'ERR_SNAPPY_TRUNCATED') fail(`truncated framed stream gave ${truncatedFramed}`);

const streamed = await new Response(new Blob([src]).stream().pipeThrough(z.createCompressStream()).pipeThrough(z.createDecompressStream())).arrayBuffer();
if (!equal(new Uint8Array(streamed), src)) fail('stream round trip');

// Compressed bytes must be the same on every platform and backend. The release
// workflow runs this on each prebuilt platform, so a build that compiles snappy
// differently (a hash or SIMD option) fails here. The values come from any one
// build: they are the same everywhere by design.
function sample() {
  const words = ['snappy ', 'block ', 'chunk ', 'frame ', 'literal ', 'copy ', 'offset ', '\n'];
  const out = new Uint8Array(300_000);
  let x = 2463534242;
  for (let i = 0; i < out.length; ) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    if (x % 5 === 0) {
      out[i++] = x & 0xff;
      continue;
    }
    for (const c of words[x % words.length]) if (i < out.length) out[i++] = c.charCodeAt(0);
  }
  return out;
}
const fnv1a = (bytes) => bytes.reduce((h, b) => Math.imul(h ^ b, 0x01000193) >>> 0, 0x811c9dc5);
const fingerprint = (c) => `${c.length}:0x${fnv1a(c).toString(16)}`;
const s = sample();
const expectedBytes = {
  'raw, level 1': ['105221:0xe70ee9e4', z.compressSync(s, 1)],
  'raw, level 2': ['89842:0x6a46212c', z.compressSync(s, 2)],
  framed: ['105283:0xf9204094', z.compressSync(s, { format: 'framed' })],
};
for (const [label, [want, got]] of Object.entries(expectedBytes)) {
  if (fingerprint(got) !== want) fail(`${label}: compressed bytes ${fingerprint(got)}, expected ${want} (output differs from other platforms)`);
  if (!equal(z.decompressSync(got, { format: label === 'framed' ? 'framed' : 'raw' }), s)) fail(`${label}: round trip`);
}

const backend = z.activeBackend();
const expected = globalThis.process?.env?.EXPECT_BACKEND ?? globalThis.Deno?.env.get('EXPECT_BACKEND');
if (expected && backend !== expected) fail(`backend is ${backend}, expected ${expected}`);

console.log(`ok: ${runtime}, backend=${backend}, snappy ${z.SNAPPY_VERSION}, ${src.length} -> ${block.length} bytes raw, ${framed.length} framed`);
