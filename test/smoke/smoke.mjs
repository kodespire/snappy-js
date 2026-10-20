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

const backend = z.activeBackend();
const expected = globalThis.process?.env?.EXPECT_BACKEND ?? globalThis.Deno?.env.get('EXPECT_BACKEND');
if (expected && backend !== expected) fail(`backend is ${backend}, expected ${expected}`);

console.log(`ok: ${runtime}, backend=${backend}, snappy ${z.SNAPPY_VERSION}, ${src.length} -> ${block.length} bytes raw, ${framed.length} framed`);
