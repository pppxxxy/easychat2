import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');
const sourcePath = path.resolve('src/chat/attachments.js');
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
  CameraType: { back: 'back', front: 'front' },
  getPendingResultAsync: async () => pendingResults,
  launchImageLibraryAsync: async () => ({ canceled: true }),
  // 拍照相关：行为全部由字段驱动。不能在建好 mock 后再替换这些函数——
  // Babel 的 `import * as` 会把命名空间复制一份，模块内拿到的是复制时的函数引用，
  // 测试里改 `ImagePicker.xxx = fn` 不会传进模块（改字段才会，因为闭包读的是当前值）。
  cameraPermission: { granted: true, status: 'granted' },
  // 模拟用户在系统权限弹窗上点「允许/拒绝」后的结果；为 null 表示权限没有变化
  cameraPermissionAfterRequest: null,
  requestedCameraPermission: false,
  cameraResult: { canceled: true },
  getCameraPermissionsAsync: async () => ImagePicker.cameraPermission,
  requestCameraPermissionsAsync: async () => {
    ImagePicker.requestedCameraPermission = true;
    if (ImagePicker.cameraPermissionAfterRequest) {
      ImagePicker.cameraPermission = ImagePicker.cameraPermissionAfterRequest;
    }
    return ImagePicker.cameraPermission;
  },
  launchCameraAsync: async () => ImagePicker.cameraResult,
};
const FileSystem = {
  documentDirectory: 'file:///documents/',
  cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
  infoResult: { exists: true, size: 1 },
  readResult: '',
  getInfoAsync: async () => FileSystem.infoResult,
  makeDirectoryAsync: async () => {},
  copyAsync: async ({ to }) => { FileSystem.copiedTo = to; },
  readAsStringAsync: async () => FileSystem.readResult,
  deleteAsync: async () => {},
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'react-native') return { Image };
  if (request === 'expo-document-picker') return DocumentPicker;
  if (request === 'expo-image-picker') return ImagePicker;
  if (request === 'expo-file-system' || request === 'expo-file-system/legacy') return FileSystem;
  return originalLoad.call(this, request, parent, isMain);
};

const filename = path.resolve('src/chat/attachments.js');
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

test('拍照：授予权限后返回与相册同形状的图片信息', async () => {
  ImagePicker.cameraPermission = { granted: true, status: 'granted' };
  ImagePicker.requestedCameraPermission = false;
  ImagePicker.cameraResult = {
    canceled: false,
    assets: [{
      uri: 'file:///cache/photo.jpg',
      fileName: 'IMG_0001.jpg',
      mimeType: 'image/jpeg',
      fileSize: 2048,
      width: 1080,
      height: 1920,
    }],
  };
  const shot = await attachments.takePhoto();
  assert.deepEqual(shot, {
    uri: 'file:///cache/photo.jpg',
    name: 'IMG_0001.jpg',
    mime: 'image/jpeg',
    width: 1080,
    height: 1920,
    size: 2048,
  });
  // 已授权时不再重复弹权限请求
  assert.equal(ImagePicker.requestedCameraPermission, false);
});

test('拍照：未授权时先请求，被拒返回 denied 且不打开相机', async () => {
  ImagePicker.cameraPermission = { granted: false, status: 'undetermined' };
  ImagePicker.cameraPermissionAfterRequest = { granted: false, status: 'denied' };
  ImagePicker.requestedCameraPermission = false;
  ImagePicker.cameraResult = { canceled: false, assets: [{ uri: 'file:///cache/should-not-happen.jpg' }] };
  const denied = await attachments.takePhoto();
  assert.deepEqual(denied, { denied: true });
  assert.equal(ImagePicker.requestedCameraPermission, true, '应请求过权限');

  // 授权后正常打开相机；用户取消则返回 null
  ImagePicker.cameraPermission = { granted: false, status: 'undetermined' };
  ImagePicker.cameraPermissionAfterRequest = { granted: true, status: 'granted' };
  ImagePicker.cameraResult = { canceled: true };
  assert.equal(await attachments.takePhoto(), null, '授权后应打开相机，取消拍照返回 null');
  assert.equal(ImagePicker.cameraPermission.status, 'granted');
  ImagePicker.cameraPermissionAfterRequest = null;
});

test('拍照：用户取消返回 null（与相册取消语义一致）', async () => {
  ImagePicker.cameraPermission = { granted: true, status: 'granted' };
  ImagePicker.cameraResult = { canceled: true };
  assert.equal(await attachments.takePhoto(), null);
});

test('相机权限判定：仅明确 denied 视为拒绝，undetermined 不算', () => {
  assert.equal(attachments.isCameraPermissionDenied({ status: 'denied' }), true);
  assert.equal(attachments.isCameraPermissionDenied({ status: 'undetermined', granted: false }), false);
  assert.equal(attachments.isCameraPermissionDenied({ status: 'granted', granted: true }), false);
  assert.equal(attachments.isCameraPermissionDenied(null), false);
  assert.equal(attachments.isCameraPermissionDenied(undefined), false);
});

test('拍照结果缺失 uri 时返回 null（不产生空附件）', async () => {
  ImagePicker.cameraPermission = { granted: true, status: 'granted' };
  ImagePicker.cameraResult = { canceled: false, assets: [{}] };
  assert.equal(await attachments.takePhoto(), null);
});

test('文本附件按编码探测解码：GBK 不再是乱码', async () => {
  FileSystem.infoResult = { exists: true, size: 4 };
  // “中文”的 GBK 字节：0xD6D0 0xCEC4，纯 UTF-8 读取会得到替换符乱码。
  FileSystem.readResult = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]).toString('base64');
  assert.equal(await attachments.readTextAttachment('file:///documents/gbk.txt'), '中文');
});

test('文本附件按编码探测解码：UTF-16LE（含 BOM）', async () => {
  const text = '这是UTF-16文本';
  const bytes = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(text, 'utf16le'),
  ]);
  FileSystem.infoResult = { exists: true, size: bytes.length };
  FileSystem.readResult = bytes.toString('base64');
  assert.equal(await attachments.readTextAttachment('file:///documents/u16.txt'), text);
});

test('文本附件仍受大小上限约束', async () => {
  FileSystem.infoResult = { exists: true, size: attachments.MAX_TEXT_BYTES + 1 };
  await assert.rejects(
    () => attachments.readTextAttachment('file:///documents/big.txt'),
    /文件过大/
  );
});

test('视频：识别、MIME 归一与大小限额', () => {
  assert.equal(attachments.isVideo('clip.mp4', ''), true);
  assert.equal(attachments.isVideo('clip', 'video/quicktime'), true);
  assert.equal(attachments.isVideo('clip.mp4', 'application/octet-stream'), true, 'mime 缺失时按扩展名识别');
  assert.equal(attachments.isVideo('photo.jpg', 'image/jpeg'), false);
  assert.equal(attachments.getVideoMime('a.MOV', ''), 'video/mov');
  assert.equal(attachments.getVideoMime('a.webm', ''), 'video/webm');
  assert.equal(attachments.getVideoMime('a.3gp', ''), 'video/3gpp');
  assert.equal(attachments.getVideoMime('a', 'video/quicktime'), 'video/mov');
  assert.equal(attachments.getVideoMime('a', 'video/mp4'), 'video/mp4');
  assert.equal(attachments.getVideoMime('a', ''), 'video/mp4', '未知一律按 mp4');
  assert.equal(attachments.validateVideoSize({ size: attachments.MAX_VIDEO_BYTES }), true);
  assert.throws(() => attachments.validateVideoSize({ size: attachments.MAX_VIDEO_BYTES + 1 }), /视频过大/);
  assert.throws(() => attachments.validateVideoSize({ size: 0 }), /无法读取视频大小/);
  assert.equal(attachments.MAX_VIDEO_ATTACHMENTS, 1, '视频一次只允许一条');
  assert.ok(attachments.MAX_VIDEO_BASE64_BYTES > attachments.MAX_VIDEO_BYTES, 'base64 预算要覆盖膨胀后的体积');
});

test('视频落盘：chat-videos 目录、扩展名按 MIME 归一；删除只作用于该目录', async () => {
  FileSystem.copiedTo = '';
  const destination = await attachments.persistVideoAttachment('file:///cache/clip.mov', 'video/quicktime', 'clip.mov');
  assert.ok(destination.includes('/chat-videos/'), '落盘目录必须是 chat-videos（与图片分离）');
  assert.equal(destination, FileSystem.copiedTo, '实际拷贝目标与返回值一致');
  assert.ok(destination.endsWith('.mov'), 'MOV 扩展名保留');
  const webm = await attachments.persistVideoAttachment('file:///cache/a.bin', 'video/webm', 'a.bin');
  assert.ok(webm.endsWith('.webm'), 'WebM 归一为 webm');
  await assert.rejects(
    () => attachments.persistVideoAttachment('', 'video/mp4', 'x.mp4'),
    /视频路径无效/
  );
  // 删除守卫：非 chat-videos 路径即便误传也不动（不抛错即可，真实删除由 FileSystem 承接）。
  await attachments.deleteLocalVideo('file:///documents/chat-images/photo.jpg');
  await attachments.deleteLocalVideo('');
});
