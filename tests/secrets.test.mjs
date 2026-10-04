import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearRegisteredSecrets,
  maskSecrets,
  registerSecretValues,
} from '../src/storage/secrets.js';

const MASK = '[API_KEY已隐藏]';

test('遮蔽常见前缀的密钥', () => {
  assert.equal(maskSecrets('key=sk-abcdefghijklmnopqrst'), `key=${MASK}`);
  assert.equal(maskSecrets('AIzaSyA1234567890abcdefghijklmnopqrs'), MASK);
  assert.equal(maskSecrets('Authorization: Bearer abc.def-ghi_jkl'), `Authorization: ${MASK}`);
});

test('遮蔽带连字符的 sk- 新形态，以及大小写 Bearer 与 base64 字符集', () => {
  // OpenAI 现行 key 与 Anthropic key 均含连字符，旧正则的 [a-zA-Z0-9] 会漏掉
  assert.equal(maskSecrets('key=sk-proj-AbCdEfGhIjKlMnOpQrStUvWx'), `key=${MASK}`);
  assert.equal(maskSecrets('key=sk-ant-api03-abcdefghijklmnop'), `key=${MASK}`);
  assert.equal(maskSecrets('key=sk-svcacct-abcdefghijklmnop'), `key=${MASK}`);
  // HTTP 头大小写不敏感；base64 密钥含 +/=，旧的字符集会在这些字符处截断
  assert.equal(maskSecrets('Authorization: bearer abcdefghijkl'), `Authorization: ${MASK}`);
  assert.equal(maskSecrets('Authorization: Bearer abc+def/ghi=='), `Authorization: ${MASK}`);
  // 普通散文里的 Bearer 后接短词不应误伤
  assert.equal(maskSecrets('Bearer of good news'), 'Bearer of good news');
});

test('遮蔽登记过的无前缀密钥（靠前缀猜不到的那类）', () => {
  clearRegisteredSecrets();
  const plain = '9f8e7d6c5b4a39281706';
  registerSecretValues([plain]);
  assert.equal(maskSecrets(`请求失败: ${plain} 无效`), `请求失败: ${MASK} 无效`);
  clearRegisteredSecrets();
  assert.equal(maskSecrets(`请求失败: ${plain} 无效`), `请求失败: ${plain} 无效`);
});

test('过短的值不纳入登记，避免把普通文本也遮掉', () => {
  clearRegisteredSecrets();
  registerSecretValues(['abc', '']);
  assert.equal(maskSecrets('abc def'), 'abc def');
  clearRegisteredSecrets();
});

test('重叠密钥按最长值优先完整遮蔽', () => {
  clearRegisteredSecrets();
  registerSecretValues(['abcdefgh', 'abcdefghijkl']);
  assert.equal(maskSecrets('key=abcdefghijkl'), `key=${MASK}`);
  clearRegisteredSecrets();
});

test('空输入与 null 安全', () => {
  assert.equal(maskSecrets(''), '');
  assert.equal(maskSecrets(null), '');
  assert.equal(maskSecrets(undefined), '');
});
