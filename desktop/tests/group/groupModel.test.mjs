// 桌面群聊纯逻辑（groupModel）的行为测试。
//
// 这里的每条约束都对应一次真实误用：
//   · 上限不生效 → 能建出 9 人群（共享层按 8 设计，调度器只取前几个，静默变味）；
//   · 群名兜底分隔符写死中文 → 英文界面里出现「、」；
//   · 成员被删后静默少人 → 用户以为角色「不说话了」。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  groupDisplayName,
  groupMemberState,
  resolveGroupMembers,
  resolveGroupName,
  speakerNameOf,
  toggleGroupMember,
} from '../../src/group/groupModel.js';
import { MAX_GROUP_MEMBERS, MIN_GROUP_MEMBERS } from '../../../src/chat/groupChat/groupLimits.js';

const ids = n => Array.from({ length: n }, (_, i) => `c${i + 1}`);

function mapOf(characters) {
  const map = new Map();
  characters.forEach(character => map.set(character.id, character));
  return map;
}

test('成员上限是共享常量：手机与桌面同源', () => {
  assert.equal(MIN_GROUP_MEMBERS, 2);
  assert.equal(MAX_GROUP_MEMBERS, 8);
});

test('toggleGroupMember：可选可取消，满员后不再增加', () => {
  assert.deepEqual(toggleGroupMember([], 'a'), ['a']);
  assert.deepEqual(toggleGroupMember(['a'], 'a'), []);
  const full = ids(MAX_GROUP_MEMBERS);
  const attempted = toggleGroupMember(full, 'extra');
  assert.equal(attempted.length, MAX_GROUP_MEMBERS, '满员时不得再增加');
  assert.equal(attempted.includes('extra'), false);
  // 满员仍可取消已有成员。
  assert.equal(toggleGroupMember(full, full[0]).length, MAX_GROUP_MEMBERS - 1);
  // 空 id 不产生幽灵成员。
  assert.deepEqual(toggleGroupMember(['a'], ''), ['a']);
  // 不修改入参（调用方可直接 setState）。
  const source = ['a'];
  toggleGroupMember(source, 'b');
  assert.deepEqual(source, ['a']);
});

test('groupMemberState：2–8 才可创建，8 人即到上限', () => {
  assert.deepEqual(groupMemberState([]).canCreate, false);
  assert.deepEqual(groupMemberState(['a']).canCreate, false);
  assert.deepEqual(groupMemberState(['a', 'b']), { count: 2, canCreate: true, atLimit: false });
  assert.deepEqual(groupMemberState(ids(MAX_GROUP_MEMBERS)), {
    count: MAX_GROUP_MEMBERS,
    canCreate: true,
    atLimit: true,
  });
  assert.equal(groupMemberState(ids(MAX_GROUP_MEMBERS + 1)).canCreate, false, '超过上限不可创建');
});

test('resolveGroupName：填了用填的，空则按成员名兜底', () => {
  assert.equal(resolveGroupName('  读书会 ', ['甲', '乙'], '、'), '读书会');
  assert.equal(resolveGroupName('', ['甲', '乙'], '、'), '甲、乙');
  assert.equal(resolveGroupName('   ', ['甲', '', '乙'], '、'), '甲、乙', '空成员名被跳过');
  assert.equal(resolveGroupName('', [], '、'), '');
  // 分隔符由调用方给（中文「、」/ 英文「, 」），本模块不写死标点。
  assert.equal(resolveGroupName('', ['A', 'B'], ', '), 'A, B');
});

test('groupDisplayName：会话名优先，其次成员名，最后兜底文案', () => {
  assert.equal(groupDisplayName({ name: '读书会' }, ['甲'], '群聊', '、'), '读书会');
  assert.equal(groupDisplayName({ name: '  ' }, ['甲', '乙'], '群聊', '、'), '甲、乙');
  assert.equal(groupDisplayName({ name: '' }, [], '群聊', '、'), '群聊');
  assert.equal(groupDisplayName(null, [], '群聊', '、'), '群聊');
});

test('resolveGroupMembers：按 members 顺序解析，缺失成员要能被数出来', () => {
  const a = { id: 'c1', name: '甲' };
  const b = { id: 'c2', name: '乙' };
  const { members, missingIds } = resolveGroupMembers({ members: ['c2', 'c1'] }, mapOf([a, b]));
  assert.deepEqual(members.map(item => item.id), ['c2', 'c1'], '顺序跟随会话的 members');
  assert.deepEqual(missingIds, []);

  const partial = resolveGroupMembers({ members: ['c1', 'gone', 'c2'] }, mapOf([a, b]));
  assert.deepEqual(partial.members.map(item => item.id), ['c1', 'c2']);
  assert.deepEqual(partial.missingIds, ['gone'], '被删成员必须显式列出');

  // 单聊会话（无 members）解析成空，不抛。
  assert.deepEqual(resolveGroupMembers({ type: 'single' }, mapOf([a])), { members: [], missingIds: [] });
  assert.deepEqual(resolveGroupMembers(null, mapOf([a])), { members: [], missingIds: [] });
});

test('speakerNameOf：消息自带发言人优先，缺省回落到唯一成员名', () => {
  assert.equal(speakerNameOf({ speakerName: '甲' }, ['乙'], '群聊'), '甲');
  assert.equal(speakerNameOf({ speakerName: '  ' }, ['乙'], '群聊'), '乙');
  assert.equal(speakerNameOf({}, ['乙'], '群聊'), '乙');
  // 多成员且消息没带发言人：不猜是谁，交给调用方的兜底文案（通常是群名）。
  assert.equal(speakerNameOf({}, ['乙', '丙'], '读书会'), '读书会');
  assert.equal(speakerNameOf(null, [], '读书会'), '读书会');
});