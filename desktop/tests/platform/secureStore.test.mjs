// 密钥适配 + 主进程密钥仓（design.md「适配层契约 3」）行为测试。
//
// 覆盖：safeStorage 不可用时的明文降级、解密失败按「密钥不在」返回 null、
// 删除幂等、落盘文件名不含明文 id。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { makeSandbox } from '../helpers/sandbox.mjs';
import { createSecretStore } from '../../electron/ipc/secret.js';
import { createSecureStore } from '../../src/platform/secureStore.js';

test('SecureStore 适配：不可用时明文降级 + 诊断记录，读写删语义正确', async () => {
  const sandbox = makeSandbox();
  try {
    const store = createSecureStore(sandbox.bridge);
    assert.equal(await store.isAvailableAsync(), false, '测试沙箱未注入 safeStorage');

    await store.setItemAsync('api-key-1', 'sk-test-value');
    assert.equal(await store.getItemAsync('api-key-1'), 'sk-test-value');
    assert.ok(
      sandbox.recordDiagnostic.some(([, error]) => String(error && error.message).includes('plaintext')),
      '不可用降级必须记录诊断'
    );

    await store.deleteItemAsync('api-key-1');
    assert.equal(await store.getItemAsync('api-key-1'), null);
    await store.deleteItemAsync('api-key-1'); // 幂等
  } finally {
    sandbox.cleanup();
  }
});

test('密钥仓：安全存储可用时加密落盘，解密失败返回 null 而不是抛错', async () => {
  const sandbox = makeSandbox();
  try {
    let available = true;
    let decryptWorks = true;
    // 假加密：base64 变换（保证「落盘内容不含明文」这条断言真的在测加密路径，
    // 而不是在同义反复地断言假实现）。
    const fakeSafeStorage = {
      isEncryptionAvailable: () => available,
      encryptString: value => Buffer.from(Buffer.from(String(value), 'utf8').toString('base64'), 'utf8'),
      decryptString: data => {
        if (!decryptWorks) throw new Error('DPAPI key rotated');
        return Buffer.from(data.toString('utf8'), 'base64').toString('utf8');
      },
    };
    const store = createSecretStore({ root: sandbox.secretsRoot, safeStorage: fakeSafeStorage });

    await store.setItemAsync('k1', 'secret-1');
    assert.equal(await store.getItemAsync('k1'), 'secret-1');
    // 落盘内容不是明文。
    const files = fs.readdirSync(sandbox.secretsRoot);
    assert.equal(files.length, 1);
    const raw = fs.readFileSync(`${sandbox.secretsRoot}/${files[0]}`, 'utf8');
    assert.ok(!raw.includes('secret-1'), '可用时不得明文落盘');
    // 文件名是哈希，不含明文 id。
    assert.ok(!files[0].includes('k1'));

    // 换机器/DPAPI 轮换：解密失败 -> null（上层按密钥不在降级）。
    decryptWorks = false;
    assert.equal(await store.getItemAsync('k1'), null);
  } finally {
    sandbox.cleanup();
  }
});
