import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearRegisteredSecrets,
  maskSecrets,
  registerSecretValues,
} from '../src/secrets.js';

const MASK = '[API_KEY已隐藏]';

test('遮蔽常见前缀的密钥', () => {
  assert.equal(maskSecrets('key=sk-abcdefghijklmnopqrst'), `key=${MASK}`);
  assert.equal(maskSecrets('AIzaSyA1234567890abcdefghijklmnopqrs'), MASK);
  assert.equal(maskSecrets('Authorization: Bearer abc.def-ghi_jkl'), `Authorization: ${MASK}`);
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
