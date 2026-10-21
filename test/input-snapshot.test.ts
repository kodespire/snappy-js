// Async calls must use the bytes as they were when the call was made, even if the
// caller changes its buffer before the promise settles. Regression: 0.2.0 and earlier
// awaited the backend before copying the input, so a change made right after the
// call (on any call, not only while the WebAssembly module was loading) was what got
// compressed or decompressed. The wasm backend is first used in this file by these
// tests, so the loading path is covered too.
import { describe, expect, it } from 'vitest';

import { backends, textBytes } from './helpers.js';

// Byte comparison without vitest's array diff, which takes minutes on 200 KB inputs.
const same = (a: Uint8Array, b: Uint8Array) => Buffer.compare(a, b) === 0;

describe.each(backends)('%s backend: async calls capture their input at call time', (_name, z) => {
  for (const format of ['raw', 'framed'] as const) {
    it(`compress ignores changes made to the input after the call (${format})`, async () => {
      const original = textBytes(200_000, 41);
      const buf = Buffer.from(original);
      const pending = z.compress(buf, { format });
      buf.fill(0);
      expect(same(z.decompressSync(await pending, { format }), original)).toBe(true);
    });

    it(`decompress ignores changes made to the data after the call (${format})`, async () => {
      const original = textBytes(200_000, 42);
      const packed = Buffer.from(z.compressSync(original, { format }));
      const pending = z.decompress(packed, { format });
      packed.fill(0);
      expect(same(await pending, original)).toBe(true);
    });
  }
});
