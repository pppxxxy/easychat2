// 应用锁「状态未知」接线契约测试（回归 2026-10-12 逐条审查：安全设置读损坏 → 全未加锁）。
//
// 缺陷形态：storage/security.js 读损坏时已经调过 backupCorruptValue（原始值保住了），
// 但返回值被折叠成「默认 = 未加锁」；SecurityGate 的 catch 分支同样把「读不出来」
// 直接回落 `appLock.enabled: false`。两处合起来 = **保留数据却丢弃保护**。
//
// 逻辑本体（三态 + 保守策略）在 tests/securityStorage.test.mjs 直接断言；
// 这里守住 SecurityGate 的接线：未知态必须走「不放行」的分支，并且界面文案要说
// 「状态未知」而不是显示成「未加锁」。组件带 react-native 依赖，故按本仓惯例做源码级断言
//（同 tests/bulkCharacterLock.test.mjs）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { localeSource } from './helpers/localeSource.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = relative => readFileSync(path.join(HERE, '..', relative), 'utf8');

const gateSrc = read('src/security/SecurityGate.js');
const securitySrc = read('src/storage/security.js');
const zh = localeSource('src/i18n/locales/zh-CN');
const en = localeSource('src/i18n/locales/en');

// 「未知」态必须用到的四条文案（zh/en 双语言都要有）。
const UNKNOWN_KEYS = [
  'error.security.stateUnknownTitle',
  'error.security.stateUnknownHint',
  'error.security.stateUnknownRetry',
  'error.security.stateUnknownVerify',
  'error.security.stateUnknownContinue',
  'error.security.stateUnknownNotice',
];

test('SecurityGate：读取失败/损坏时不再折叠成「未加锁」', () => {
  // 旧实现：catch 里 `settings = { appLock: { enabled: false, ... } }` 之后照常放行。
  // 现在必须先把状态标成 unknown，再交给 resolveAppLockPolicy 判保守策略。
  assert.ok(
    gateSrc.includes('SECURITY_STATUS.UNKNOWN'),
    'catch 分支必须把「读不出来」标成状态未知，而不是当成「没有锁」'
  );
  assert.ok(
    gateSrc.includes('resolveAppLockPolicy('),
    '是否要求解锁必须由 security.js 的保守策略决定（不能在调用点各自 if）'
  );
  assert.ok(
    /appLockEnabledRef\.current\s*=\s*policy\.requireUnlock/.test(gateSrc),
    '应用锁开关必须取自策略结果（未知 ⇒ requireUnlock 为真）'
  );
  // 反向断言：不能再出现「直接拿 settings.appLock.enabled 当开关」的旧写法。
  assert.equal(
    /appLockEnabledRef\.current\s*=\s*settings\.appLock\.enabled/.test(gateSrc),
    false,
    '不得回到「settings.appLock.enabled 直接当开关」——那正是损坏即放行的形态'
  );
  assert.ok(
    securitySrc.includes('requireUnlock: unknown ||'),
    '策略本身要写明「未知 ⇒ 要求验证」（宁可多要一次验证，绝不静默放行）'
  );
});

test('SecurityGate：未知态有独立的拦截层，不依赖应用锁是否落得下来', () => {
  // 未知态拦截层必须独立于 appLocked：应用锁可能因「设备没有可用验证手段」的安全阀
  // 落不下来，那种情况下未知态仍不能放行。
  assert.ok(
    /if \(securityUnknown && !unknownAcknowledged\)/.test(gateSrc),
    '未知态必须有独立的拦截分支'
  );
  assert.ok(
    gateSrc.includes('setUnknownAcknowledged(true)'),
    '未知态要有明确的「已确认」状态（用户主动确认，而不是静默通过）'
  );
  assert.ok(
    gateSrc.includes('retrySecurity'),
    '未知态要提供「重新读取」入口（损坏数据被清理后能自愈）'
  );
  // 未知态的拦截分支必须排在「角色锁弹窗」之前：未知态下 characterLocks 是空对象，
  // 若排在后面就永远走不到，等于没有拦截。
  const unknownIndex = gateSrc.indexOf('if (securityUnknown && !unknownAcknowledged)');
  const charLockIndex = gateSrc.indexOf('if (showCharacterLock)');
  assert.ok(unknownIndex > 0 && charLockIndex > unknownIndex, '未知态拦截要排在角色锁弹窗之前');
});

test('SecurityGate：界面能看出「状态未知」而不是「未加锁」', () => {
  for (const key of UNKNOWN_KEYS) {
    assert.ok(gateSrc.includes(`t('${key}')`), `SecurityGate 应使用文案 ${key}`);
  }
  // 未知态的标题/说明必须**独立于**普通解锁文案：用户看到的若是普通的「已锁定」，
  // 就分不出是「设置被读坏了」还是「本来就锁着」。
  assert.equal(
    UNKNOWN_KEYS.includes('security.unlock.title'),
    false,
    '未知态文案不得复用普通解锁文案'
  );
  // 普通解锁弹层里也要带一句「状态未知」提示（未知态 + 生物识别可用时走的是那层）。
  assert.ok(
    /securityUnknown \? \(\s*<Text style=\{styles\.lockWarn\}>\{t\('error\.security\.stateUnknownNotice'\)\}/.test(gateSrc),
    '普通解锁弹层里要标明「状态未知」，不能看起来像普通的「已锁定」'
  );
});

test('i18n：未知态文案 zh/en 都补齐（英文用户不能看到中文或键名）', () => {
  for (const key of UNKNOWN_KEYS) {
    assert.ok(zh.includes(`'${key}'`), `zh-CN 缺词条 ${key}`);
    assert.ok(en.includes(`'${key}'`), `en 缺词条 ${key}`);
  }
});
