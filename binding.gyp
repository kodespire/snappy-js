{
  "targets": [
    {
      "target_name": "snappy_js",
      "sources": [
        "csrc/addon.cc",
        "csrc/sjs.cc",
        "<!@(node scripts/snappy-sources.cjs)"
      ],
      "include_dirs": ["csrc/snappy-config", "deps/snappy"],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').targets\"):node_addon_api_except_all"
      ],
      "defines": [
        "NAPI_VERSION=8",
        "NODE_ADDON_API_DISABLE_DEPRECATED",
        "HAVE_CONFIG_H=1",
        "NDEBUG"
      ],
      "cflags_cc": ["-O3", "-fvisibility=hidden", "-std=c++17"],
      "xcode_settings": {
        "GCC_OPTIMIZATION_LEVEL": "3",
        "GCC_SYMBOLS_PRIVATE_EXTERN": "YES",
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "MACOSX_DEPLOYMENT_TARGET": "11.0"
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          "Optimization": 2,
          "AdditionalOptions": ["/std:c++17", "/utf-8"]
        }
      }
    }
  ]
}
