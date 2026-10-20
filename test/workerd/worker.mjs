// Cloudflare Workers smoke test: resolves the package through the "workerd"
// export condition, which imports snappy.wasm statically. Run with run.mjs.
import * as z from '@kodespire/snappy-js';

export default {
  async fetch() {
    const result = {};
    try {
      const src = new TextEncoder().encode('workerd '.repeat(20_000));
      const block = await z.compress(src, 2);
      result.roundTrip = (await z.decompress(block)).length === src.length;
      const framed = await z.compress(src, { format: 'framed' });
      result.framed = (await z.decompress(framed, { format: 'framed' })).length === src.length;
      await z.init();
      result.sync = z.decompressSync(z.compressSync('abc')).length === 3;
      try {
        await z.decompress(block.subarray(0, block.length - 3));
        result.truncated = 'no error';
      } catch (error) {
        result.truncated = error.code;
      }
      const body = new Response(src).body.pipeThrough(z.createCompressStream()).pipeThrough(z.createDecompressStream());
      result.stream = (await new Response(body).arrayBuffer()).byteLength === src.length;
      result.backend = z.activeBackend();
      result.version = z.SNAPPY_VERSION;
    } catch (error) {
      result.error = String(error?.stack ?? error);
    }
    return Response.json(result);
  },
};
