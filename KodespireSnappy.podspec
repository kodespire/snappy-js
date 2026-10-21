# React Native (iOS) build of the native binding: cpp/ over csrc/sjs.cc and the
# bundled snappy sources, the same C++ code as the Node-API addon and the WebAssembly build.
require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))
snappy = "deps/snappy"

Pod::Spec.new do |s|
  s.name         = "KodespireSnappy"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]
  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/kodespire/snappy-js.git", :tag => "v#{s.version}" }

  s.source_files = [
    "ios/*.{h,mm}",
    "cpp/*.{h,cpp}",
    "csrc/sjs.h",
  ]
  # Only the provider is public, so snappy's headers and the hand-written config.h
  # never shadow another pod's.
  s.public_header_files = "ios/*.h"

  # csrc/sjs.cc and snappy (scripts/snappy-sources.cjs), with the flags of binding.gyp
  # and scripts/build-wasm.mjs. HAVE_CONFIG_H makes snappy read the hand-written
  # csrc/snappy-config/config.h, which turns on SIMD only where the compiler targets it
  # by default (no -m flags here) and keeps the hardware-CRC hash off, so the output is
  # byte-identical to every other build. NDEBUG drops snappy's asserts in Debug builds
  # too. A subspec because CocoaPods sets per-file flags per spec: the module's files
  # include React Native headers, which these macros must not reach.
  s.subspec "Core" do |ss|
    ss.source_files = [
      "csrc/sjs.cc",
      "csrc/snappy-config/*.h",
      "#{snappy}/snappy.{h,cc}",
      "#{snappy}/snappy-internal.h",
      "#{snappy}/snappy-sinksource.{h,cc}",
      "#{snappy}/snappy-stubs-internal.{h,cc}",
    ]
    ss.private_header_files = ["csrc/snappy-config/*.h", "#{snappy}/*.h"]
    ss.compiler_flags = "-DHAVE_CONFIG_H=1 -DNDEBUG -std=c++17"
  end

  s.pod_target_xcconfig = {
    # csrc/snappy-config before deps/snappy, as in binding.gyp.
    "HEADER_SEARCH_PATHS" => "\"$(PODS_TARGET_SRCROOT)/cpp\" \"$(PODS_TARGET_SRCROOT)/csrc\" " \
                             "\"$(PODS_TARGET_SRCROOT)/csrc/snappy-config\" \"$(PODS_TARGET_SRCROOT)/#{snappy}\"",
    "GCC_OPTIMIZATION_LEVEL" => "3",
    "GCC_SYMBOLS_PRIVATE_EXTERN" => "YES",
  }

  install_modules_dependencies(s)
end
