/*
 * sjs: the C layer shared by the Node-API addon and the WebAssembly build.
 *
 * Every compress/decompress loop lives here, once, including the framing
 * format, which google/snappy does not implement. Both bindings are thin
 * wrappers that move bytes in and out, so a fix or a test here covers both.
 * The implementation is C++ (snappy is), behind a C interface.
 *
 * Two formats:
 *   raw     One snappy block: a varint of the uncompressed length, then the
 *           compressed elements. No checksum and no magic number. What
 *           Parquet, LevelDB and Prometheus remote write use.
 *   framed  The snappy framing format (deps/snappy/framing_format.txt): the
 *           "sNaPpY" stream identifier, then chunks of at most 64 KiB of
 *           data, each with a masked CRC-32C. What the streams use.
 *
 * Conventions:
 *   - Functions return SJS_OK (0) or an SJS_ERR_* code.
 *   - On error, *detail (when non-NULL) points to a static, NUL-terminated
 *     message. It is never freed and is safe to read from any thread.
 *   - Output is appended to a caller-owned sjs_buf, which the caller frees
 *     with sjs_buf_free (also on error). On error its contents are garbage.
 *   - Nothing here throws, and snappy is only called through overloads that
 *     do not allocate, so the WebAssembly build needs no exception support.
 */
#ifndef SJS_H
#define SJS_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum {
  SJS_OK = 0,
  SJS_ERR_CORRUPT = 1,      /* not valid snappy data: bad block, CRC mismatch, bad chunk */
  SJS_ERR_TRUNCATED = 2,    /* input ended before the end of a block or chunk (or was empty) */
  SJS_ERR_OUTPUT_LIMIT = 3, /* decompressed size would exceed max_output */
  SJS_ERR_NOMEM = 4,        /* allocation failed */
  SJS_ERR_ARG = 5           /* invalid argument */
};

enum { SJS_FORMAT_RAW = 0, SJS_FORMAT_FRAMED = 1 };

/* For framed compression streams, FLUSH and END both write out buffered input
 * as a chunk: the framing format has no end-of-stream marker. */
enum { SJS_MODE_CONTINUE = 0, SJS_MODE_FLUSH = 1, SJS_MODE_END = 2 };

typedef struct sjs_buf {
  uint8_t* data;
  size_t size;
  size_t cap;
} sjs_buf;

void sjs_buf_free(sjs_buf* buf);

/* One-shot compression. raw: one block, input below 4 GiB. framed: a complete
 * stream (stream identifier and chunks). level: 1 or 2. */
int sjs_compress(const uint8_t* src, size_t src_size, int level, int format,
                 sjs_buf* out, const char** detail);

/*
 * One-shot decompression. raw: checks the length header against max_output
 * before allocating, then validates the whole block before decoding it.
 * framed: decodes every chunk (concatenated streams included) and fails with
 * SJS_ERR_TRUNCATED unless src ends exactly at the end of a chunk. Empty src
 * is an empty stream.
 * max_output = SIZE_MAX means no limit.
 */
int sjs_decompress(const uint8_t* src, size_t src_size, int format,
                   size_t max_output, sjs_buf* out, const char** detail);

/* Uncompressed length recorded in a raw block's header. Untrusted. */
int sjs_uncompressed_length(const uint8_t* src, size_t src_size, double* size,
                            const char** detail);

typedef struct sjs_cstream sjs_cstream;
typedef struct sjs_dstream sjs_dstream;

/* Framed compression stream. Input is buffered into 64 KiB chunks. */
int sjs_cstream_create(int level, sjs_cstream** stream, const char** detail);
int sjs_cstream_push(sjs_cstream* stream, const uint8_t* src, size_t src_size,
                     int mode, sjs_buf* out, const char** detail);
void sjs_cstream_free(sjs_cstream* stream);

/* Framed decompression stream. Decodes every complete chunk in src. */
int sjs_dstream_create(size_t max_output, sjs_dstream** stream,
                       const char** detail);
int sjs_dstream_push(sjs_dstream* stream, const uint8_t* src, size_t src_size,
                     sjs_buf* out, const char** detail);
/* Call at end of input: fails with SJS_ERR_TRUNCATED if a chunk is unfinished.
 * No input at all is a valid empty stream, as the Go and Rust encoders write
 * it; the format has no end marker, so a cut between chunks is undetectable. */
int sjs_dstream_finish(sjs_dstream* stream, const char** detail);
void sjs_dstream_free(sjs_dstream* stream);

const char* sjs_version(void);
int sjs_min_level(void);
int sjs_max_level(void);
int sjs_default_level(void);

#ifdef __cplusplus
}
#endif

#endif /* SJS_H */
