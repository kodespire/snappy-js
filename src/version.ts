// Must match deps/snappy and csrc/snappy-config/snappy-stubs-public.h
// (checked by test/version.test.ts).
/** Version of the bundled snappy library, the same for the native and WebAssembly builds. */
export const SNAPPY_VERSION = '1.3.1';
/** Fastest compression level, and the default. */
export const MIN_LEVEL = 1;
/** Densest compression level (marked experimental upstream). */
export const MAX_LEVEL = 2;
/** Level used when none is given. */
export const DEFAULT_LEVEL = 1;
