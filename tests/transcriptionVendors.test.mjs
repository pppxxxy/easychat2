// 转写厂商预设：一键预填端点与模型的源码断言与数据完整性校验。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { TRANSCRIPTION_API_VENDORS, getTranscriptionVendor } from '../src/network/apiVendors.js';
import { zhCN } from '../src/i18n/locales/zh-CN.js';

const read = relPath => fs.readFileSync(path.resolve(relPath), 'utf8');

test('转写厂商预设表：id 唯一、字段齐全、端点为 OpenAI 兼容 transcriptions', () => {
  assert.ok(TRANSCRIPTION_API_VENDORS.length > 0);
  const ids = new Set();
  for (const vendor of TRANSCRIPTION_API_VENDORS) {
    assert.ok(vendor.id, '厂商必须有 id');
    assert.equal(ids.has(vendor.id), false, `厂商 id 重复：${vendor.id}`);
    ids.add(vendor.id);
    assert.ok(vendor.name, '厂商必须有名称');
    assert.match(vendor.baseUrl, /^https:\/\/[^\s]+\/audio\/transcriptions$/, `${vendor.name} 端点必须是 transcriptions 绝对地址`);
    assert.ok(vendor.model, `${vendor.name} 必须有默认模型名`);
    assert.ok(vendor.apiKeyUrl, `${vendor.name} 必须有密钥获取页`);
    assert.ok(vendor.note, `${vendor.name} 必须有说明`);
  }
  // 用户报告的 DeepSeek 类纯文本来源场景：至少提供国内直连选项
  const siliconflow = getTranscriptionVendor('siliconflow-stt');
  assert.ok(siliconflow);
  assert.equal(siliconflow.baseUrl, 'https://api.siliconflow.cn/v1/audio/transcriptions');
});

test('getTranscriptionVendor：未知 id 返回 null', () => {
  assert.equal(getTranscriptionVendor('not-exist'), null);
  assert.equal(getTranscriptionVendor(''), null);
});

test('normalizeTranscriptionSettings 保留 vendorId（否则改过端点后密钥链接消失）', () => {
  const source = read('src/storage/settings/tts.js');
  assert.match(
    source,
    /vendorId: String\(\(item && item\.vendorId\) \|\| ''\)/,
    '规范化映射必须保留 vendorId，供面板命中厂商预设'
  );
});

test('TranscriptionPanel 接入厂商预设芯片：点选即预填端点与模型', () => {
  const source = read('src/TranscriptionPanel.js');
  assert.match(source, /TRANSCRIPTION_API_VENDORS/, '面板应引用厂商预设表');
  assert.match(source, /addConfig\(vendor\)/, '点厂商芯片应带预设新增配置');
  assert.match(source, /name: preset \? preset\.name : t\('transcription\.config\.newName'\)/, '新增时应预填厂商名称（默认名走 i18n 键）');
  assert.equal(zhCN['transcription.config.newName'], '新配置', '语言包中文值正确');
  assert.match(source, /baseUrl: preset \? preset\.baseUrl : ''/, '新增时应预填端点');
  assert.match(source, /model: preset \? preset\.model : ''/, '新增时应预填模型名');
  assert.match(source, /t\('transcription\.custom'\)/, '应保留自定义入口（走 i18n 键）');
  assert.equal(zhCN['transcription.custom'], '自定义', '语言包中文值正确');
  // 修复后不再使用旧的通用「新增」按钮
  assert.match(source, /t\('transcription\.addHint'\)/, '应有预填说明文案（走 i18n 键）');
  assert.ok(zhCN['transcription.addHint'].includes('点厂商一键预填端点与模型'), '语言包中文值正确');
  assert.match(source, /Linking\.openURL\(getVendorForConfig\(config\)\.apiKeyUrl\)/, '厂商配置应提供官网获取密钥跳转');
  assert.match(source, /t\('transcription\.getKey'\)/, 'API Key 字段下方应显示获取密钥链接（走 i18n 键）');
  assert.equal(zhCN['transcription.getKey'], '获取密钥', '语言包中文值正确');
});

test('ChatScreen 转写失败提示包含具体厂商推荐', () => {
  const source = read('src/ChatScreen.js');
  assert.match(source, /t\('chat\.voice\.noTranscription\.body'\)/, '失败提示应引用厂商推荐文案的 i18n 键');
  assert.match(source, /t\('chat\.voice\.unsupported\.body'\)/, '不支持转写提示应引用厂商推荐文案的 i18n 键');
  assert.ok(zhCN['chat.voice.noTranscription.body'].includes('硅基流动 / Groq / OpenAI'), '失败提示应列出具体厂商名（语言包）');
  assert.ok(zhCN['chat.voice.noTranscription.body'].includes('一键预填'), '提示应说明一键预填能力（语言包）');
  assert.match(source, /t\('chat\.voice\.transcribeFail\.body'/, '转写失败提示应引用 i18n 键');
  assert.ok(zhCN['chat.voice.transcribeFail.body'].includes('检查接口地址、密钥与模型名'), '网络类失败应提示排查方向（语言包）');
});
