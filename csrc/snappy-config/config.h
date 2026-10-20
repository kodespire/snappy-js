/*
 * Hand-written stand-in for the config.h that snappy's CMake build generates
 * from deps/snappy/cmake/config.h.in. This package builds snappy with
 * node-gyp and Emscripten, not CMake, so each value below is decided here
 * from the compiler's own predefined macros instead of by configure checks.
 *
 * Included by deps/snappy/snappy-stubs-internal.h when HAVE_CONFIG_H is set;
 * binding.gyp and scripts/build-wasm.mjs pass -DHAVE_CONFIG_H=1, and
 * csrc/sjs.cc fails to compile without it. test/version.test.ts checks that
 * this file defines exactly the names config.h.in declares, so a snappy
 * update that adds a knob fails CI instead of compiling with it unset.
 *
 * Two rules decide the values:
 *   - SIMD paths only where the compiler already targets the instruction set
 *     (the default target, no -m flags added), and none for WebAssembly or
 *     MSVC, where snappy's intrinsic paths are not verified by this package.
 *   - Compressed output must be byte-identical on every platform and in
 *     WebAssembly, so the hardware-CRC hash options, which change the bytes
 *     the compressor emits, stay off everywhere.
 */
#ifndef THIRD_PARTY_SNAPPY_OPENSOURCE_CMAKE_CONFIG_H_
#define THIRD_PARTY_SNAPPY_OPENSOURCE_CMAKE_CONFIG_H_

/* Marker checked by csrc/sjs.cc: this file, not some other config.h, is in use. */
#define SJS_SNAPPY_CONFIG_H 1

/* GCC, Clang, Apple Clang and Emscripten (Clang) support the GNU builtins
 * and attributes below; MSVC does not. */
#if defined(__GNUC__) || defined(__clang__)
#define SJS_GNU_COMPATIBLE 1
#else
#define SJS_GNU_COMPATIBLE 0
#endif

#if defined(__EMSCRIPTEN__) || defined(_MSC_VER)
#define SJS_NO_SIMD 1
#else
#define SJS_NO_SIMD 0
#endif

/* __attribute__((always_inline)): GNU-compatible compilers. */
#define HAVE_ATTRIBUTE_ALWAYS_INLINE SJS_GNU_COMPATIBLE

/* __builtin_ctz/__builtin_clz and friends. CMake also requires the Zbb
 * extension on RISC-V, where ctz is otherwise a slow library call. On MSVC,
 * snappy falls back to _BitScanForward. */
#if SJS_GNU_COMPATIBLE && (!defined(__riscv) || defined(__riscv_zbb))
#define HAVE_BUILTIN_CTZ 1
#else
#define HAVE_BUILTIN_CTZ 0
#endif

/* __builtin_expect branch hints: GNU-compatible compilers. */
#define HAVE_BUILTIN_EXPECT SJS_GNU_COMPATIBLE

/* __builtin_prefetch: GNU-compatible compilers. */
#define HAVE_BUILTIN_PREFETCH SJS_GNU_COMPATIBLE

/* mmap() and sysconf(): only snappy's tests and benchmarks use them. */
#define HAVE_FUNC_MMAP 0
#define HAVE_FUNC_SYSCONF 0

/* zlib, LZO and LZ4: only snappy's benchmarks link them, for comparison. */
#define HAVE_LIBLZO2 0
#define HAVE_LIBZ 0
#define HAVE_LIBLZ4 0

/* <sys/mman.h>, <unistd.h>: snappy-stubs-internal.h includes them when set,
 * but the library code never calls anything they declare. Off, so the build
 * is the same on Windows and in WebAssembly. */
#define HAVE_SYS_MMAN_H 0
#define HAVE_UNISTD_H 0

/* <sys/resource.h>, <sys/time.h>, <windows.h>: tests and benchmarks only. */
#define HAVE_SYS_RESOURCE_H 0
#define HAVE_SYS_TIME_H 0
#define HAVE_WINDOWS_H 0

/* <sys/uio.h>: off everywhere, matching snappy-stubs-public.h, so snappy
 * declares its own snappy::iovec. Only the iovec APIs use it, and this
 * package does not call them. */
#define HAVE_SYS_UIO_H 0

/* SSSE3 byte shuffles (decompression pattern copies). Only when the compiler
 * targets SSSE3 (-mssse3 or a -march that implies it); the default x86-64
 * target is SSE2, so prebuilt binaries run on every x86-64 CPU. */
#if !SJS_NO_SIMD && defined(__SSSE3__)
#define SNAPPY_HAVE_SSSE3 1
#else
#define SNAPPY_HAVE_SSSE3 0
#endif

/* SSE4.2 CRC32 instruction as the compressor's hash function. Off: it
 * changes the compressed bytes (see the top of this file). */
#define SNAPPY_HAVE_X86_CRC32 0

/* BMI2 (_bzhi_u32) in the decompressor. Only when the compiler targets BMI2,
 * which the default x86-64 target does not. Does not change any output. */
#if !SJS_NO_SIMD && defined(__BMI2__)
#define SNAPPY_HAVE_BMI2 1
#else
#define SNAPPY_HAVE_BMI2 0
#endif

/* NEON byte shuffles (decompression pattern copies). NEON is part of every
 * AArch64 target; snappy's code uses AArch64-only intrinsics (vqtbl1q_u8),
 * so 32-bit ARM stays off. */
#if !SJS_NO_SIMD && defined(__aarch64__) && defined(__ARM_NEON)
#define SNAPPY_HAVE_NEON 1
#else
#define SNAPPY_HAVE_NEON 0
#endif

/* RISC-V vector extension (RVV 1.0 / 0.7.1) copies. No RISC-V binaries are
 * built, so these are unverified and off. */
#define SNAPPY_RVV_1 0
#define SNAPPY_RVV_0_7 0

/* ARMv8 CRC32C instruction as the compressor's hash function (__crc32cw).
 * Off: it changes the compressed bytes. Apple's compilers target it by
 * default, so leaving this undefined would let snappy.cc turn it on. */
#define SNAPPY_HAVE_NEON_CRC32 0

/* Byte order, from the compiler. MSVC and WebAssembly are little-endian. */
#if defined(__BYTE_ORDER__) && defined(__ORDER_BIG_ENDIAN__) && \
    __BYTE_ORDER__ == __ORDER_BIG_ENDIAN__
#define SNAPPY_IS_BIG_ENDIAN 1
#else
#define SNAPPY_IS_BIG_ENDIAN 0
#endif

#endif /* THIRD_PARTY_SNAPPY_OPENSOURCE_CMAKE_CONFIG_H_ */
