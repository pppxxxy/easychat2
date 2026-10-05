// 保证全局 TextDecoder 支持非 UTF-8 编码（GBK/BIG5/日韩等）。
//
// 背景：Expo SDK 54 在 App 启动时通过 expo/src/winter 安装了一个只认 UTF-8 系
// 标签的全局 TextDecoder。而 `text-encoding`（WHATWG polyfill）在模块顶层用
// `(function (global) { ... }(this || {}))` 取全局，尾部逻辑是「全局已有
// TextDecoder 就原样转发，没有才安装自己的完整实现」。Metro 以普通调用执行模块
// 工厂（this = 真实全局对象），Node CJS 下 this = module.exports——所以单测跑的是
// polyfill 路径、真机跑的却是残缺的 Expo 实现：new TextDecoder('gb18030') 抛
// RangeError，decodeText 的所有非 UTF-8 候选被跳过，导入 GBK/BIG5 文本直接报
// ENCODING。
//
// 处理：探测当前全局解码器能否解出非 UTF-8；不能就摘掉它，让随后加载的
// text-encoding 装上完整 WHATWG 实现（UTF-8 也在其内）。纯函数，可 Node 直测。

const PROBE_ENCODING = 'gb18030';
// GBK「你」。Expo 的 UTF-8-only 解码器在构造阶段就会抛 RangeError。
const PROBE_BYTES = [0xc4, 0xe3];
const PROBE_TEXT = '你';

// 当前全局 TextDecoder 是否能正确解码非 UTF-8 字节序列。
export function decodesNonUtf8(globalObject) {
  try {
    if (!globalObject || typeof globalObject.TextDecoder !== 'function') return false;
    const decoder = new globalObject.TextDecoder(PROBE_ENCODING);
    return decoder.decode(new Uint8Array(PROBE_BYTES)) === PROBE_TEXT;
  } catch (error) {
    return false;
  }
}

// 若全局解码器不支持非 UTF-8，则摘除并调用 loadPolyfill 重新安装完整实现。
// 返回是否做了替换。已支持（或没有全局）时保持原样，避免多余副作用。
export function ensureFullTextDecoder(globalObject, loadPolyfill) {
  if (!globalObject || decodesNonUtf8(globalObject)) return false;
  try {
    delete globalObject.TextDecoder;
  } catch (error) {
    // 属性不可配置时删不掉；此时后续 text-encoding 仍会转发残缺实现。
  }
  if (typeof loadPolyfill === 'function') loadPolyfill();
  return true;
}
