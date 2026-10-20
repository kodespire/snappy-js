# snappy-js

Snappy compression for Node.js, Bun, Deno, browsers and edge runtimes, with native bindings to
[google/snappy](https://github.com/google/snappy) and a WebAssembly build of the same code for runtimes without native addons.

**Status: planned.** This package will follow the same design as
[zstd-js](https://github.com/kodespire/zstd-js): one C layer shared by a Node-API addon and a
WebAssembly build, prebuilt binaries inside the package (no install scripts), and errors instead
of partial output on truncated or corrupt input. It will support both raw Snappy blocks (as used by Parquet and Kafka) and the framing format (`sNaPpY` streams).

Part of the [compression-js](https://github.com/kodespire/compression-js) family. MIT licensed.
