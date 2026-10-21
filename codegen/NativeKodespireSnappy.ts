// Declares the native module for React Native's codegen, which registers it with
// the app (see codegenConfig in package.json). Nothing imports this file: the module
// is written by hand in cpp/KodespireSnappyModule.cpp, and src/jsi-backend.ts is its
// JavaScript side. Byte arrays are typed as Object because codegen has no Uint8Array.
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  version(): string;
  compressSync(data: Object, level: number, format: number): Object;
  compress(data: Object, level: number, format: number): Promise<Object>;
  decompressSync(data: Object, format: number, maxOutputSize: number): Object;
  decompress(data: Object, format: number, maxOutputSize: number): Promise<Object>;
  uncompressedLength(data: Object): number;
  createCStream(level: number): Object;
  createDStream(maxOutputSize: number): Object;
}

export default TurboModuleRegistry.get<Spec>('KodespireSnappy');
