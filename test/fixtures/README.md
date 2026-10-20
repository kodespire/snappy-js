# Test fixtures

Written by `scripts/make-fixtures.mjs` (`npm run fixtures`) with python-snappy 0.7.3 and
cramjam 2.14.0 (pinned in `../interop-requirements.txt`). Both wrap the Rust
[`snap`](https://github.com/BurntSushi/rust-snappy) crate, an implementation independent of
google/snappy, so these check that this package reads what other encoders write.

| File | Contents |
| --- | --- |
| `corpus.txt` | Deterministic generated text, 266 KB (several 64 KiB chunks). |
| `corpus.raw` | `corpus.txt` as one raw block, from `snappy.compress` (python-snappy). |
| `corpus.sz` | `corpus.txt` in the framing format, from `cramjam.snappy.compress`. |
| `random.bin` | 150,000 deterministic pseudo-random (incompressible) bytes. |
| `random.sz` | `random.bin` framed by cramjam. Stored chunks only, so this package's framed output for `random.bin` must match it byte for byte. |
| `empty.raw` | An empty input as a raw block: the single byte `00`. |
| `empty.sz` | An empty input framed by cramjam: zero bytes (no stream identifier). |

Hand-built streams (padding, skippable and reserved chunks, bad checksums) are made in the
tests themselves (`test/helpers.ts`). google/snappy's own corpus and its `baddata*.snappy`
vectors are read from `deps/snappy/testdata` in place; they carry their own licenses
(`deps/snappy/COPYING.notestdata`) and are not copied here.

The files are binary (see `.gitattributes`): never let git convert their line endings.
