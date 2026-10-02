import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import {
  buildLocalDreamBody,
  completeEventToImage,
  createLocalDreamSseParser,
  describeLocalDreamNetworkError,
  localDreamEndpoint,
  normalizeLocalDreamScheduler,
  parseLocalDreamEvent,
  parseLocalDreamSize,
} from '../src/imageGen/localDream.js';
import { providerRequiresApiKey, getImageProvider } from '../src/imageGen/providers.js';

test('parseLocalDreamSize：方形给 size，非方形给 width/height，非法回落 512', () => {
  assert.deepEqual(parseLocalDreamSize('512*512'), { size: 512 });
  assert.deepEqual(parseLocalDreamSize('1024*1792'), { width: 1024, height: 1792 });
  assert.deepEqual(parseLocalDreamSize('1024x1792'), { width: 1024, height: 1792 });
  assert.deepEqual(parseLocalDreamSize(''), { size: 512 });
  assert.deepEqual(parseLocalDreamSize('abc'), { size: 512 });
});

test('normalizeLocalDreamScheduler：别名映射，未知回落 dpm', () => {
  assert.equal(normalizeLocalDreamScheduler('DPM++ 2M'), 'dpm');
  assert.equal(normalizeLocalDreamScheduler('Euler A'), 'euler_a');
  assert.equal(normalizeLocalDreamScheduler('eulera'), 'euler_a');
  assert.equal(normalizeLocalDreamScheduler('lcm'), 'lcm');
  assert.equal(normalizeLocalDreamScheduler('nonsense'), 'dpm');
  assert.equal(normalizeLocalDreamScheduler(''), 'dpm');
});

test('buildLocalDreamBody：字段与官方文档一致，尺寸归一 8 的倍数', () => {
  const body = buildLocalDreamBody({
    prompt: 'a cat',
    negativePrompt: 'blurry',
    steps: 30,
    cfg: 6.5,
    seed: 42,
    size: '1000*1496',
    scheduler: 'euler_a',
  });
  assert.equal(body.prompt, 'a cat');
  assert.equal(body.negative_prompt, 'blurry');
  assert.equal(body.steps, 30);
  assert.equal(body.cfg, 6.5);
  assert.equal(body.seed, 42);
  assert.equal(body.scheduler, 'euler_a');
  // 1000→1000（8 的倍数），1496→1496（8 的倍数）
  assert.equal(body.width, 1000);
  assert.equal(body.height, 1496);
  assert.equal(body.size, undefined);
  // 方形用 size
  const square = buildLocalDreamBody({ prompt: 'x', size: '512*512' });
  assert.equal(square.size, 512);
  assert.equal(square.width, undefined);
});

test('buildLocalDreamBody：尺寸非 8 倍数时向上/下归一到 8 的倍数', () => {
  const body = buildLocalDreamBody({ prompt: 'x', size: '513*513' });
  assert.equal(body.size, 512); // round(513/8)*8 = 512
  const rect = buildLocalDreamBody({ prompt: 'x', size: '100*100' });
  // 方形 → size 分支
  assert.equal(rect.size, 104); // round(100/8)*8 = 104
});

test('buildLocalDreamBody：img2img 带 image 才追加 denoise_strength；mask 需先有 image', () => {
  const t2i = buildLocalDreamBody({ prompt: 'x' });
  assert.equal(t2i.image, undefined);
  assert.equal(t2i.denoise_strength, undefined);
  const i2i = buildLocalDreamBody({ prompt: 'x', image: 'AAAA', denoiseStrength: 0.8 });
  assert.equal(i2i.image, 'AAAA');
  assert.equal(i2i.denoise_strength, 0.8);
  // 只有 mask 没有 image：不进入 img2img
  const maskOnly = buildLocalDreamBody({ prompt: 'x', mask: 'BBBB' });
  assert.equal(maskOnly.image, undefined);
  assert.equal(maskOnly.mask, undefined);
  // 非法 denoise 回落 0.6
  const bad = buildLocalDreamBody({ prompt: 'x', image: 'AAAA', denoiseStrength: 5 });
  assert.equal(bad.denoise_strength, 0.6);
});

test('localDreamEndpoint：允许填到 /generate 或根地址', () => {
  assert.equal(localDreamEndpoint('', '/generate'), 'http://127.0.0.1:8081/generate');
  assert.equal(localDreamEndpoint('http://127.0.0.1:8081', '/generate'), 'http://127.0.0.1:8081/generate');
  assert.equal(localDreamEndpoint('http://127.0.0.1:8081/', '/generate'), 'http://127.0.0.1:8081/generate');
  assert.equal(localDreamEndpoint('http://127.0.0.1:8081/generate', '/generate'), 'http://127.0.0.1:8081/generate');
  assert.equal(localDreamEndpoint('http://192.168.1.5:8081', '/tokenize'), 'http://192.168.1.5:8081/tokenize');
});

test('parseLocalDreamEvent：progress/complete/error 归一，未知与坏 JSON 返回 null', () => {
  const progress = parseLocalDreamEvent('{"type":"progress","step":3,"total_steps":20}');
  assert.equal(progress.type, 'progress');
  assert.equal(progress.percent, 15);
  const complete = parseLocalDreamEvent('{"type":"complete","image":"AA","seed":1,"width":2,"height":2,"channels":3}');
  assert.equal(complete.type, 'complete');
  assert.equal(complete.width, 2);
  assert.equal(complete.channels, 3);
  const err = parseLocalDreamEvent('{"type":"error","message":"boom"}');
  assert.equal(err.type, 'error');
  assert.equal(err.message, 'boom');
  assert.equal(parseLocalDreamEvent('{"type":"other"}'), null);
  assert.equal(parseLocalDreamEvent('not json'), null);
  assert.equal(parseLocalDreamEvent(''), null);
});

test('createLocalDreamSseParser：空行分隔事件、同一事件多行 data 拼接', () => {
  const events = [];
  const parser = createLocalDreamSseParser(e => events.push(e));
  // 契约：push 传入「累积的 responseText」，解析器按已消费长度切片处理新增部分。
  let acc = 'event: progress\ndata: {"type":"prog';
  parser.push(acc);
  acc += 'ress","step":1,"total_steps":10}\n\n';
  parser.push(acc);
  assert.equal(events.length, 1);
  assert.equal(events[0].percent, 10);
  // 同一事件 data 拆两行（token 间换行），继续累积
  acc += 'data: {"type":"complete",\n';
  parser.push(acc);
  acc += 'data: "image":"AA","width":1,"height":1,"channels":3}\n\n';
  parser.push(acc);
  assert.equal(events.length, 2);
  assert.equal(events[1].type, 'complete');
  assert.equal(events[1].image, 'AA');
});

test('createLocalDreamSseParser：无空行收尾时 flush 冲刷最后一个事件', () => {
  const events = [];
  const parser = createLocalDreamSseParser(e => events.push(e));
  parser.push('data: {"type":"complete","image":"AA","width":1,"height":1,"channels":3}');
  assert.equal(events.length, 0);
  parser.flush();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'complete');
});

test('createLocalDreamSseParser：注释行与无 data 的 event 行被忽略', () => {
  const events = [];
  const parser = createLocalDreamSseParser(e => events.push(e));
  parser.push(': keep-alive\nevent: complete\ndata: {"type":"complete","image":"AA","width":1,"height":1,"channels":3}\n\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'complete');
});

test('completeEventToImage：裸 RGB base64 → PNG base64（1x1 红点可解压验证）', () => {
  // 1x1 红色像素 raw RGB: (255,0,0)
  const rawB64 = Buffer.from([255, 0, 0]).toString('base64');
  const image = completeEventToImage({ image: rawB64, width: 1, height: 1, channels: 3 });
  assert.equal(image.mimeType, 'image/png');
  const png = Buffer.from(image.base64, 'base64');
  assert.deepEqual(Array.from(png.subarray(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // 找到 IDAT 解压，验证像素确实是 (255,0,0)
  let offset = 8;
  let idat = null;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') idat = png.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
  }
  const decoded = zlib.inflateSync(Buffer.from(idat));
  assert.deepEqual(Array.from(decoded), [0, 255, 0, 0]); // filter + RGB
});

test('describeLocalDreamNetworkError：连接失败给出打开 Local Dream 的引导', () => {
  assert.match(describeLocalDreamNetworkError('Network request failed'), /Local Dream/);
  assert.match(describeLocalDreamNetworkError(new Error('连接被拒绝')), /Local Dream/);
  assert.equal(describeLocalDreamNetworkError(new Error('其它错误')), '其它错误');
});

test('provider 注册：local-dream 无需密钥，baseUrl 默认回环地址', () => {
  const provider = getImageProvider('local-dream');
  assert.equal(provider.id, 'local-dream');
  assert.equal(provider.localDream, true);
  assert.equal(providerRequiresApiKey(provider), false);
  assert.match(provider.baseUrl, /127\.0\.0\.1:8081/);
  // 仍需 baseUrl 才能生成，但不应被"缺密钥"拦截
  assert.equal(providerRequiresApiKey(getImageProvider('openai-relay')), true);
});
