// 角色库多选删除的**行为测试**（不是源码字符串断言）。
//
// 背景：CharacterLibraryScreen.js 依赖 react-native，Node 里导入不了整屏，于是
// 「删除全部角色」确认门、失败文案口径、以及删除步骤的顺序过去一条都测不到。
// 这批把三条判定抽到 src/character/characterLibraryDelete.js（纯逻辑，零依赖），
// 这里直接跑真实函数的行为：
// - P1-1 失败文案按**实际**删掉的东西报，且不谎报「关联记忆已删除」；
// - P1-2 执行顺序：先删角色（可重试），成功后才做不可逆的清理；角色删失败 ⇒ 一步都不清；
// - P1-3 确认门：只有整库可删角色**全在**选中集合里才升级成「删除全部角色」。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  characterCleanupFailureMessageKey,
  normalizeDeleteTargetIds,
  runCharacterDelete,
  selectableCharacterIds,
  shouldDeleteEverything,
} from '../src/character/characterLibraryDelete.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const make = (id, extra = {}) => ({ id, name: id, ...extra });

test('selectableCharacterIds：默认角色不可删，其余全算，空 id 不计', () => {
  assert.deepEqual(
    selectableCharacterIds([make('default'), make('a'), make('b')]),
    ['a', 'b']
  );
  assert.deepEqual(selectableCharacterIds(null), [], '非数组当空，不炸');
  assert.deepEqual(selectableCharacterIds([{ id: '' }, null, make('c')]), ['c']);
});

test('normalizeDeleteTargetIds：非数组当空、非字符串串化去空（各删除入口同一口径）', () => {
  assert.deepEqual(normalizeDeleteTargetIds(['a', '', null, 1]), ['a', '1']);
  assert.deepEqual(normalizeDeleteTargetIds(undefined), []);
});

test('P1-3 确认门：整库可删角色全在选中集合里才为真', () => {
  const characters = [make('default'), make('a'), make('b')];
  assert.equal(shouldDeleteEverything(['a', 'b'], characters), true, '删光整库 → 升级重确认');
  assert.equal(shouldDeleteEverything(['b', 'a'], characters), true, '顺序无关');
  assert.equal(shouldDeleteEverything(['a'], characters), false, '只删子集 → 走普通确认');
  assert.equal(shouldDeleteEverything([], characters), false);
  assert.equal(shouldDeleteEverything(['a', 'b'], [make('default')]), false, '只有默认角色 → 无可删项');
});

test('P1-3 回归：搜索过滤后的子集 + 陈旧/重复 id 都不得误触发「删除全部角色」', () => {
  const characters = [make('default'), make('a'), make('b'), make('c')];
  // 搜索只剩 a、b 两项时全选：这是子集，不能升级成「会删除除默认角色外的全部角色」的重确认
  assert.equal(shouldDeleteEverything(['a', 'b'], characters), false);
  // 旧写法是 `selectedIds.length >= 全库数`：混进库外的陈旧 id 后长度够了就误触发。
  assert.equal(shouldDeleteEverything(['a', 'b', 'ghost'], characters), false, '库外陈旧 id 不能凑数');
  assert.equal(shouldDeleteEverything(['a', 'b', 'c', 'ghost'], characters), true, '真的全选中才为真');
  assert.equal(shouldDeleteEverything(['a', 'a', 'b', 'c'], characters), true, '重复 id 不改变结论');
});

test('P1-1 文案：按实际删除结果选词条；没有关联记忆时不得谎报「记忆已删除」', () => {
  // 关联清理全部成功 → 不弹提示
  assert.equal(
    characterCleanupFailureMessageKey({ momentsDeleted: true, sessionsDeleted: true, hasSessions: true }),
    null
  );
  // 本来就没有关联记忆（memoryIds 为空）：只删了动态也算全成功，绝不报「动态和记忆都删了」
  assert.equal(
    characterCleanupFailureMessageKey({ momentsDeleted: true, sessionsDeleted: false, hasSessions: false }),
    null,
    '没有记忆可删 ⇒ 不能报「关联记忆已删除/清理失败」'
  );
  assert.equal(
    characterCleanupFailureMessageKey({ momentsDeleted: false, sessionsDeleted: false, hasSessions: false }),
    'character.library.delete.fail.cleanupMoments',
    '只有动态真的没清掉'
  );
  assert.equal(
    characterCleanupFailureMessageKey({ momentsDeleted: true, sessionsDeleted: false, hasSessions: true }),
    'character.library.delete.fail.cleanupSessions',
    '动态清了、记忆没清'
  );
  assert.equal(
    characterCleanupFailureMessageKey({ momentsDeleted: false, sessionsDeleted: false, hasSessions: true }),
    'character.library.delete.fail.cleanupBoth'
  );
});

// 记录调用顺序的探针。
function makeProbe({ failCharacter = false, failMoments = false, failSessions = false } = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      deleteCharactersStep: async () => {
        calls.push('deleteCharacters');
        if (failCharacter) throw new Error('角色删除失败');
      },
      removeMomentsStep: async () => {
        calls.push('removeMoments');
        if (failMoments) throw new Error('动态清理失败');
      },
      deleteSessionsStep: async () => {
        calls.push('deleteSessions');
        if (failSessions) throw new Error('记忆清理失败');
      },
    },
  };
}

test('P1-2 顺序：先删角色，再做不可逆的动态与会话清理', async () => {
  const probe = makeProbe();
  const result = await runCharacterDelete({
    ...probe.deps,
    deleteMemories: true,
    memoryIds: ['s1'],
  });
  assert.deepEqual(probe.calls, ['deleteCharacters', 'removeMoments', 'deleteSessions'],
    '不可逆清理必须排在可重试的删角色之后');
  assert.deepEqual(result, {
    characterDeleted: true,
    momentsDeleted: true,
    sessionsDeleted: true,
    momentsError: null,
    sessionsError: null,
  });
});

test('P1-2 fail-closed：角色删除失败 ⇒ 关联数据一个字节都不动，且原错误向上抛', async () => {
  const probe = makeProbe({ failCharacter: true });
  await assert.rejects(
    runCharacterDelete({ ...probe.deps, deleteMemories: true, memoryIds: ['s1'] }),
    /角色删除失败/,
    '原错误必须原样抛出（调用方据此报原始错误，不吞）'
  );
  assert.deepEqual(probe.calls, ['deleteCharacters'],
    '角色没删掉就绝不能动动态/会话（旧顺序正是这里把记忆永久删掉的）');
});

test('「仅删角色」不碰动态与会话', async () => {
  const probe = makeProbe();
  const result = await runCharacterDelete({
    ...probe.deps,
    deleteMemories: false,
    memoryIds: ['s1'],
  });
  assert.deepEqual(probe.calls, ['deleteCharacters']);
  assert.equal(result.momentsDeleted, false);
  assert.equal(result.sessionsDeleted, false);
});

test('没有关联会话时：不调用会话删除，也不谎报 sessionsDeleted', async () => {
  const probe = makeProbe();
  const result = await runCharacterDelete({ ...probe.deps, deleteMemories: true, memoryIds: [] });
  assert.deepEqual(probe.calls, ['deleteCharacters', 'removeMoments'], '没有记忆可删就不调删除');
  assert.equal(result.momentsDeleted, true);
  assert.equal(result.sessionsDeleted, false, 'sessionsDeleted 必须反映「真的删过」');
  assert.equal(
    characterCleanupFailureMessageKey({
      momentsDeleted: result.momentsDeleted,
      sessionsDeleted: result.sessionsDeleted,
      hasSessions: false,
    }),
    null,
    '一条都没删也不报「已删除」'
  );
});

test('清理失败不中断后续步骤，失败原因带在返回值里（角色已经删了，用户要知道没清掉什么）', async () => {
  const probe = makeProbe({ failMoments: true, failSessions: true });
  const result = await runCharacterDelete({ ...probe.deps, deleteMemories: true, memoryIds: ['s1'] });
  assert.deepEqual(probe.calls, ['deleteCharacters', 'removeMoments', 'deleteSessions'],
    '动态清理失败也要继续尝试清记忆（两者互不依赖）');
  assert.equal(result.characterDeleted, true);
  assert.equal(result.momentsDeleted, false);
  assert.equal(result.sessionsDeleted, false);
  assert.equal(result.momentsError.message, '动态清理失败');
  assert.equal(result.sessionsError.message, '记忆清理失败');
  assert.equal(
    characterCleanupFailureMessageKey({
      momentsDeleted: result.momentsDeleted,
      sessionsDeleted: result.sessionsDeleted,
      hasSessions: true,
    }),
    'character.library.delete.fail.cleanupBoth'
  );
});

// 防「行为测试与屏脱节」：上面的断言跑的是抽出来的纯逻辑，屏里若改回内联旧写法，
// 它们仍然全绿。这一条只钉**接线**（不是文案/逻辑本身，那些上面已经按行为测过了）。
test('接线：CharacterLibraryScreen 的删除流程确实调用抽出来的纯逻辑', () => {
  const source = readFileSync(
    path.join(HERE, '..', 'src', 'character', 'CharacterLibraryScreen.js'),
    'utf8'
  );
  assert.ok(source.includes('runCharacterDelete({'), '删除流程必须走 runCharacterDelete（顺序纪律在那边）');
  assert.ok(source.includes('shouldDeleteEverything(selectedIds, characters)'), '确认门必须走 shouldDeleteEverything');
  assert.ok(source.includes('characterCleanupFailureMessageKey('), '失败文案必须按实际删除结果选');
  assert.ok(!source.includes('sessionsDeleted = true'), '不得再出现无条件置位（P1-1 的原始缺陷）');
  assert.ok(!source.includes('beforeCharacterDelete'), '不得再出现「先删记忆/动态再删角色」的旧顺序（P1-2）');
});
