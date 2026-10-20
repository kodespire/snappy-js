# snappy-js

[![CI](https://github.com/kodespire/snappy-js/actions/workflows/ci.yml/badge.svg)](https://github.com/kodespire/snappy-js/actions/workflows/ci.yml)

Snappy compression for Node.js, Bun, Deno, browsers and edge runtimes, with one API everywhere. Reads and writes both raw Snappy blocks and the Snappy framing format.

- **The official library.** Compiled from [google/snappy](https://github.com/google/snappy) 1.3.1, pinned as a git submodule. A weekly job opens a PR when upstream releases.
- **Native where possible, WebAssembly everywhere else.** Node.js and Bun use a Node-API addon. Browsers, Deno and Workers use WebAssembly built from the same C++ code. If no prebuilt binary matches your platform, the package switches to WebAssembly on its own.
- **The same bytes everywhere.** Compressed output is byte-identical on every platform and in WebAssembly, so a payload's bytes never depend on where it was made.
- **No install scripts.** Prebuilt binaries ship inside the package. `npm install` never downloads or compiles anything.
- **Never returns partial data.** Cut-off input, corrupt input and output over your size limit all throw. They never return what was decoded so far.

Part of the [compression-js](https://github.com/kodespire/compression-js) family.

```sh
npm install @kodespire/snappy-js
```

## Usage

```js
import { compress, decompress } from '@kodespire/snappy-js';

// Raw block (the default)
const block = await compress(data);
const unpacked = await decompress(block, { maxOutputSize: 64 * 1024 * 1024 });

// Framing format
const stream = await compress(data, { format: 'framed' });
const again = await decompress(stream, { format: 'framed' });
```

`data` can be a `Uint8Array`, a Node `Buffer`, an `ArrayBuffer`, any typed array or `DataView`, or a string (encoded as UTF-8). Results are always `Uint8Array`.

### Raw blocks or the framing format?

Snappy data comes in two formats, and they can't be read as each other. Pass the format the other side uses.

| | `format: 'raw'` (default) | `format: 'framed'` |
| --- | --- | --- |
| What it is | One Snappy block: the uncompressed length as a varint, then the compressed data | A `sNaPpY` stream identifier, then chunks of at most 64 KiB, as described in [framing_format.txt](https://github.com/google/snappy/blob/main/framing_format.txt) |
| Checksum | None | A masked CRC-32C of each chunk's data, checked on decompression |
| Size limit | 4 GiB - 1 bytes of input | None for streams; one-shot calls are limited by memory |
| Streaming | No: the whole block is in memory | Yes: `createCompressStream()` and `createDecompressStream()` |
| Used by | Parquet, LevelDB, Prometheus remote write | Go's and Rust's Snappy stream readers and writers, python-snappy streams, `Content-Encoding: x-snappy-framed` |

snappy-java's stream format, which Kafka's Java client uses, and Hadoop's block format are two further framings. This package reads neither.

### Streams

`createCompressStream()` and `createDecompressStream()` return standard [`TransformStream`](https://developer.mozilla.org/docs/Web/API/TransformStream)s, which work in every runtime. Streams always use the framing format:

```js
const response = await fetch(url);
const body = response.body.pipeThrough(createDecompressStream());
```

In Node.js, wrap them with `Duplex.fromWeb` to use them in a pipeline:

```js
import { createReadStream, createWriteStream } from 'node:fs';
import { Duplex } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createCompressStream } from '@kodespire/snappy-js';

await pipeline(
  createReadStream('data.json'),
  Duplex.fromWeb(createCompressStream()),
  createWriteStream('data.json.sz'),
);
```

A compress stream's output is byte-identical to `compress(data, { format: 'framed' })` for the same data, however the input was split into writes.

### Synchronous calls

`compressSync` and `decompressSync` behave like their async versions.

- **Node.js and Bun:** they work right away.
- **Browsers, Deno and Workers:** the WebAssembly module loads asynchronously, so call `await init()` once first.

The async functions load the module on demand.

```js
import { init, compressSync } from '@kodespire/snappy-js';

await init();
const block = compressSync('hello');
```

### Untrusted input

A raw block's header says how big the output is, and nothing stops it from lying. Always pass `maxOutputSize` when decompressing data you don't control.
- Raw blocks: the header is checked against the limit before anything is allocated. The whole block is then validated before the output is allocated.
- Framed streams: each chunk's size is checked before it is decoded.

```js
try {
  await decompress(upload, { maxOutputSize: 10 * 1024 * 1024 });
} catch (error) {
  if (error.code === 'ERR_SNAPPY_OUTPUT_LIMIT') rejectUpload();
}
```

## API

| Function | Description |
| --- | --- |
| `compress(data, options?)` | Compresses into one raw block, or a framed stream. Returns `Promise<Uint8Array>`. |
| `decompress(data, options?)` | Decompresses a raw block, or every chunk of a framed stream. Returns `Promise<Uint8Array>`. |
| `compressSync` / `decompressSync` | Synchronous versions (see above). |
| `createCompressStream(options?)` | `TransformStream` that writes a framed stream. |
| `createDecompressStream(options?)` | `TransformStream` that reads a framed stream. Errors on cut-off, corrupt or oversized input. |
| `getUncompressedLength(data)` | Size recorded in a raw block's header. Untrusted: still pass `maxOutputSize`. |
| `isSnappyFramed(data)` | `true` if `data` starts with the framing format's stream identifier. |
| `init(source?)` | Loads the backend. `source` can be a URL, `Response`, bytes or `WebAssembly.Module` for `snappy.wasm`. |
| `activeBackend()` | `'native'` or `'wasm'`. |
| `SNAPPY_VERSION`, `MIN_LEVEL`, `MAX_LEVEL`, `DEFAULT_LEVEL` | `'1.3.1'`, `1`, `2`, `1`. |

**Compress options** (`createCompressStream` takes `level` only)

| Option | Default | |
| --- | --- | --- |
| `level` | `1` | `1` (fastest) or `2` (a little smaller and slower). Upstream marks level 2 as experimental, but its output is standard Snappy that any decoder reads. A number in place of the options object sets just the level. |
| `format` | `'raw'` | `'raw'` or `'framed'`. |

**Decompress options** (`createDecompressStream` takes `maxOutputSize` only)

| Option | Default | |
| --- | --- | --- |
| `maxOutputSize` | `Infinity` | Throw `ERR_SNAPPY_OUTPUT_LIMIT` rather than produce more bytes than this. |
| `format` | `'raw'` | `'raw'` or `'framed'`. Must match how the data was compressed. |

An unknown option name throws a `TypeError`. A typo like `{ framed: true }` fails loudly instead of quietly using the raw format. Stream options accept `format: 'framed'` for clarity, and reject `'raw'`.

**Errors** are `SnappyError` instances, each with a `code`:

| Code | Meaning |
| --- | --- |
| `ERR_SNAPPY_TRUNCATED` | The input ended partway through a raw block or a framed chunk. Also thrown for empty raw input. |
| `ERR_SNAPPY_LIBRARY` | Not valid Snappy in the given format: a bad block, a checksum mismatch, a missing stream identifier, a reserved chunk type. |
| `ERR_SNAPPY_OUTPUT_LIMIT` | The output would exceed `maxOutputSize`. |
| `ERR_SNAPPY_NOT_INITIALIZED` | A sync function was called in a browser or Worker before `await init()`. |
| `ERR_SNAPPY_OUT_OF_MEMORY`, `ERR_SNAPPY_INVALID_ARGUMENT` | As named. `INVALID_ARGUMENT` includes raw input of 4 GiB or more. |

## Behaviour details

- **Raw blocks have no checksum.** A damaged length, tag or offset is caught, and output never comes back longer or shorter than the header says. But damage inside literal bytes decodes to wrong bytes, as with any Snappy decoder. Use the framing format when you need corruption detected.
- **WebAssembly validates raw blocks twice.** One of snappy's checks relies on a 64-bit `size_t`: in wasm32, a literal length of 2^32 wraps to 0, so snappy alone would accept a block that native builds reject. Where `size_t` is 32 bits, every block must also pass a second validator using 64-bit arithmetic, so both backends accept exactly the same input.
- **Every proper prefix of a raw block throws** `ERR_SNAPPY_TRUNCATED`. That includes an empty input, since even an empty block has a 1-byte header.
- **A framed stream cut between two chunks can't be detected.** The framing format has no end-of-stream marker, so that cut looks like a complete, shorter stream. A cut anywhere inside a chunk throws `ERR_SNAPPY_TRUNCATED`.
- **An empty input is a valid, empty framed stream**, which is what Go's and Rust's encoders write for no data. Like any cut between chunks, it can't be told apart from a truncation. This differs on purpose from zstd-js, where empty input is an error. Compressing empty input writes just the 10-byte stream identifier.
- **Framed streams are read the way the specification says.**
  - Repeated stream identifiers, as in concatenated streams, are allowed and ignored.
  - Padding (`0xfe`) and reserved skippable chunks (`0x80`–`0xfd`) are skipped.
  - Reserved unskippable chunks (`0x02`–`0x7f`) are errors.
  - Every checksum is verified.
- **Framed chunk limits.** A data chunk may hold at most 65,536 bytes of output. A compressed chunk can't be longer than the most any Snappy encoder writes for that much data, which Go's decoder also enforces. Longer chunks are rejected from their header, before they are buffered, so a decompress stream never holds more than about 75 KB of input.
- **Compressed chunks must save at least 12.5%.** The compressor stores a chunk uncompressed otherwise, like the Go and Rust encoders. Chunks always hold 64 KiB of input except the last.
- **Output is the same on every platform.** Snappy can use a hardware CRC instruction as its hash, which changes the compressed bytes. That option is off, so native output on every platform and WebAssembly output all match byte for byte. Decompression uses SSSE3/BMI2/NEON only where the compiler targets them by default (in the prebuilt binaries, NEON on 64-bit ARM Linux and macOS), and plain code in WebAssembly and MSVC builds.
- **The async functions use separate threads only on the native addon**, which runs them on Node's thread pool. The WebAssembly backend runs on the calling thread, so for large inputs in a browser, call it from a Web Worker.
- **Forcing WebAssembly:** set `SNAPPY_JS_BACKEND=wasm` in Node.js, or import `@kodespire/snappy-js/wasm` in any runtime.

## Runtimes

| Runtime | Backend | Tested in CI |
| --- | --- | --- |
| Node.js 22.12+, 24, 26 | native | Linux x64/arm64, macOS, Windows |
| Bun | native | Linux |
| Deno 2 | WebAssembly | Linux |
| Chromium, Firefox, WebKit | WebAssembly | Playwright, through Vite |
| Cloudflare Workers (`workerd` condition) | WebAssembly | `wrangler dev` (workerd) |

Prebuilt native binaries cover:
- macOS arm64 and x64
- Linux x64 and arm64 (glibc 2.28+ and musl)
- Windows x64 and arm64

Bundlers that understand `new URL('./snappy.wasm', import.meta.url)`, such as Vite, webpack 5 and Parcel, pick up the WebAssembly file automatically. For anything else, serve `@kodespire/snappy-js/snappy.wasm` yourself and pass its URL to `init()`.

## Development

```sh
git clone --recursive https://github.com/kodespire/snappy-js
npm install
npm run build:native   # Node-API addon (needs Python 3 and a C++ compiler)
npm run build:wasm     # snappy.wasm (needs Emscripten; see .emsdk-version)
npm run build:ts       # dist/
node scripts/setup-python-snappy.mjs   # python-snappy in out/venv, for the interop tests
npm test
BROWSERS=chromium npx vitest run -c vitest.browser.config.ts
```

`csrc/sjs.cc` holds all compression logic, including the framing format, which google/snappy does not implement. Both builds share it. `csrc/addon.cc` (Node-API) and `src/wasm-backend.ts` (WebAssembly) only move bytes in and out.

Snappy's CMake build normally generates `config.h` and `snappy-stubs-public.h`. Both builds use hand-written copies instead, in `csrc/snappy-config/`, with each setting documented. `test/version.test.ts` checks them against upstream's templates.

The tests run every case against both backends. They also check:
- interop with python-snappy and cramjam, which wrap the Rust `snap` crate, an independent implementation, both through fixtures (`test/fixtures/README.md`) and live
- google/snappy's own test corpus
- streaming split at random points

## License

MIT. The bundled Snappy library is BSD-licensed; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
