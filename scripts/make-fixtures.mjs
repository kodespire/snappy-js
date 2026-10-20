// Regenerates test/fixtures with an implementation independent of
// google/snappy: python-snappy and cramjam (the Rust `snap` crate), pinned in
// test/interop-requirements.txt. The fixtures are committed; rerun this only
// when changing them, and update test/fixtures/README.md to match.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { setupPython } from './setup-python-snappy.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'test', 'fixtures');
const python = process.env.SNAPPY_PYTHON ?? setupPython();
mkdirSync(out, { recursive: true });

const scratch = mkdtempSync(join(tmpdir(), 'snappy-js-fixtures-'));
const run = (command, input) => {
  const file = join(scratch, 'input.bin');
  writeFileSync(file, input);
  return execFileSync(python, ['-I', join(root, 'test', 'interop.py'), command, file], { maxBuffer: 1 << 30 });
};
const write = (name, data) => writeFileSync(join(out, name), data);

// Deterministic, compressible text, long enough for several 64 KiB chunks.
function corpus(seed, words) {
  const vocab = 'the quick brown fox jumps over lazy dog snappy block chunk frame literal copy offset varint stream identifier checksum'.split(' ');
  let x = seed >>> 0;
  const parts = [];
  for (let i = 0; i < words; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    parts.push(vocab[x % vocab.length]);
    if (x % 17 === 0) parts.push(`${x % 100000}\n`);
  }
  return Buffer.from(parts.join(' '));
}

// Deterministic incompressible bytes (xorshift32).
function random(length, seed) {
  const bytes = Buffer.alloc(length);
  let x = seed >>> 0;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    bytes[i] = x & 0xff;
  }
  return bytes;
}

const text = corpus(1, 40000);
write('corpus.txt', text);
write('corpus.raw', run('compress-raw', text));
write('corpus.sz', run('compress-framed', text));

// Incompressible input becomes uncompressed chunks, which every encoder that
// follows the spec's 64 KiB chunking and 12.5% rule writes identically.
const noise = random(150_000, 7);
write('random.bin', noise);
write('random.sz', run('compress-framed', noise));

write('empty.raw', run('compress-raw', Buffer.alloc(0)));
write('empty.sz', run('compress-framed', Buffer.alloc(0)));

console.log(`fixtures written to ${out} with ${run('versions', Buffer.alloc(0)).toString()}`);
rmSync(scratch, { recursive: true, force: true });
