# Bridge to an independent snappy implementation for the interop tests and
# scripts/make-fixtures.mjs: python-snappy and cramjam, which wrap the Rust
# `snap` crate rather than google/snappy. Reads the input file, writes stdout.
#   python -I test/interop.py compress-raw|decompress-raw|compress-framed|decompress-framed|versions [input]
# (Input comes from a file, not stdin: large inputs piped through Node's
# spawnSync occasionally never reached EOF on macOS.)
import importlib.metadata
import sys

import cramjam
import snappy

command = sys.argv[1]
data = open(sys.argv[2], 'rb').read() if len(sys.argv) > 2 else b''
if command == 'compress-raw':
    out = snappy.compress(data)
elif command == 'decompress-raw':
    out = snappy.uncompress(data)
elif command == 'compress-framed':
    # python-snappy's StreamDecompressor accepts streams without the stream
    # identifier, so the framed commands use cramjam's strict frame codec.
    out = bytes(cramjam.snappy.compress(data))
elif command == 'decompress-framed':
    out = bytes(cramjam.snappy.decompress(data))
elif command == 'versions':
    out = ('python-snappy %s, cramjam %s' % (importlib.metadata.version('python-snappy'),
                                            importlib.metadata.version('cramjam'))).encode()
else:
    sys.exit('unknown command: ' + command)
sys.stdout.buffer.write(out)
