// Node-API binding. Moves bytes between JavaScript and the sjs core; all
// compression logic lives in sjs.cc.
//
// Errors are thrown (or rejected) as Error objects carrying a numeric
// `sjsCode` property; the TypeScript layer turns them into SnappyError.

#include <napi.h>

#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <string>
#include <vector>

#include "sjs.h"

namespace {

Napi::Error MakeError(Napi::Env env, int code, const char* detail) {
  Napi::Error error = Napi::Error::New(env, detail ? detail : "snappy error");
  error.Value().Set("sjsCode", Napi::Number::New(env, code));
  return error;
}

// Hands an sjs_buf to JavaScript without copying when the runtime allows
// external buffers, and copies otherwise (e.g. Electron's V8 sandbox).
// Leaves `buf` empty either way.
Napi::Buffer<uint8_t> TakeBuffer(Napi::Env env, sjs_buf* buf) {
  if (buf->size == 0) {
    sjs_buf_free(buf);
    return Napi::Buffer<uint8_t>::New(env, 0);
  }
  if (buf->cap - buf->size > 4096) {
    void* shrunk = realloc(buf->data, buf->size);
    if (shrunk) {
      buf->data = static_cast<uint8_t*>(shrunk);
      buf->cap = buf->size;
    }
  }
  uint8_t* data = buf->data;
  size_t size = buf->size;
  buf->data = nullptr;
  buf->size = 0;
  buf->cap = 0;
  return Napi::Buffer<uint8_t>::NewOrCopy(env, data, size,
                                          [](Napi::Env, uint8_t* p) { free(p); });
}

Napi::Uint8Array BytesArg(const Napi::CallbackInfo& info, size_t index, const char* name) {
  Napi::Value v = info[index];
  if (!v.IsTypedArray() || v.As<Napi::TypedArray>().TypedArrayType() != napi_uint8_array) {
    throw Napi::TypeError::New(info.Env(), std::string(name) + " must be a Uint8Array");
  }
  return v.As<Napi::Uint8Array>();
}

int32_t IntArg(const Napi::CallbackInfo& info, size_t index, const char* name) {
  if (!info[index].IsNumber()) {
    throw Napi::TypeError::New(info.Env(), std::string(name) + " must be a number");
  }
  return info[index].As<Napi::Number>().Int32Value();
}

// Number -> size_t limit. Infinity (and anything >= SIZE_MAX) means no limit.
size_t LimitArg(const Napi::CallbackInfo& info, size_t index, const char* name) {
  if (!info[index].IsNumber()) {
    throw Napi::TypeError::New(info.Env(), std::string(name) + " must be a number");
  }
  double d = info[index].As<Napi::Number>().DoubleValue();
  if (std::isnan(d) || d < 0) {
    throw Napi::RangeError::New(info.Env(), std::string(name) + " must be a non-negative number");
  }
  if (std::isinf(d) || d >= static_cast<double>(SIZE_MAX)) return SIZE_MAX;
  return static_cast<size_t>(d);
}

const uint8_t* DataOrNull(const std::vector<uint8_t>& v) {
  return v.empty() ? nullptr : v.data();
}

std::vector<uint8_t> CopyBytes(const Napi::Uint8Array& a) {
  return std::vector<uint8_t>(a.Data(), a.Data() + a.ByteLength());
}

// ---- async one-shot ------------------------------------------------------

class BufferWorker : public Napi::AsyncWorker {
 public:
  explicit BufferWorker(Napi::Env env)
      : Napi::AsyncWorker(env, "snappy-js"), deferred_(Napi::Promise::Deferred::New(env)) {}
  ~BufferWorker() override { sjs_buf_free(&out_); }

  Napi::Promise Promise() { return deferred_.Promise(); }

 protected:
  virtual int Run(sjs_buf* out, const char** detail) = 0;
  virtual void Done() {}

  void Execute() override { rc_ = Run(&out_, &detail_); }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::HandleScope scope(env);
    Done();
    if (rc_ != SJS_OK) {
      deferred_.Reject(MakeError(env, rc_, detail_).Value());
    } else {
      deferred_.Resolve(TakeBuffer(env, &out_));
    }
  }

  void OnError(const Napi::Error& e) override {
    Done();
    deferred_.Reject(e.Value());
  }

 private:
  Napi::Promise::Deferred deferred_;
  sjs_buf out_{};
  int rc_ = SJS_OK;
  const char* detail_ = nullptr;
};

// Inputs are copied: JavaScript may modify or transfer (detach) the source
// ArrayBuffer while the worker runs on another thread.
class CompressWorker : public BufferWorker {
 public:
  CompressWorker(Napi::Env env, std::vector<uint8_t> src, int level, int format)
      : BufferWorker(env), src_(std::move(src)), level_(level), format_(format) {}

 protected:
  int Run(sjs_buf* out, const char** detail) override {
    return sjs_compress(DataOrNull(src_), src_.size(), level_, format_, out, detail);
  }

 private:
  std::vector<uint8_t> src_;
  int level_;
  int format_;
};

class DecompressWorker : public BufferWorker {
 public:
  DecompressWorker(Napi::Env env, std::vector<uint8_t> src, int format, size_t max_output)
      : BufferWorker(env), src_(std::move(src)), format_(format), max_output_(max_output) {}

 protected:
  int Run(sjs_buf* out, const char** detail) override {
    return sjs_decompress(DataOrNull(src_), src_.size(), format_, max_output_, out, detail);
  }

 private:
  std::vector<uint8_t> src_;
  int format_;
  size_t max_output_;
};

// compressSync(data, level, format): Buffer
Napi::Value CompressSync(const Napi::CallbackInfo& info) {
  Napi::Uint8Array src = BytesArg(info, 0, "data");
  int level = IntArg(info, 1, "level");
  int format = IntArg(info, 2, "format");
  sjs_buf out{};
  const char* detail = nullptr;
  int rc = sjs_compress(src.Data(), src.ByteLength(), level, format, &out, &detail);
  if (rc != SJS_OK) {
    sjs_buf_free(&out);
    throw MakeError(info.Env(), rc, detail);
  }
  return TakeBuffer(info.Env(), &out);
}

// compress(data, level, format): Promise<Buffer>
Napi::Value Compress(const Napi::CallbackInfo& info) {
  Napi::Uint8Array src = BytesArg(info, 0, "data");
  int level = IntArg(info, 1, "level");
  int format = IntArg(info, 2, "format");
  auto* worker = new CompressWorker(info.Env(), CopyBytes(src), level, format);
  Napi::Promise promise = worker->Promise();
  worker->Queue();
  return promise;
}

// decompressSync(data, format, maxOutput): Buffer
Napi::Value DecompressSync(const Napi::CallbackInfo& info) {
  Napi::Uint8Array src = BytesArg(info, 0, "data");
  int format = IntArg(info, 1, "format");
  size_t max_output = LimitArg(info, 2, "maxOutputSize");
  sjs_buf out{};
  const char* detail = nullptr;
  int rc = sjs_decompress(src.Data(), src.ByteLength(), format, max_output, &out, &detail);
  if (rc != SJS_OK) {
    sjs_buf_free(&out);
    throw MakeError(info.Env(), rc, detail);
  }
  return TakeBuffer(info.Env(), &out);
}

// decompress(data, format, maxOutput): Promise<Buffer>
Napi::Value Decompress(const Napi::CallbackInfo& info) {
  Napi::Uint8Array src = BytesArg(info, 0, "data");
  int format = IntArg(info, 1, "format");
  size_t max_output = LimitArg(info, 2, "maxOutputSize");
  auto* worker = new DecompressWorker(info.Env(), CopyBytes(src), format, max_output);
  Napi::Promise promise = worker->Promise();
  worker->Queue();
  return promise;
}

// uncompressedLength(data): number
Napi::Value UncompressedLength(const Napi::CallbackInfo& info) {
  Napi::Uint8Array src = BytesArg(info, 0, "data");
  double size = 0;
  const char* detail = nullptr;
  int rc = sjs_uncompressed_length(src.Data(), src.ByteLength(), &size, &detail);
  if (rc != SJS_OK) throw MakeError(info.Env(), rc, detail);
  return Napi::Number::New(info.Env(), size);
}

// ---- streams ---------------------------------------------------------------

// Shared by CStream and DStream: one operation at a time, and the JS object
// stays referenced while a worker uses the native context, so the garbage
// collector cannot free the context underneath it. T provides FreeContext().
template <typename T>
class StreamBase : public Napi::ObjectWrap<T> {
 public:
  using Napi::ObjectWrap<T>::ObjectWrap;

  void Acquire(Napi::Env env) {
    if (closed_) throw MakeError(env, SJS_ERR_ARG, "stream is closed");
    if (busy_) throw MakeError(env, SJS_ERR_ARG, "stream is busy: wait for the previous push to finish");
    busy_ = true;
  }
  void Release() {
    busy_ = false;
    if (closed_) static_cast<T*>(this)->FreeContext();
  }

 protected:
  // close(): frees the context now, or as soon as an in-flight push finishes
  // (a stream cancelled mid-push, e.g. an aborted fetch, must not throw).
  Napi::Value Close(const Napi::CallbackInfo& info) {
    closed_ = true;
    if (!busy_) static_cast<T*>(this)->FreeContext();
    return info.Env().Undefined();
  }

  bool busy_ = false;
  bool closed_ = false;
};

class StreamPushWorker : public BufferWorker {
 public:
  using Job = int (*)(void* ctx, const uint8_t* src, size_t size, int mode, sjs_buf* out,
                      const char** detail);
  StreamPushWorker(Napi::Env env, Napi::Object owner, void* ctx, Job job,
                   std::vector<uint8_t> src, int mode, void (*release)(Napi::Object))
      : BufferWorker(env), ctx_(ctx), job_(job), src_(std::move(src)), mode_(mode),
        release_(release) {
    owner_ = Napi::Persistent(owner);
  }

 protected:
  int Run(sjs_buf* out, const char** detail) override {
    return job_(ctx_, DataOrNull(src_), src_.size(), mode_, out, detail);
  }
  void Done() override {
    release_(owner_.Value());
    owner_.Reset();
  }

 private:
  void* ctx_;
  Job job_;
  std::vector<uint8_t> src_;
  int mode_;
  void (*release_)(Napi::Object);
  Napi::ObjectReference owner_;
};

class CStream : public StreamBase<CStream> {
 public:
  static Napi::Function Init(Napi::Env env) {
    return DefineClass(env, "CStream",
                       {InstanceMethod("push", &CStream::Push),
                        InstanceMethod("pushAsync", &CStream::PushAsync),
                        InstanceMethod("close", &CStream::Close)});
  }

  // new CStream(level)
  explicit CStream(const Napi::CallbackInfo& info) : StreamBase<CStream>(info) {
    int level = IntArg(info, 0, "level");
    const char* detail = nullptr;
    int rc = sjs_cstream_create(level, &stream_, &detail);
    if (rc != SJS_OK) throw MakeError(info.Env(), rc, detail);
  }
  ~CStream() override { sjs_cstream_free(stream_); }

 private:
  static int Job(void* ctx, const uint8_t* src, size_t size, int mode, sjs_buf* out,
                 const char** detail) {
    return sjs_cstream_push(static_cast<sjs_cstream*>(ctx), src, size, mode, out, detail);
  }
  static void ReleaseOwner(Napi::Object owner) { CStream::Unwrap(owner)->Release(); }

  // push(chunk, mode): Buffer
  Napi::Value Push(const Napi::CallbackInfo& info) {
    Napi::Uint8Array chunk = BytesArg(info, 0, "chunk");
    int mode = IntArg(info, 1, "mode");
    Acquire(info.Env());
    sjs_buf out{};
    const char* detail = nullptr;
    int rc = sjs_cstream_push(stream_, chunk.Data(), chunk.ByteLength(), mode, &out, &detail);
    Release();
    if (rc != SJS_OK) {
      sjs_buf_free(&out);
      throw MakeError(info.Env(), rc, detail);
    }
    return TakeBuffer(info.Env(), &out);
  }

  // pushAsync(chunk, mode): Promise<Buffer>
  Napi::Value PushAsync(const Napi::CallbackInfo& info) {
    Napi::Uint8Array chunk = BytesArg(info, 0, "chunk");
    int mode = IntArg(info, 1, "mode");
    Acquire(info.Env());
    auto* worker = new StreamPushWorker(info.Env(), info.This().As<Napi::Object>(), stream_, Job,
                                        CopyBytes(chunk), mode, ReleaseOwner);
    Napi::Promise promise = worker->Promise();
    worker->Queue();
    return promise;
  }

  friend class StreamBase<CStream>;
  void FreeContext() {
    sjs_cstream_free(stream_);
    stream_ = nullptr;
  }

  sjs_cstream* stream_ = nullptr;
};

class DStream : public StreamBase<DStream> {
 public:
  static Napi::Function Init(Napi::Env env) {
    return DefineClass(env, "DStream",
                       {InstanceMethod("push", &DStream::Push),
                        InstanceMethod("pushAsync", &DStream::PushAsync),
                        InstanceMethod("finish", &DStream::Finish),
                        InstanceMethod("close", &DStream::Close)});
  }

  // new DStream(maxOutput)
  explicit DStream(const Napi::CallbackInfo& info) : StreamBase<DStream>(info) {
    size_t max_output = LimitArg(info, 0, "maxOutputSize");
    const char* detail = nullptr;
    int rc = sjs_dstream_create(max_output, &stream_, &detail);
    if (rc != SJS_OK) throw MakeError(info.Env(), rc, detail);
  }
  ~DStream() override { sjs_dstream_free(stream_); }

 private:
  static int Job(void* ctx, const uint8_t* src, size_t size, int /*mode*/, sjs_buf* out,
                 const char** detail) {
    return sjs_dstream_push(static_cast<sjs_dstream*>(ctx), src, size, out, detail);
  }
  static void ReleaseOwner(Napi::Object owner) { DStream::Unwrap(owner)->Release(); }

  // push(chunk): Buffer
  Napi::Value Push(const Napi::CallbackInfo& info) {
    Napi::Uint8Array chunk = BytesArg(info, 0, "chunk");
    Acquire(info.Env());
    sjs_buf out{};
    const char* detail = nullptr;
    int rc = sjs_dstream_push(stream_, chunk.Data(), chunk.ByteLength(), &out, &detail);
    Release();
    if (rc != SJS_OK) {
      sjs_buf_free(&out);
      throw MakeError(info.Env(), rc, detail);
    }
    return TakeBuffer(info.Env(), &out);
  }

  // pushAsync(chunk): Promise<Buffer>
  Napi::Value PushAsync(const Napi::CallbackInfo& info) {
    Napi::Uint8Array chunk = BytesArg(info, 0, "chunk");
    Acquire(info.Env());
    auto* worker = new StreamPushWorker(info.Env(), info.This().As<Napi::Object>(), stream_, Job,
                                        CopyBytes(chunk), 0, ReleaseOwner);
    Napi::Promise promise = worker->Promise();
    worker->Queue();
    return promise;
  }

  // finish(): throws if the input ended inside a chunk
  Napi::Value Finish(const Napi::CallbackInfo& info) {
    Acquire(info.Env());
    const char* detail = nullptr;
    int rc = sjs_dstream_finish(stream_, &detail);
    Release();
    if (rc != SJS_OK) throw MakeError(info.Env(), rc, detail);
    return info.Env().Undefined();
  }

  friend class StreamBase<DStream>;
  void FreeContext() {
    sjs_dstream_free(stream_);
    stream_ = nullptr;
  }

  sjs_dstream* stream_ = nullptr;
};

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("compressSync", Napi::Function::New(env, CompressSync));
  exports.Set("compress", Napi::Function::New(env, Compress));
  exports.Set("decompressSync", Napi::Function::New(env, DecompressSync));
  exports.Set("decompress", Napi::Function::New(env, Decompress));
  exports.Set("uncompressedLength", Napi::Function::New(env, UncompressedLength));
  exports.Set("version", Napi::String::New(env, sjs_version()));
  exports.Set("minLevel", Napi::Number::New(env, sjs_min_level()));
  exports.Set("maxLevel", Napi::Number::New(env, sjs_max_level()));
  exports.Set("defaultLevel", Napi::Number::New(env, sjs_default_level()));
  exports.Set("CStream", CStream::Init(env));
  exports.Set("DStream", DStream::Init(env));
  return exports;
}

}  // namespace

NODE_API_MODULE(snappy_js, Init)
