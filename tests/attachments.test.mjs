import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');
const sourcePath = path.resolve('src/attachments.js');
const sourceCode = fs.readFileSync(sourcePath, 'utf8');
const transformed = babel.transformSync(sourceCode, {
  babelrc: false,
  configFile: false,
  filename: sourcePath,
  presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;

let pendingResults = [];
const Image = {
  getSize: (_uri, callback) => callback(100, 100),
};
const DocumentPicker = {
  getDocumentAsync: async () => ({ canceled: true }),
};
const ImagePicker = {
  MediaTypeOptions: { Images: 'Images' },
  getPendingResultAsync: async () => pendingResults,
  launchImageLibraryAsync: async () => ({ canceled: true }),
};
const FileSystem = {
  documentDirectory: 'file:///documents/',
  cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
  getInfoAsync: async () => ({ exists: true, size: 1 }),
  makeDirectoryAsync: async () => {},
  copyAsync: async () => {},
  readAsStringAsync: async () => '',
  deleteAsync: async () => {},
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'react-native') return { Image };
  if (request === 'expo-document-picker') return DocumentPicker;
  if (request === 'expo-image-picker') return ImagePicker;
  if (request === 'expo-file-system') return FileSystem;
  return originalLoad.call(this, request, parent, isMain);
};

const filename = path.resolve('src/attachments.test-runtime.cjs');
const runtimeModule = new Module(filename);
runtimeModule.filename = filename;
runtimeModule.paths = Module._nodeModulePaths(path.dirname(filename));
runtimeModule._compile(transformed, filename);
Module._load = originalLoad;

const attachments = runtimeModule.exports;

test('图片大小、像素和批量总大小限制生效', () => {
  assert.equal(attachments.validateImageSize({ size: attachments.MAX_IMAGE_BYTES }), true);
  assert.throws(() => attachments.validateImageSize({ size: attachments.MAX_IMAGE_BYTES + 1 }), /图片过大/);
  assert.throws(() => attachments.validateImageSize({ size: 1, width: 0, height: 0 }), /图片尺寸无效/);
  assert.throws(() => attachments.validateImageSize({ width: 5000, height: 5000 }), /图片分辨率过大/);
  assert.equal(attachments.validateImageBatch([
    { size: attachments.MAX_IMAGE_TOTAL_BYTES / 2 },
    { size: attachments.MAX_IMAGE_TOTAL_BYTES / 2 },
  ]), attachments.MAX_IMAGE_TOTAL_BYTES);
  assert.throws(() => attachments.validateImageBatch([{ size: 0 }]), /无法读取图片大小/);
  assert.throws(() => attachments.validateImageBatch([
    { size: attachments.MAX_IMAGE_BYTES + 1 },
  ]), /图片过大/);
   assert.throws(() => attachments.validateImageBatch([
     { size: 1, width: 5000, height: 5000 },
   ]), /图片分辨率过大/);
   assert.throws(() => attachments.validateImageBatch(
     [{ size: 1, width: 0, height: 0 }],
     { requireDimensions: true },
   ), /图片尺寸无效/);
   assert.throws(() => attachments.validateImageBatch(
    Array.from({ length: attachments.MAX_IMAGE_ATTACHMENTS + 1 }, () => ({ size: 1 }))
  ), /图片过多/);
  assert.throws(() => attachments.validateImageBatch([
    { size: attachments.MAX_IMAGE_TOTAL_BYTES / 2 + 1 },
    { size: attachments.MAX_IMAGE_TOTAL_BYTES / 2 + 1 },
  ]), /图片总大小过大/);
});

test('图片 MIME 和 pending 表情包结果可以规范化', async () => {
  assert.equal(attachments.getImageMime('photo.HEIC', ''), 'image/heic');
  assert.equal(attachments.getImageMime('photo.jpg', 'image/jpg'), 'image/jpeg');
  assert.equal(attachments.isVisionImage('photo.jpg', 'image/jpg'), true);
  assert.equal(attachments.isVisionImage('photo.heic', 'image/heic'), false);
  assert.equal(attachments.isTemporaryImageUri('file:///cache/photo.jpg'), true);
  assert.equal(attachments.isTemporaryImageUri('file:///documents/chat-images/photo.jpg'), false);
  pendingResults = [{
    assets: [{
      uri: 'file:///pending/sticker.png',
      fileName: 'sticker.png',
      mimeType: 'image/png',
      fileSize: 12,
      width: 20,
      height: 30,
    }],
  }];
  assert.deepEqual(await attachments.getPendingStickerImage(), {
    uri: 'file:///pending/sticker.png',
    name: 'sticker.png',
    mime: 'image/png',
    width: 20,
    height: 30,
    size: 12,
  });
});
