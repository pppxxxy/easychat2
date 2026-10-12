// UTF-8 字节长度（纯函数，零依赖）。
//
// 为什么手写而不依赖 TextEncoder：Hermes 环境不保证有它，而实现只有十几行。
// 语义要点：成对代理（emoji 等星平面字符）算 **4** 字节并跳过低代理；孤立代理算 3 字节
//（与各自独立编码的结果一致）——所有调用方都拿它判「是否超过内联/截断阈值」，
// 数错就会让阈值口径不一致。
//
// 为什么单独成文件：这段逻辑曾在**多处**各写一份——storage/io.js、
// storage/backupStream.js（分片累加版）、chat/RichHtmlMessage.js、workspace/memory.js；
// 2026-10-12 第二批又收编了 workspace/taskOutputs.js 与 workspace/sessionEvents.js
//（后者写成 for...of + codePointAt，前者把孤立代理算成 4 字节，与这里的 3 字节不一致）。
// 与 src/utils/format.js 同因：逐字相同的实现散在各处，改一处就会漂移。现在只有这一份；
// 消费方清单与「再长一份就红」的检查在 tests/byteLengthSingleSource.test.mjs。

export function utf8ByteLength(text) {
  const value = String(text || '');
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
