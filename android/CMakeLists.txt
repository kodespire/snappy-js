# The C++ TurboModule, added to the app's native build by autolinking
# (react-native.config.js). Same sources and defines as binding.gyp.
cmake_minimum_required(VERSION 3.13)
project(kodespire_snappy CXX)

set(ROOT ${CMAKE_CURRENT_LIST_DIR}/..)
set(SNAPPY ${ROOT}/deps/snappy)

# csrc/sjs.cc and snappy (scripts/snappy-sources.cjs), compiled as binding.gyp and
# scripts/build-wasm.mjs compile them. HAVE_CONFIG_H makes snappy read the
# hand-written csrc/snappy-config/config.h, which turns on SIMD only where the
# compiler targets it by default (no -m flags here) and keeps the hardware-CRC hash
# off, so the output is byte-identical to every other build. NDEBUG drops snappy's
# asserts in debug builds too. A separate target keeps both macros away from the
# React Native headers the module includes. On the 32-bit ABIs (armeabi-v7a, x86)
# csrc/sjs.cc validates raw blocks a second time, as in WebAssembly.
add_library(kodespire_snappy_core STATIC
  ${ROOT}/csrc/sjs.cc
  ${SNAPPY}/snappy.cc
  ${SNAPPY}/snappy-sinksource.cc
  ${SNAPPY}/snappy-stubs-internal.cc)
target_include_directories(kodespire_snappy_core
  PUBLIC ${ROOT}/csrc
  PRIVATE ${ROOT}/csrc/snappy-config ${SNAPPY})
target_compile_definitions(kodespire_snappy_core PRIVATE HAVE_CONFIG_H=1 NDEBUG)
# -O3 in debug builds too, like the module below.
target_compile_options(kodespire_snappy_core PRIVATE -O3 -fvisibility=hidden)
set_target_properties(kodespire_snappy_core PROPERTIES CXX_STANDARD 17 CXX_STANDARD_REQUIRED ON)

add_library(kodespire_snappy STATIC ${ROOT}/cpp/KodespireSnappyModule.cpp)

target_include_directories(kodespire_snappy PUBLIC ${ROOT}/cpp)
# -O3 in debug builds too: snappy at -O0 is too slow to be useful.
target_compile_options(kodespire_snappy PRIVATE -O3 -fvisibility=hidden)
set_target_properties(kodespire_snappy PROPERTIES CXX_STANDARD 20 CXX_STANDARD_REQUIRED ON)

target_link_libraries(kodespire_snappy kodespire_snappy_core ReactAndroid::jsi ReactAndroid::reactnative)
