// Runs in real browsers (see vitest.browser.config.ts) against the built dist/.
import { describe, expect, it } from 'vitest';

import * as z from '../../dist/entry-wasm.js';

const text = (n: number) => new TextEncoder().encode('browser snappy test '.repeat(Math.ceil(n / 20))).subarray(0, n);

async function pipe(stream: TransformStream<Uint8Array, Uint8Array>, data: Uint8Array, chunk: number): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const reading = (async () => {
    const reader = stream.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
  })();
  const writer = stream.writable.getWriter();
  for (let i = 0; i < data.length; i += chunk) await writer.write(data.subarray(i, i + chunk));
  await writer.close();
  await reading;
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe('snappy-js in the browser', () => {
  // Must run first: nothing has loaded the module yet.
  it('sync calls before init() throw ERR_SNAPPY_NOT_INITIALIZED', () => {
    expect(() => z.compressSync('x')).toThrow(expect.objectContaining({ code: 'ERR_SNAPPY_NOT_INITIALIZED' }));
  });

  it('async calls load the WebAssembly module on demand', async () => {
    const src = text(500_000);
    const block = await z.compress(src);
    expect(block.length).toBeLessThan(50_000);
    expect(await z.decompress(block)).toEqual(src);
    expect(z.activeBackend()).toBe('wasm');
  });

  it('sync calls work after init(), in both formats', async () => {
    await z.init();
    const src = text(100_000);
    expect(z.decompressSync(z.compressSync(src))).toEqual(src);
    expect(z.getUncompressedLength(z.compressSync(src))).toBe(100_000);
    const framed = z.compressSync(src, { format: 'framed', level: 2 });
    expect(z.isSnappyFramed(framed)).toBe(true);
    expect(z.decompressSync(framed, { format: 'framed' })).toEqual(src);
  });

  it('truncated input is an error', async () => {
    const block = await z.compress(new Uint8Array(1_000_000));
    await expect(z.decompress(block.subarray(0, block.length - 3))).rejects.toMatchObject({ code: 'ERR_SNAPPY_TRUNCATED' });
    const stream = await z.compress(new Uint8Array(1_000_000), { format: 'framed' });
    await expect(z.decompress(stream.subarray(0, stream.length - 3), { format: 'framed' })).rejects.toMatchObject({ code: 'ERR_SNAPPY_TRUNCATED' });
  });

  it('maxOutputSize is enforced', async () => {
    const block = await z.compress(new Uint8Array(8 << 20));
    await expect(z.decompress(block, { maxOutputSize: 1 << 20 })).rejects.toMatchObject({ code: 'ERR_SNAPPY_OUTPUT_LIMIT' });
  });

  it('streams round-trip', async () => {
    const src = text(2_000_000);
    const stream = await pipe(z.createCompressStream(), src, 100_000);
    expect(stream).toEqual(z.compressSync(src, { format: 'framed' }));
    expect(await pipe(z.createDecompressStream(), stream, 777)).toEqual(src);
  });

  it('grows WebAssembly memory past 256 MiB and keeps working', async () => {
    const src = new Uint8Array(300 << 20);
    src[src.length - 1] = 7;
    const block = await z.compress(src);
    const out = await z.decompress(block);
    expect(out.length).toBe(src.length);
    expect(out[out.length - 1]).toBe(7);
    expect(z.decompressSync(z.compressSync('still fine'))).toEqual(new TextEncoder().encode('still fine'));
  });
});
