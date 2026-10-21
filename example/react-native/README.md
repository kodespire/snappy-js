# snappy-js React Native example

A bare React Native app (Hermes, New Architecture) that runs a self-test of
`@kodespire/snappy-js` on launch: raw and framed round trips, the same compressed
bytes as every other build, data from other encoders, truncated and malformed
input, `maxOutputSize`, async work off the JS thread and streams. See
`selftest/run.ts`. CI runs it on an iOS simulator and on Android emulators, one of
them 32-bit (`.github/workflows/react-native.yml`).

`npm install` here replaces the `file:../..` link with the package exactly as
`npm pack` would publish it (`scripts/prepare.mjs`), so build the package first:

```sh
# in the repo root
npm run build:wasm && npm run build:ts

# here
npm install
(cd ios && bundle install && bundle exec pod install)
npm run selftest:ios       # boots a simulator if none is running (IOS_SIMULATOR picks one)
npm run selftest:android   # needs ANDROID_HOME and a running emulator or device
```

`scripts/selftest.mjs` builds a Release app, installs and launches it, and
prints the `SNAPPY_SELFTEST` lines from the device log. It exits non-zero if any
test fails. Run `npm install` again after changing the package.

The app is React Native 0.88, whose template already has the `SceneDelegate`
that iOS 27 requires. Apps from the 0.84 to 0.87 templates need one added; see
the main README.
