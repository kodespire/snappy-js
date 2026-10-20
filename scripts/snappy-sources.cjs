// Prints the google/snappy C++ sources that both builds compile, one per line.
// Used by binding.gyp (via <!@(...)) and scripts/build-wasm.mjs.
// snappy-c.cc (the C API) is left out: csrc/sjs.cc calls the C++ API.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const FILES = ['snappy.cc', 'snappy-sinksource.cc', 'snappy-stubs-internal.cc'];

function sources() {
  return FILES.map((name) => {
    const rel = path.posix.join('deps/snappy', name);
    if (!fs.existsSync(path.join(root, rel))) {
      throw new Error(`${rel} is missing. Run: git submodule update --init`);
    }
    return rel;
  });
}

module.exports = { sources };

if (require.main === module) {
  process.stdout.write(sources().join('\n') + '\n');
}
