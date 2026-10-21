// JSI binding. Moves bytes between JavaScript and the sjs C layer; all
// compression logic lives in csrc/sjs.cc. Mirrors csrc/addon.cc: the same
// methods, arguments and errors (Error objects carrying a numeric `sjsCode`,
// which the TypeScript layer turns into SnappyError).
//
// Threading: synchronous methods run on the JS thread. Async methods copy their
// inputs on the JS thread, run on a small worker pool, and settle their promise
// back on the JS thread through the CallInvoker. Workers never touch JSI values:
// they carry a promise id and plain bytes, so a job that finishes after a reload
// or teardown finds nothing to settle. The pending resolve/reject functions live
// in the module, which React Native destroys before its runtime.

#include "KodespireSnappyModule.h"

#include <algorithm>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <deque>
#include <functional>
#include <mutex>
#include <new>
#include <string>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

#include <pthread.h>

#include "sjs.h"

namespace facebook::react {
namespace kodespire_snappy {

// ---- worker pool -----------------------------------------------------------

// A fixed set of threads shared by every runtime. Never destroyed: a job may
// still be running when the process exits.
class WorkerPool {
 public:
  static WorkerPool& shared() {
    static WorkerPool* pool = new WorkerPool();
    return *pool;
  }

  void submit(std::function<void()> job) {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      queue_.push_back(std::move(job));
    }
    ready_.notify_one();
  }

 private:
  WorkerPool() {
    unsigned cores = std::thread::hardware_concurrency();
    unsigned count = std::clamp(cores > 1 ? cores - 1 : 1u, 1u, 4u);
    for (unsigned i = 0; i < count; i++) std::thread([this] { Run(); }).detach();
  }

  void Run() {
#if defined(__APPLE__)
    pthread_setname_np("snappy-js");
#else
    pthread_setname_np(pthread_self(), "snappy-js");
#endif
    for (;;) {
      std::function<void()> job;
      {
        std::unique_lock<std::mutex> lock(mutex_);
        ready_.wait(lock, [this] { return !queue_.empty(); });
        job = std::move(queue_.front());
        queue_.pop_front();
      }
      job();
    }
  }

  std::mutex mutex_;
  std::condition_variable ready_;
  std::deque<std::function<void()>> queue_;
};

// ---- bytes and errors --------------------------------------------------------

// Hands a sjs_buf to JavaScript as an ArrayBuffer without copying. Leaves `buf` empty.
class OwnedBuffer : public jsi::MutableBuffer {
 public:
  explicit OwnedBuffer(sjs_buf* buf) : buf_(*buf) {
    *buf = sjs_buf{};
    if (buf_.cap - buf_.size > 4096) {
      void* shrunk = realloc(buf_.data, buf_.size > 0 ? buf_.size : 1);
      if (shrunk) {
        buf_.data = static_cast<uint8_t*>(shrunk);
        buf_.cap = buf_.size;
      }
    }
  }
  ~OwnedBuffer() override { sjs_buf_free(&buf_); }
  size_t size() const override { return buf_.size; }
  uint8_t* data() override { return buf_.data ? buf_.data : &empty_; }

 private:
  sjs_buf buf_;
  uint8_t empty_ = 0;
};

jsi::Value TakeBuffer(jsi::Runtime& rt, sjs_buf* buf) {
  return jsi::ArrayBuffer(rt, std::make_shared<OwnedBuffer>(buf));
}

jsi::Value MakeError(jsi::Runtime& rt, int code, const char* detail) {
  jsi::Object error = rt.global()
                          .getPropertyAsFunction(rt, "Error")
                          .callAsConstructor(rt, jsi::String::createFromUtf8(rt, detail ? detail : "snappy error"))
                          .asObject(rt);
  error.setProperty(rt, "sjsCode", code);
  return jsi::Value(std::move(error));
}

[[noreturn]] void ThrowError(jsi::Runtime& rt, int code, const char* detail) {
  throw jsi::JSError(rt, MakeError(rt, code, detail));
}

[[noreturn]] void ThrowJsError(jsi::Runtime& rt, const char* type, const std::string& message) {
  jsi::Value error =
      rt.global().getPropertyAsFunction(rt, type).callAsConstructor(rt, jsi::String::createFromUtf8(rt, message));
  throw jsi::JSError(rt, std::move(error));
}

[[noreturn]] void ThrowTypeError(jsi::Runtime& rt, const std::string& message) {
  ThrowJsError(rt, "TypeError", message);
}

struct Bytes {
  const uint8_t* data = nullptr;
  size_t size = 0;
};

// A Uint8Array argument, read through its buffer, byteOffset and byteLength
// (JSI has no typed-array API before React Native 0.85).
Bytes BytesArg(jsi::Runtime& rt, const jsi::Value* args, size_t count, size_t index, const char* name) {
  const std::string message = std::string(name) + " must be a Uint8Array";
  if (index >= count || !args[index].isObject()) ThrowTypeError(rt, message);
  jsi::Object view = args[index].getObject(rt);
  if (!view.instanceOf(rt, rt.global().getPropertyAsFunction(rt, "Uint8Array"))) ThrowTypeError(rt, message);
  jsi::Value buffer = view.getProperty(rt, "buffer");
  jsi::Value offset = view.getProperty(rt, "byteOffset");
  jsi::Value length = view.getProperty(rt, "byteLength");
  if (!buffer.isObject() || !buffer.getObject(rt).isArrayBuffer(rt) || !offset.isNumber() || !length.isNumber()) {
    ThrowTypeError(rt, message);
  }
  jsi::ArrayBuffer array = buffer.getObject(rt).getArrayBuffer(rt);
  double start = offset.getNumber();
  double size = length.getNumber();
  if (start < 0 || size < 0 || start + size > static_cast<double>(array.size(rt))) ThrowTypeError(rt, message);
  return {array.data(rt) + static_cast<size_t>(start), static_cast<size_t>(size)};
}

// Copies an input for a worker thread. Running out of memory here is an
// ordinary SnappyError, not a process abort.
std::vector<uint8_t> Copy(jsi::Runtime& rt, Bytes bytes) {
  try {
    return std::vector<uint8_t>(bytes.data, bytes.data + bytes.size);
  } catch (const std::bad_alloc&) {
    ThrowError(rt, SJS_ERR_NOMEM, "out of memory");
  }
}

const uint8_t* DataOrNull(const std::vector<uint8_t>& v) {
  return v.empty() ? nullptr : v.data();
}

int32_t IntArg(jsi::Runtime& rt, const jsi::Value* args, size_t count, size_t index, const char* name) {
  if (index >= count || !args[index].isNumber()) ThrowTypeError(rt, std::string(name) + " must be a number");
  double d = args[index].getNumber();
  return std::isfinite(d) ? static_cast<int32_t>(std::clamp(d, -2147483648.0, 2147483647.0)) : 0;
}

// Number -> size_t limit. Infinity (and anything >= SIZE_MAX) means no limit.
size_t LimitArg(jsi::Runtime& rt, const jsi::Value* args, size_t count, size_t index, const char* name) {
  if (index >= count || !args[index].isNumber()) ThrowTypeError(rt, std::string(name) + " must be a number");
  double d = args[index].getNumber();
  if (std::isnan(d) || d < 0) ThrowJsError(rt, "RangeError", std::string(name) + " must be a non-negative number");
  if (std::isinf(d) || d >= static_cast<double>(SIZE_MAX)) return SIZE_MAX;
  return static_cast<size_t>(d);
}

jsi::Function MakeFunction(jsi::Runtime& rt, const char* name, unsigned int length, jsi::HostFunctionType fn) {
  return jsi::Function::createFromHostFunction(rt, jsi::PropNameID::forAscii(rt, name), length, std::move(fn));
}

// ---- async -------------------------------------------------------------------

struct Result {
  int rc = SJS_OK;
  const char* detail = nullptr;
  sjs_buf out{};
  ~Result() { sjs_buf_free(&out); }
};

class Promises {
 public:
  // Creates a promise whose resolve/reject stay here, on the JS thread, until settle().
  jsi::Value Create(jsi::Runtime& rt, uint64_t* id) {
    uint64_t key = next_++;
    jsi::Function executor =
        MakeFunction(rt, "executor", 2, [this, key](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t) {
          pending_.emplace(key, Pending{args[0].getObject(rt).getFunction(rt), args[1].getObject(rt).getFunction(rt)});
          return jsi::Value::undefined();
        });
    jsi::Value promise = rt.global().getPropertyAsFunction(rt, "Promise").callAsConstructor(rt, executor);
    *id = key;
    return promise;
  }

  void Settle(jsi::Runtime& rt, uint64_t id, Result& result) {
    auto it = pending_.find(id);
    if (it == pending_.end()) return;
    Pending pending = std::move(it->second);
    pending_.erase(it);
    if (result.rc == SJS_OK) {
      pending.resolve.call(rt, TakeBuffer(rt, &result.out));
    } else {
      pending.reject.call(rt, MakeError(rt, result.rc, result.detail));
    }
  }

 private:
  struct Pending {
    jsi::Function resolve;
    jsi::Function reject;
  };
  std::unordered_map<uint64_t, Pending> pending_;
  uint64_t next_ = 1;
};

using Job = std::function<int(sjs_buf* out, const char** detail)>;

// Runs `job` on the worker pool and returns a promise for its output. `done`
// runs on the JS thread before the promise settles (streams use it to release
// their context); it is dropped unrun if the runtime has gone away.
jsi::Value RunAsync(jsi::Runtime& rt, const std::shared_ptr<Promises>& promises,
                    const std::weak_ptr<CallInvoker>& invoker, Job job, std::function<void()> done = nullptr) {
  uint64_t id = 0;
  jsi::Value promise = promises->Create(rt, &id);
  std::weak_ptr<Promises> weakPromises = promises;
  WorkerPool::shared().submit([job = std::move(job), done = std::move(done), weakPromises, invoker, id]() {
    auto result = std::make_shared<Result>();
    result->rc = job(&result->out, &result->detail);
    std::shared_ptr<CallInvoker> jsInvoker = invoker.lock();
    if (!jsInvoker) return;
    jsInvoker->invokeAsync([weakPromises, id, result, done](jsi::Runtime& rt) {
      if (done) done();
      if (std::shared_ptr<Promises> live = weakPromises.lock()) live->Settle(rt, id, *result);
    });
  });
  return promise;
}

// ---- streams -----------------------------------------------------------------

// One operation at a time per stream. The context is freed by close() (or,
// when a push is in flight, as soon as it finishes) or with the last reference:
// the JS object and any in-flight job each hold one. `busy` and `closed` are
// only read and written on the JS thread.
template <typename Context, void (*Free)(Context*)>
struct StreamState {
  Context* context = nullptr;
  bool busy = false;
  bool closed = false;

  ~StreamState() { Free(context); }

  void Acquire(jsi::Runtime& rt) {
    if (closed) ThrowError(rt, SJS_ERR_ARG, "stream is closed");
    if (busy) ThrowError(rt, SJS_ERR_ARG, "stream is busy: wait for the previous push to finish");
    busy = true;
  }
  void Release() {
    busy = false;
    if (closed) FreeContext();
  }
  void Close() {
    closed = true;
    if (!busy) FreeContext();
  }
  void FreeContext() {
    Free(context);
    context = nullptr;
  }
};

using CState = StreamState<sjs_cstream, sjs_cstream_free>;
using DState = StreamState<sjs_dstream, sjs_dstream_free>;

// Exposes a stream's methods as plain functions, so they work detached from the object.
class StreamObject : public jsi::HostObject {
 public:
  using Methods = std::unordered_map<std::string, std::function<jsi::Function(jsi::Runtime&)>>;
  explicit StreamObject(Methods methods) : methods_(std::move(methods)) {}

  jsi::Value get(jsi::Runtime& rt, const jsi::PropNameID& name) override {
    auto it = methods_.find(name.utf8(rt));
    if (it == methods_.end()) return jsi::Value::undefined();
    return it->second(rt);
  }

  std::vector<jsi::PropNameID> getPropertyNames(jsi::Runtime& rt) override {
    std::vector<jsi::PropNameID> names;
    for (const auto& entry : methods_) names.push_back(jsi::PropNameID::forUtf8(rt, entry.first));
    return names;
  }

 private:
  Methods methods_;
};

jsi::Value MakeCStream(jsi::Runtime& rt, KodespireSnappyModule& module, const jsi::Value* args, size_t count) {
  int level = IntArg(rt, args, count, 0, "level");
  auto state = std::make_shared<CState>();
  const char* detail = nullptr;
  int rc = sjs_cstream_create(level, &state->context, &detail);
  if (rc != SJS_OK) ThrowError(rt, rc, detail);

  std::shared_ptr<Promises> promises = module.promises();
  std::weak_ptr<CallInvoker> invoker = module.invoker();
  StreamObject::Methods methods;
  // push(chunk, mode): ArrayBuffer
  methods["push"] = [state](jsi::Runtime& rt) {
    return MakeFunction(rt, "push", 2, [state](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) {
      Bytes chunk = BytesArg(rt, args, count, 0, "chunk");
      int mode = IntArg(rt, args, count, 1, "mode");
      state->Acquire(rt);
      sjs_buf out{};
      const char* detail = nullptr;
      int rc = sjs_cstream_push(state->context, chunk.data, chunk.size, mode, &out, &detail);
      state->Release();
      if (rc != SJS_OK) {
        sjs_buf_free(&out);
        ThrowError(rt, rc, detail);
      }
      return TakeBuffer(rt, &out);
    });
  };
  // pushAsync(chunk, mode): Promise<ArrayBuffer>
  methods["pushAsync"] = [state, promises, invoker](jsi::Runtime& rt) {
    return MakeFunction(rt, "pushAsync", 2,
                        [state, promises, invoker](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) {
                          std::vector<uint8_t> chunk = Copy(rt, BytesArg(rt, args, count, 0, "chunk"));
                          int mode = IntArg(rt, args, count, 1, "mode");
                          state->Acquire(rt);
                          try {
                            return RunAsync(
                                rt, promises, invoker,
                                [state, chunk = std::move(chunk), mode](sjs_buf* out, const char** detail) {
                                  return sjs_cstream_push(state->context, DataOrNull(chunk), chunk.size(), mode, out, detail);
                                },
                                [state] { state->Release(); });
                          } catch (...) {
                            state->Release();
                            throw;
                          }
                        });
  };
  // close(): frees the context now, or once an in-flight push finishes
  methods["close"] = [state](jsi::Runtime& rt) {
    return MakeFunction(rt, "close", 0, [state](jsi::Runtime&, const jsi::Value&, const jsi::Value*, size_t) {
      state->Close();
      return jsi::Value::undefined();
    });
  };
  return jsi::Object::createFromHostObject(rt, std::make_shared<StreamObject>(std::move(methods)));
}

jsi::Value MakeDStream(jsi::Runtime& rt, KodespireSnappyModule& module, const jsi::Value* args, size_t count) {
  size_t maxOutput = LimitArg(rt, args, count, 0, "maxOutputSize");
  auto state = std::make_shared<DState>();
  const char* detail = nullptr;
  int rc = sjs_dstream_create(maxOutput, &state->context, &detail);
  if (rc != SJS_OK) ThrowError(rt, rc, detail);

  std::shared_ptr<Promises> promises = module.promises();
  std::weak_ptr<CallInvoker> invoker = module.invoker();
  StreamObject::Methods methods;
  // push(chunk): ArrayBuffer
  methods["push"] = [state](jsi::Runtime& rt) {
    return MakeFunction(rt, "push", 1, [state](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) {
      Bytes chunk = BytesArg(rt, args, count, 0, "chunk");
      state->Acquire(rt);
      sjs_buf out{};
      const char* detail = nullptr;
      int rc = sjs_dstream_push(state->context, chunk.data, chunk.size, &out, &detail);
      state->Release();
      if (rc != SJS_OK) {
        sjs_buf_free(&out);
        ThrowError(rt, rc, detail);
      }
      return TakeBuffer(rt, &out);
    });
  };
  // pushAsync(chunk): Promise<ArrayBuffer>
  methods["pushAsync"] = [state, promises, invoker](jsi::Runtime& rt) {
    return MakeFunction(rt, "pushAsync", 1,
                        [state, promises, invoker](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) {
                          std::vector<uint8_t> chunk = Copy(rt, BytesArg(rt, args, count, 0, "chunk"));
                          state->Acquire(rt);
                          try {
                            return RunAsync(
                                rt, promises, invoker,
                                [state, chunk = std::move(chunk)](sjs_buf* out, const char** detail) {
                                  return sjs_dstream_push(state->context, DataOrNull(chunk), chunk.size(), out, detail);
                                },
                                [state] { state->Release(); });
                          } catch (...) {
                            state->Release();
                            throw;
                          }
                        });
  };
  // finish(): throws if the input ended inside a chunk
  methods["finish"] = [state](jsi::Runtime& rt) {
    return MakeFunction(rt, "finish", 0, [state](jsi::Runtime& rt, const jsi::Value&, const jsi::Value*, size_t) {
      state->Acquire(rt);
      const char* detail = nullptr;
      int rc = sjs_dstream_finish(state->context, &detail);
      state->Release();
      if (rc != SJS_OK) ThrowError(rt, rc, detail);
      return jsi::Value::undefined();
    });
  };
  methods["close"] = [state](jsi::Runtime& rt) {
    return MakeFunction(rt, "close", 0, [state](jsi::Runtime&, const jsi::Value&, const jsi::Value*, size_t) {
      state->Close();
      return jsi::Value::undefined();
    });
  };
  return jsi::Object::createFromHostObject(rt, std::make_shared<StreamObject>(std::move(methods)));
}

// ---- module methods ------------------------------------------------------------

KodespireSnappyModule& Self(TurboModule& module) {
  return static_cast<KodespireSnappyModule&>(module);
}

// version(): string
jsi::Value Version(jsi::Runtime& rt, TurboModule&, const jsi::Value*, size_t) {
  return jsi::String::createFromUtf8(rt, sjs_version());
}

// compressSync(data, level, format): ArrayBuffer
jsi::Value CompressSync(jsi::Runtime& rt, TurboModule&, const jsi::Value* args, size_t count) {
  Bytes src = BytesArg(rt, args, count, 0, "data");
  int level = IntArg(rt, args, count, 1, "level");
  int format = IntArg(rt, args, count, 2, "format");
  sjs_buf out{};
  const char* detail = nullptr;
  int rc = sjs_compress(src.data, src.size, level, format, &out, &detail);
  if (rc != SJS_OK) {
    sjs_buf_free(&out);
    ThrowError(rt, rc, detail);
  }
  return TakeBuffer(rt, &out);
}

// compress(data, level, format): Promise<ArrayBuffer>
// The input is copied: JavaScript may change the source while the job runs.
jsi::Value Compress(jsi::Runtime& rt, TurboModule& module, const jsi::Value* args, size_t count) {
  std::vector<uint8_t> src = Copy(rt, BytesArg(rt, args, count, 0, "data"));
  int level = IntArg(rt, args, count, 1, "level");
  int format = IntArg(rt, args, count, 2, "format");
  return RunAsync(rt, Self(module).promises(), Self(module).invoker(),
                  [src = std::move(src), level, format](sjs_buf* out, const char** detail) {
                    return sjs_compress(DataOrNull(src), src.size(), level, format, out, detail);
                  });
}

// decompressSync(data, format, maxOutput): ArrayBuffer
jsi::Value DecompressSync(jsi::Runtime& rt, TurboModule&, const jsi::Value* args, size_t count) {
  Bytes src = BytesArg(rt, args, count, 0, "data");
  int format = IntArg(rt, args, count, 1, "format");
  size_t maxOutput = LimitArg(rt, args, count, 2, "maxOutputSize");
  sjs_buf out{};
  const char* detail = nullptr;
  int rc = sjs_decompress(src.data, src.size, format, maxOutput, &out, &detail);
  if (rc != SJS_OK) {
    sjs_buf_free(&out);
    ThrowError(rt, rc, detail);
  }
  return TakeBuffer(rt, &out);
}

// decompress(data, format, maxOutput): Promise<ArrayBuffer>
jsi::Value Decompress(jsi::Runtime& rt, TurboModule& module, const jsi::Value* args, size_t count) {
  std::vector<uint8_t> src = Copy(rt, BytesArg(rt, args, count, 0, "data"));
  int format = IntArg(rt, args, count, 1, "format");
  size_t maxOutput = LimitArg(rt, args, count, 2, "maxOutputSize");
  return RunAsync(rt, Self(module).promises(), Self(module).invoker(),
                  [src = std::move(src), format, maxOutput](sjs_buf* out, const char** detail) {
                    return sjs_decompress(DataOrNull(src), src.size(), format, maxOutput, out, detail);
                  });
}

// uncompressedLength(data): number (from a raw block's header; untrusted)
jsi::Value UncompressedLength(jsi::Runtime& rt, TurboModule&, const jsi::Value* args, size_t count) {
  Bytes src = BytesArg(rt, args, count, 0, "data");
  double size = 0;
  const char* detail = nullptr;
  int rc = sjs_uncompressed_length(src.data, src.size, &size, &detail);
  if (rc != SJS_OK) ThrowError(rt, rc, detail);
  return size;
}

// createCStream(level): { push, pushAsync, close }
jsi::Value CreateCStream(jsi::Runtime& rt, TurboModule& module, const jsi::Value* args, size_t count) {
  return MakeCStream(rt, Self(module), args, count);
}

// createDStream(maxOutput): { push, pushAsync, finish, close }
jsi::Value CreateDStream(jsi::Runtime& rt, TurboModule& module, const jsi::Value* args, size_t count) {
  return MakeDStream(rt, Self(module), args, count);
}

}  // namespace kodespire_snappy

KodespireSnappyModule::KodespireSnappyModule(std::shared_ptr<CallInvoker> jsInvoker)
    : TurboModule(kModuleName, std::move(jsInvoker)), promises_(std::make_shared<kodespire_snappy::Promises>()) {
  using namespace kodespire_snappy;
  methodMap_["version"] = MethodMetadata{0, Version};
  methodMap_["compressSync"] = MethodMetadata{3, CompressSync};
  methodMap_["compress"] = MethodMetadata{3, Compress};
  methodMap_["decompressSync"] = MethodMetadata{3, DecompressSync};
  methodMap_["decompress"] = MethodMetadata{3, Decompress};
  methodMap_["uncompressedLength"] = MethodMetadata{1, UncompressedLength};
  methodMap_["createCStream"] = MethodMetadata{1, CreateCStream};
  methodMap_["createDStream"] = MethodMetadata{1, CreateDStream};
}

KodespireSnappyModule::~KodespireSnappyModule() = default;

}  // namespace facebook::react
