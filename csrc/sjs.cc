// The snappy-js core. See sjs.h for the interface and conventions.

#if !defined(HAVE_CONFIG_H) || !HAVE_CONFIG_H
#error "Build with -DHAVE_CONFIG_H=1 so snappy reads csrc/snappy-config/config.h."
#endif

#include "sjs.h"

#include <stdlib.h>
#include <string.h>

#include <new>

#include "config.h"
#include "snappy.h"

#if !defined(SJS_SNAPPY_CONFIG_H)
#error "The config.h on the include path is not csrc/snappy-config/config.h."
#endif

// The ARMv8 CRC32C instructions give the same checksums as the table version,
// so using them where the compiler targets them (Apple arm64) is safe.
#if defined(__aarch64__) && defined(__ARM_FEATURE_CRC32) && !defined(__EMSCRIPTEN__)
#include <arm_acle.h>
#define SJS_ARM_CRC32C 1
#else
#define SJS_ARM_CRC32C 0
#endif

namespace {

// framing_format.txt 4.2 and 4.3: a data chunk holds at most 64 KiB.
const size_t kMaxChunkData = 65536;
// The raw format records the uncompressed length as a varint32.
const uint64_t kMaxRawInput = 0xffffffffu;
// Upper bound for the first allocation when decompressing a framed stream,
// whose total size is not recorded anywhere. Output grows past it as needed.
const size_t kInitialCapLimit = (size_t)64 << 20;

const uint8_t kStreamIdentifier[10] = {0xff, 0x06, 0x00, 0x00, 's', 'N', 'a', 'P', 'p', 'Y'};
const uint8_t kChunkCompressed = 0x00;
const uint8_t kChunkUncompressed = 0x01;
const uint8_t kChunkStreamIdentifier = 0xff;

// Pointer handed to snappy for empty input or output, so it never sees NULL.
const uint8_t kEmpty = 0;
uint8_t empty_out = 0;

int Fail(int code, const char* message, const char** detail) {
  if (detail) *detail = message;
  return code;
}

int OutOfMemory(const char** detail) { return Fail(SJS_ERR_NOMEM, "out of memory", detail); }

const char* Chars(const uint8_t* p) { return reinterpret_cast<const char*>(p); }

uint32_t Load32(const uint8_t* p) {
  return p[0] | (p[1] << 8) | (p[2] << 16) | (static_cast<uint32_t>(p[3]) << 24);
}

void Store32(uint8_t* p, uint32_t v) {
  p[0] = static_cast<uint8_t>(v);
  p[1] = static_cast<uint8_t>(v >> 8);
  p[2] = static_cast<uint8_t>(v >> 16);
  p[3] = static_cast<uint8_t>(v >> 24);
}

// Ensures at least min_free bytes of spare capacity, growing by ~1.5x.
int Reserve(sjs_buf* buf, size_t min_free, const char** detail) {
  if (buf->cap - buf->size >= min_free) return SJS_OK;
  if (min_free > SIZE_MAX - buf->size) return OutOfMemory(detail);
  size_t need = buf->size + min_free;
  size_t cap = buf->cap + buf->cap / 2;
  if (cap < buf->cap || cap < need) cap = need;
  uint8_t* data = static_cast<uint8_t*>(realloc(buf->data, cap));
  if (!data && cap != need) {
    cap = need;
    data = static_cast<uint8_t*>(realloc(buf->data, cap));
  }
  if (!data) return OutOfMemory(detail);
  buf->data = data;
  buf->cap = cap;
  return SJS_OK;
}

int Append(sjs_buf* buf, const uint8_t* src, size_t size, const char** detail) {
  int rc = Reserve(buf, size, detail);
  if (rc != SJS_OK) return rc;
  if (size) memcpy(buf->data + buf->size, src, size);
  buf->size += size;
  return SJS_OK;
}

// ---- CRC-32C ------------------------------------------------------------

#if !SJS_ARM_CRC32C
// Slicing-by-8 tables for the reflected Castagnoli polynomial, built on first
// use (thread-safe: a function-local static).
struct Crc32cTables {
  uint32_t t[8][256];
  Crc32cTables() {
    for (uint32_t i = 0; i < 256; i++) {
      uint32_t c = i;
      for (int k = 0; k < 8; k++) c = (c >> 1) ^ (0x82f63b78u & (0u - (c & 1u)));
      t[0][i] = c;
    }
    for (uint32_t i = 0; i < 256; i++) {
      for (int s = 1; s < 8; s++) t[s][i] = (t[s - 1][i] >> 8) ^ t[0][t[s - 1][i] & 0xff];
    }
  }
};

const Crc32cTables& CrcTables() {
  static const Crc32cTables tables;
  return tables;
}
#endif

uint32_t Crc32c(const uint8_t* p, size_t n) {
  uint32_t c = 0xffffffffu;
#if SJS_ARM_CRC32C
  for (; n >= 8; p += 8, n -= 8) {
    uint64_t v;
    memcpy(&v, p, 8);
    c = __crc32cd(c, v);
  }
  for (; n > 0; p++, n--) c = __crc32cb(c, *p);
#else
  const auto& t = CrcTables().t;
  for (; n >= 8; p += 8, n -= 8) {
    const uint32_t lo = c ^ Load32(p);
    const uint32_t hi = Load32(p + 4);
    c = t[7][lo & 0xff] ^ t[6][(lo >> 8) & 0xff] ^ t[5][(lo >> 16) & 0xff] ^ t[4][lo >> 24] ^
        t[3][hi & 0xff] ^ t[2][(hi >> 8) & 0xff] ^ t[1][(hi >> 16) & 0xff] ^ t[0][hi >> 24];
  }
  for (; n > 0; p++, n--) c = (c >> 8) ^ t[0][(c ^ *p) & 0xff];
#endif
  return ~c;
}

// framing_format.txt section 3.
uint32_t MaskedCrc32c(const uint8_t* p, size_t n) {
  const uint32_t c = Crc32c(p, n);
  return ((c >> 15) | (c << 17)) + 0xa282ead8u;
}

// ---- compression ----------------------------------------------------------

bool ValidLevel(int level) {
  return level >= snappy::CompressionOptions::MinCompressionLevel() &&
         level <= snappy::CompressionOptions::MaxCompressionLevel();
}

// Owns the compressor's working memory, so snappy itself never allocates
// (and so never throws std::bad_alloc).
class Workspace {
 public:
  Workspace() = default;
  Workspace(const Workspace&) = delete;
  Workspace& operator=(const Workspace&) = delete;
  ~Workspace() {
    if (ctx_) ctx_->~CompressionContext();
    free(memory_);
  }

  int Init(const char** detail) {
    const size_t size = snappy::CompressionContext::WorkspaceSize();
    memory_ = malloc(size);  // malloc's alignment is what snappy requires
    if (!memory_) return OutOfMemory(detail);
    ctx_ = new (storage_) snappy::CompressionContext(memory_, size);
    return SJS_OK;
  }

  // Compresses src into dst, which has room for MaxCompressedLength(size).
  size_t Compress(const uint8_t* src, size_t size, int level, uint8_t* dst) {
    size_t written = 0;
    snappy::RawCompress(Chars(size ? src : &kEmpty), size, reinterpret_cast<char*>(dst), &written,
                        snappy::CompressionOptions(level), ctx_);
    return written;
  }

 private:
  void* memory_ = nullptr;
  snappy::CompressionContext* ctx_ = nullptr;
  alignas(snappy::CompressionContext) unsigned char storage_[sizeof(snappy::CompressionContext)];
};

int CompressRaw(const uint8_t* src, size_t src_size, int level, sjs_buf* out, const char** detail) {
  if (static_cast<uint64_t>(src_size) > kMaxRawInput) {
    return Fail(SJS_ERR_ARG, "input is too large for a raw snappy block (4 GiB - 1 bytes at most); use the framed format",
                detail);
  }
  const size_t bound = snappy::MaxCompressedLength(src_size);
  if (bound == SIZE_MAX) return Fail(SJS_ERR_ARG, "input too large", detail);
  Workspace ws;
  int rc = ws.Init(detail);
  if (rc == SJS_OK) rc = Reserve(out, bound, detail);
  if (rc == SJS_OK) out->size += ws.Compress(src, src_size, level, out->data + out->size);
  return rc;
}

// Writes one framed data chunk holding src (1 to 65536 bytes). Like the Go
// and Rust encoders, it stores the bytes uncompressed unless compression
// saves at least 12.5%.
int WriteChunk(Workspace* ws, int level, const uint8_t* src, size_t size, sjs_buf* out,
               const char** detail) {
  int rc = Reserve(out, 8 + snappy::MaxCompressedLength(size), detail);
  if (rc != SJS_OK) return rc;
  uint8_t* chunk = out->data + out->size;
  uint8_t type = kChunkCompressed;
  size_t data_size = ws->Compress(src, size, level, chunk + 8);
  if (data_size >= size - size / 8) {
    type = kChunkUncompressed;
    memcpy(chunk + 8, src, size);
    data_size = size;
  }
  const size_t length = 4 + data_size;
  chunk[0] = type;
  chunk[1] = static_cast<uint8_t>(length);
  chunk[2] = static_cast<uint8_t>(length >> 8);
  chunk[3] = static_cast<uint8_t>(length >> 16);
  Store32(chunk + 4, MaskedCrc32c(src, size));
  out->size += 8 + data_size;
  return SJS_OK;
}

// ---- raw decompression ----------------------------------------------------

// Classifies a length header that snappy::GetUncompressedLength rejected.
int ClassifyHeader(const uint8_t* src, size_t size) {
  for (size_t i = 0; i < 5; i++) {
    if (i == size) return SJS_ERR_TRUNCATED;
    if (src[i] < 0x80) return i == 4 && src[i] >= 0x10 ? SJS_ERR_CORRUPT : SJS_ERR_TRUNCATED;
  }
  return SJS_ERR_CORRUPT;  // more than 5 bytes: not a varint32
}

int HeaderError(const uint8_t* src, size_t size, const char** detail) {
  if (ClassifyHeader(src, size) == SJS_ERR_TRUNCATED) {
    return Fail(SJS_ERR_TRUNCATED,
                size ? "snappy input ended inside the block's length header" : "snappy input is empty", detail);
  }
  return Fail(SJS_ERR_CORRUPT, "invalid snappy block: bad length header", detail);
}

// Only called once snappy has rejected a raw block, to pick the error code:
// walks the elements the way snappy's decoder does and reports
// SJS_ERR_TRUNCATED if the input runs out before anything else is wrong.
// It never decides whether a block is valid; snappy already has.
int ClassifyBlock(const uint8_t* src, size_t size) {
  size_t pos = 0;
  uint64_t expected = 0;
  for (int shift = 0;; shift += 7) {
    // In bounds: DecompressRaw only gets here once GetUncompressedLength parsed it.
    const uint8_t b = src[pos++];
    expected |= static_cast<uint64_t>(b & 0x7f) << shift;
    if (b < 0x80) break;
  }
  uint64_t produced = 0;
  while (produced < expected) {
    if (pos == size) return SJS_ERR_TRUNCATED;
    const uint8_t tag = src[pos++];
    uint64_t length;
    size_t extra;
    if ((tag & 3) == 0) {  // literal
      length = (tag >> 2) + 1;
      if (length > 60) {
        extra = static_cast<size_t>(length - 60);
        if (size - pos < extra) return SJS_ERR_TRUNCATED;
        length = 0;
        for (size_t i = 0; i < extra; i++) length |= static_cast<uint64_t>(src[pos + i]) << (8 * i);
        length += 1;
        pos += extra;
      }
      if (length > expected - produced) return SJS_ERR_CORRUPT;
      if (size - pos < length) return SJS_ERR_TRUNCATED;
      pos += static_cast<size_t>(length);
    } else {  // copy with a 1-, 2- or 4-byte offset
      uint64_t offset = 0;
      if ((tag & 3) == 1) {
        length = 4 + ((tag >> 2) & 7);
        extra = 1;
        offset = static_cast<uint64_t>(tag >> 5) << 8;
      } else {
        length = (tag >> 2) + 1;
        extra = (tag & 3) == 2 ? 2 : 4;
      }
      if (size - pos < extra) return SJS_ERR_TRUNCATED;
      for (size_t i = 0; i < extra; i++) offset |= static_cast<uint64_t>(src[pos + i]) << (8 * i);
      pos += extra;
      if (offset == 0 || offset > produced || length > expected - produced) return SJS_ERR_CORRUPT;
    }
    produced += length;
  }
  return SJS_ERR_CORRUPT;  // complete, so something else is wrong (e.g. trailing bytes)
}

int DecompressRaw(const uint8_t* src, size_t src_size, size_t max_output, sjs_buf* out,
                  const char** detail) {
  size_t length = 0;
  if (!snappy::GetUncompressedLength(Chars(src_size ? src : &kEmpty), src_size, &length)) {
    return HeaderError(src, src_size, detail);
  }
  // The header is untrusted: check the limit before allocating anything, and
  // validate every element before allocating the output.
  if (length > max_output) {
    return Fail(SJS_ERR_OUTPUT_LIMIT, "decompressed size exceeds maxOutputSize", detail);
  }
  if (!snappy::IsValidCompressedBuffer(Chars(src), src_size)) {
    return ClassifyBlock(src, src_size) == SJS_ERR_TRUNCATED
               ? Fail(SJS_ERR_TRUNCATED, "snappy input ended before the end of the block", detail)
               : Fail(SJS_ERR_CORRUPT, "invalid snappy block", detail);
  }
  int rc = Reserve(out, length, detail);
  if (rc != SJS_OK) return rc;
  uint8_t* dst = length ? out->data + out->size : &empty_out;
  if (!snappy::RawUncompress(Chars(src), src_size, reinterpret_cast<char*>(dst))) {
    return Fail(SJS_ERR_CORRUPT, "invalid snappy block", detail);
  }
  out->size += length;
  return SJS_OK;
}

}  // namespace

// ---- framed compression stream ----------------------------------------------

struct sjs_cstream {
  int level = 1;
  bool started = false;  // stream identifier written
  Workspace workspace;
  uint8_t* pending = nullptr;  // up to kMaxChunkData bytes of buffered input
  size_t pending_size = 0;

  ~sjs_cstream() { free(pending); }
};

// The stream structs hold C++ members, so they are placement-constructed in
// malloc'd memory: operator new would need exception support in WebAssembly.
template <typename T>
static T* NewStruct() {
  void* memory = malloc(sizeof(T));
  return memory ? new (memory) T() : nullptr;
}

template <typename T>
static void DeleteStruct(T* s) {
  if (!s) return;
  s->~T();
  free(s);
}

extern "C" {

void sjs_buf_free(sjs_buf* buf) {
  if (!buf) return;
  free(buf->data);
  buf->data = nullptr;
  buf->size = 0;
  buf->cap = 0;
}

int sjs_cstream_create(int level, sjs_cstream** stream, const char** detail) {
  *stream = nullptr;
  if (!ValidLevel(level)) return Fail(SJS_ERR_ARG, "compression level out of range", detail);
  sjs_cstream* s = NewStruct<sjs_cstream>();
  if (!s) return OutOfMemory(detail);
  s->level = level;
  int rc = s->workspace.Init(detail);
  if (rc != SJS_OK) {
    DeleteStruct(s);
    return rc;
  }
  *stream = s;
  return SJS_OK;
}

int sjs_cstream_push(sjs_cstream* s, const uint8_t* src, size_t src_size, int mode, sjs_buf* out,
                     const char** detail) {
  int rc;
  if (!s) return Fail(SJS_ERR_ARG, "stream is closed", detail);
  if (mode != SJS_MODE_CONTINUE && mode != SJS_MODE_FLUSH && mode != SJS_MODE_END) {
    return Fail(SJS_ERR_ARG, "invalid stream mode", detail);
  }
  if (!s->started) {
    rc = Append(out, kStreamIdentifier, sizeof(kStreamIdentifier), detail);
    if (rc != SJS_OK) return rc;
    s->started = true;
  }
  // Chunks always hold 64 KiB of input except before a flush, so the output
  // does not depend on how the input was split into pushes.
  if (s->pending_size > 0) {
    size_t take = kMaxChunkData - s->pending_size;
    if (take > src_size) take = src_size;
    memcpy(s->pending + s->pending_size, src, take);
    s->pending_size += take;
    src += take;
    src_size -= take;
    if (s->pending_size == kMaxChunkData) {
      rc = WriteChunk(&s->workspace, s->level, s->pending, kMaxChunkData, out, detail);
      if (rc != SJS_OK) return rc;
      s->pending_size = 0;
    }
  }
  for (; src_size >= kMaxChunkData; src += kMaxChunkData, src_size -= kMaxChunkData) {
    rc = WriteChunk(&s->workspace, s->level, src, kMaxChunkData, out, detail);
    if (rc != SJS_OK) return rc;
  }
  if (src_size > 0) {
    if (!s->pending) {
      s->pending = static_cast<uint8_t*>(malloc(kMaxChunkData));
      if (!s->pending) return OutOfMemory(detail);
    }
    memcpy(s->pending, src, src_size);
    s->pending_size = src_size;
  }
  if (mode != SJS_MODE_CONTINUE && s->pending_size > 0) {
    rc = WriteChunk(&s->workspace, s->level, s->pending, s->pending_size, out, detail);
    if (rc != SJS_OK) return rc;
    s->pending_size = 0;
  }
  return SJS_OK;
}

void sjs_cstream_free(sjs_cstream* s) { DeleteStruct(s); }

}  // extern "C"

// ---- framed decompression stream --------------------------------------------

namespace {

enum class DState { kHeader, kBody, kSkip };

// A compressed chunk decodes to at most 64 KiB, so its data can be no longer
// than the 4-byte checksum plus the most a 64 KiB block compresses to. Longer
// chunks are rejected before being buffered (Go's snappy does the same).
size_t MaxCompressedChunk() { return 4 + snappy::MaxCompressedLength(kMaxChunkData); }

}  // namespace

struct sjs_dstream {
  size_t max_output = 0;
  size_t total_out = 0;
  DState state = DState::kHeader;
  bool seen_identifier = false;
  int failed = SJS_OK;  // once a push fails, the stream stays failed
  const char* failed_detail = nullptr;
  uint8_t header[4] = {0, 0, 0, 0};
  size_t header_size = 0;
  uint8_t type = 0;
  size_t chunk_size = 0;  // bytes after the 4-byte chunk header
  size_t skip_left = 0;
  uint8_t* body = nullptr;  // a chunk split across pushes, gathered here
  size_t body_size = 0;

  ~sjs_dstream() { free(body); }

  int BeginChunk(const char** detail);
  int ProcessChunk(const uint8_t* data, sjs_buf* out, const char** detail);
  int Run(const uint8_t* src, size_t src_size, sjs_buf* out, const char** detail);
};

static const char kNotFramed[] = "not a snappy framed stream: it does not start with the sNaPpY stream identifier";
static const char kBadIdentifier[] = "invalid snappy framed stream: bad stream identifier chunk";

int sjs_dstream::BeginChunk(const char** detail) {
  type = header[0];
  chunk_size = header[1] | (header[2] << 8) | (static_cast<size_t>(header[3]) << 16);
  header_size = 0;
  if (type == kChunkStreamIdentifier) {
    if (chunk_size != 6) return Fail(SJS_ERR_CORRUPT, kBadIdentifier, detail);
    state = DState::kBody;
  } else if (!seen_identifier) {
    return Fail(SJS_ERR_CORRUPT, kNotFramed, detail);
  } else if (type == kChunkCompressed || type == kChunkUncompressed) {
    if (chunk_size < 4) return Fail(SJS_ERR_CORRUPT, "invalid snappy framed stream: chunk too short for its checksum", detail);
    if (type == kChunkUncompressed && chunk_size > 4 + kMaxChunkData) {
      return Fail(SJS_ERR_CORRUPT, "invalid snappy framed stream: uncompressed chunk holds more than 65536 bytes", detail);
    }
    if (type == kChunkCompressed && chunk_size > MaxCompressedChunk()) {
      return Fail(SJS_ERR_CORRUPT, "invalid snappy framed stream: compressed chunk is too long to hold at most 65536 bytes",
                  detail);
    }
    state = DState::kBody;
  } else if (type < 0x80) {
    return Fail(SJS_ERR_CORRUPT, "invalid snappy framed stream: reserved unskippable chunk type (0x02-0x7f)", detail);
  } else {
    // Padding (0xfe) and reserved skippable chunks (0x80-0xfd): skipped
    // without being buffered.
    skip_left = chunk_size;
    state = chunk_size ? DState::kSkip : DState::kHeader;
  }
  return SJS_OK;
}

int sjs_dstream::ProcessChunk(const uint8_t* data, sjs_buf* out, const char** detail) {
  state = DState::kHeader;
  if (type == kChunkStreamIdentifier) {
    // Repeats (from concatenated streams) are ignored if they are exact.
    if (memcmp(data, kStreamIdentifier + 4, 6) != 0) return Fail(SJS_ERR_CORRUPT, kBadIdentifier, detail);
    seen_identifier = true;
    return SJS_OK;
  }
  const uint32_t expected_crc = Load32(data);
  const uint8_t* payload = data + 4;
  const size_t payload_size = chunk_size - 4;
  size_t length = payload_size;
  if (type == kChunkCompressed) {
    if (!snappy::GetUncompressedLength(Chars(payload_size ? payload : &kEmpty), payload_size, &length)) {
      return Fail(SJS_ERR_CORRUPT, "invalid snappy framed stream: bad compressed chunk", detail);
    }
    if (length > kMaxChunkData) {
      return Fail(SJS_ERR_CORRUPT, "invalid snappy framed stream: compressed chunk holds more than 65536 bytes", detail);
    }
  }
  if (length > max_output - total_out) {
    return Fail(SJS_ERR_OUTPUT_LIMIT, "decompressed size exceeds maxOutputSize", detail);
  }
  int rc = Reserve(out, length, detail);
  if (rc != SJS_OK) return rc;
  uint8_t* dst = length ? out->data + out->size : &empty_out;
  if (type == kChunkCompressed) {
    if (!snappy::IsValidCompressedBuffer(Chars(payload), payload_size) ||
        !snappy::RawUncompress(Chars(payload), payload_size, reinterpret_cast<char*>(dst))) {
      return Fail(SJS_ERR_CORRUPT, "invalid snappy framed stream: bad compressed chunk", detail);
    }
  } else if (length) {
    memcpy(dst, payload, length);
  }
  if (MaskedCrc32c(dst, length) != expected_crc) {
    return Fail(SJS_ERR_CORRUPT, "invalid snappy framed stream: checksum mismatch", detail);
  }
  out->size += length;
  total_out += length;
  return SJS_OK;
}

int sjs_dstream::Run(const uint8_t* src, size_t src_size, sjs_buf* out, const char** detail) {
  size_t pos = 0;
  int rc;
  while (pos < src_size) {
    const size_t avail = src_size - pos;
    switch (state) {
      case DState::kSkip: {
        const size_t take = avail < skip_left ? avail : skip_left;
        pos += take;
        skip_left -= take;
        if (skip_left == 0) state = DState::kHeader;
        break;
      }
      case DState::kHeader:
        while (header_size < 4 && pos < src_size) {
          const uint8_t b = src[pos++];
          // Fail on the first wrong byte, so that non-snappy input is
          // reported as such rather than as truncated.
          if (!seen_identifier && b != kStreamIdentifier[header_size]) return Fail(SJS_ERR_CORRUPT, kNotFramed, detail);
          header[header_size++] = b;
        }
        if (header_size == 4) {
          rc = BeginChunk(detail);
          if (rc != SJS_OK) return rc;
        }
        break;
      case DState::kBody:
        if (body_size == 0 && avail >= chunk_size) {
          // The whole chunk is in this push: decode it in place.
          rc = ProcessChunk(src + pos, out, detail);
          if (rc != SJS_OK) return rc;
          pos += chunk_size;
        } else {
          if (!body) {
            body = static_cast<uint8_t*>(malloc(MaxCompressedChunk()));
            if (!body) return OutOfMemory(detail);
          }
          size_t take = chunk_size - body_size;
          if (take > avail) take = avail;
          if (type == kChunkStreamIdentifier && memcmp(src + pos, kStreamIdentifier + 4 + body_size, take) != 0) {
            return Fail(SJS_ERR_CORRUPT, seen_identifier ? kBadIdentifier : kNotFramed, detail);
          }
          memcpy(body + body_size, src + pos, take);
          body_size += take;
          pos += take;
          if (body_size == chunk_size) {
            body_size = 0;
            rc = ProcessChunk(body, out, detail);
            if (rc != SJS_OK) return rc;
          }
        }
        break;
    }
  }
  return SJS_OK;
}

extern "C" {

int sjs_dstream_create(size_t max_output, sjs_dstream** stream, const char** detail) {
  *stream = NewStruct<sjs_dstream>();
  if (!*stream) return OutOfMemory(detail);
  (*stream)->max_output = max_output;
  return SJS_OK;
}

int sjs_dstream_push(sjs_dstream* s, const uint8_t* src, size_t src_size, sjs_buf* out, const char** detail) {
  if (!s) return Fail(SJS_ERR_ARG, "stream is closed", detail);
  if (s->failed != SJS_OK) return Fail(s->failed, s->failed_detail, detail);
  const char* message = nullptr;
  const int rc = s->Run(src, src_size, out, &message);
  if (rc != SJS_OK) {
    s->failed = rc;
    s->failed_detail = message;
  }
  return Fail(rc, message, detail);
}

int sjs_dstream_finish(sjs_dstream* s, const char** detail) {
  if (!s) return Fail(SJS_ERR_ARG, "stream is closed", detail);
  if (s->failed != SJS_OK) return Fail(s->failed, s->failed_detail, detail);
  if (s->state != DState::kHeader || s->header_size != 0) {
    return Fail(SJS_ERR_TRUNCATED, "snappy framed input ended in the middle of a chunk", detail);
  }
  return SJS_OK;
}

void sjs_dstream_free(sjs_dstream* s) { DeleteStruct(s); }

// ---- one-shot -----------------------------------------------------------------

int sjs_compress(const uint8_t* src, size_t src_size, int level, int format, sjs_buf* out,
                 const char** detail) {
  if (!ValidLevel(level)) return Fail(SJS_ERR_ARG, "compression level out of range", detail);
  if (format == SJS_FORMAT_RAW) return CompressRaw(src, src_size, level, out, detail);
  if (format != SJS_FORMAT_FRAMED) return Fail(SJS_ERR_ARG, "invalid format", detail);
  if (src_size > SIZE_MAX / 2) return Fail(SJS_ERR_ARG, "input too large", detail);
  sjs_cstream* s;
  int rc = sjs_cstream_create(level, &s, detail);
  if (rc != SJS_OK) return rc;
  // Each chunk takes at most 8 bytes more than its input (an uncompressed
  // chunk), and writing one needs MaxCompressedLength room for snappy, so
  // this is enough for the whole stream without growing.
  rc = Reserve(out,
               sizeof(kStreamIdentifier) + src_size + (src_size / kMaxChunkData + 1) * 8 +
                   (snappy::MaxCompressedLength(kMaxChunkData) - kMaxChunkData),
               detail);
  if (rc == SJS_OK) rc = sjs_cstream_push(s, src, src_size, SJS_MODE_END, out, detail);
  sjs_cstream_free(s);
  return rc;
}

int sjs_decompress(const uint8_t* src, size_t src_size, int format, size_t max_output, sjs_buf* out,
                   const char** detail) {
  if (format == SJS_FORMAT_RAW) return DecompressRaw(src, src_size, max_output, out, detail);
  if (format != SJS_FORMAT_FRAMED) return Fail(SJS_ERR_ARG, "invalid format", detail);
  sjs_dstream* s;
  int rc = sjs_dstream_create(max_output, &s, detail);
  if (rc != SJS_OK) return rc;
  // Nothing records the total size: start from a guess and let real output
  // drive growth.
  size_t hint = src_size > kInitialCapLimit / 2 ? kInitialCapLimit : src_size * 2;
  if (hint < 65536) hint = 65536;
  if (max_output < SIZE_MAX && hint > max_output) hint = max_output;
  if (hint > 0 && Reserve(out, hint, detail) != SJS_OK && detail) *detail = nullptr;  // not fatal
  rc = sjs_dstream_push(s, src, src_size, out, detail);
  if (rc == SJS_OK) rc = sjs_dstream_finish(s, detail);
  sjs_dstream_free(s);
  return rc;
}

int sjs_uncompressed_length(const uint8_t* src, size_t src_size, double* size, const char** detail) {
  size_t length = 0;
  if (!snappy::GetUncompressedLength(Chars(src_size ? src : &kEmpty), src_size, &length)) {
    return HeaderError(src, src_size, detail);
  }
  *size = static_cast<double>(length);
  return SJS_OK;
}

#define SJS_STR2(x) #x
#define SJS_STR(x) SJS_STR2(x)

const char* sjs_version(void) { return SJS_STR(SNAPPY_MAJOR) "." SJS_STR(SNAPPY_MINOR) "." SJS_STR(SNAPPY_PATCHLEVEL); }
int sjs_min_level(void) { return snappy::CompressionOptions::MinCompressionLevel(); }
int sjs_max_level(void) { return snappy::CompressionOptions::MaxCompressionLevel(); }
int sjs_default_level(void) { return snappy::CompressionOptions::DefaultCompressionLevel(); }

}  // extern "C"
