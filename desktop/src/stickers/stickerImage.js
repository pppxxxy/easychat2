// 表情包处理：导入后缩到 50%、压成 JPEG（与 Android createStickerImage 同口径）。
//
// Android 用 expo-image-manipulator；桌面没有原生图像处理，渲染进程用 canvas 等价实现。
// 缩放比例与 JPEG 质量保持常量一致（0.5 / 0.78），避免同一张图在两个平台落盘体积不同。
//
// 安全：源文件经 fs.read 以 base64 进入渲染层，再转 Blob + object URL 解码。
// 不使用 media 协议 URL 直接画 canvas——自定义协议是跨源资源，会把 canvas 标脏，
// toBlob 直接抛 SecurityError。
export const STICKER_SCALE = 0.5;
export const STICKER_JPEG_QUALITY = 0.78;

export function stickerSize(width, height) {
  return {
    width: Math.max(1, Math.round((Number(width) || 1) * STICKER_SCALE)),
    height: Math.max(1, Math.round((Number(height) || 1) * STICKER_SCALE)),
  };
}

export function base64ToBytes(base64) {
  const binary = atob(String(base64 || ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

// 导入时的默认名称：去掉扩展名、截到 40 字符；空名由调用方要求用户补填。
export function defaultStickerName(fileName) {
  return String(fileName || '')
    .replace(/\.[^./\\]+$/, '')
    .trim()
    .slice(0, 40);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('blob read failed'));
    reader.readAsDataURL(blob);
  });
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('image decode failed'));
    image.src = url;
  });
}

// 返回 { base64, width, height, sourceWidth, sourceHeight }。
export async function createStickerJpeg(base64, mime = 'image/jpeg') {
  const bytes = base64ToBytes(base64);
  const source = new Blob([bytes], { type: String(mime || 'image/jpeg') });
  const sourceUrl = URL.createObjectURL(source);
  try {
    const image = await loadImage(sourceUrl);
    const sourceWidth = image.naturalWidth || image.width || 0;
    const sourceHeight = image.naturalHeight || image.height || 0;
    if (!(sourceWidth > 0) || !(sourceHeight > 0)) throw new Error('image dimensions unavailable');
    const target = stickerSize(sourceWidth, sourceHeight);
    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('canvas unavailable');
    context.drawImage(image, 0, 0, target.width, target.height);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        value => (value ? resolve(value) : reject(new Error('canvas export failed'))),
        'image/jpeg',
        STICKER_JPEG_QUALITY
      );
    });
    return {
      base64: await blobToBase64(blob),
      width: target.width,
      height: target.height,
      sourceWidth,
      sourceHeight,
    };
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}
