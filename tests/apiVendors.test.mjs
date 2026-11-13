// 聊天 API 厂商预设（v5 修复 F2）行为测试：OpenRouter 内置化。
import test from 'node:test';
import assert from 'node:assert/strict';

import { CHAT_API_VENDORS, getChatApiVendor } from '../src/network/apiVendors.js';
import { zhCN } from '../src/i18n/locales/zh-CN.js';

test('OpenRouter 已内置为聊天厂商，坐标与协议正确', () => {
  const vendor = getChatApiVendor('openrouter');
  assert.ok(vendor, 'OpenRouter 预设应存在');
  assert.equal(vendor.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(vendor.protocol, 'openai');
  assert.equal(vendor.apiKeyUrl, 'https://openrouter.ai/keys');
  assert.equal(vendor.category.includes('chat'), true);
  assert.match(zhCN[vendor.noteKey], /上游|透传/, 'note 应说明聚合上游与错误透传');
});

test('厂商 id 唯一', () => {
  const ids = CHAT_API_VENDORS.map(vendor => vendor.id);
  assert.equal(new Set(ids).size, ids.length, '厂商 id 不得重复');
});

test('Kilo Gateway 预设置为匿名：不发鉴权头、带默认免费模型', async () => {
  const vendor = getChatApiVendor('kilo-gateway');
  assert.ok(vendor, 'Kilo 预设应存在');
  assert.equal(vendor.baseUrl, 'https://ai-gateway.kilo.ai/api/v1');
  assert.equal(vendor.anonymous, true, '必须显式声明匿名（带 key 会被判 401）');
  assert.equal(vendor.anonymousModel, 'kilo-auto/free');
  assert.equal(typeof zhCN[vendor.nameKey], 'string');
  assert.match(zhCN[vendor.noteKey], /200 次|:free/, 'note 应写明限流与免费模型形态');
});
