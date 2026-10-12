import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildHousemateReactionPrompt,
  mergeReactionIntoMoments,
  parseHousemateReaction,
  selectReactingHousemates,
} from '../src/moments/housemateReactions.js';

const moment = {
  id: 'm1',
  characterId: 'c1',
  characterName: '甲',
  text: '今天搬进新家啦。',
  likes: [],
  comments: [],
};

test('同住反应提示词：包含发帖人、动态正文与同住房号', () => {
  const prompt = buildHousemateReactionPrompt({
    moment,
    reactor: { id: 'c2', name: '乙', persona: '毒舌但心软' },
    posterName: '甲',
    charName: '乙',
    sameHouseLabel: '001 号房子',
  });
  assert.ok(prompt.includes('甲'));
  assert.ok(prompt.includes('今天搬进新家啦。'));
  assert.ok(prompt.includes('001 号房子'));
  assert.ok(prompt.includes('毒舌但心软'));
  assert.ok(prompt.includes('点赞：是 或 否'));
  assert.ok(prompt.includes('评论：'));
});

test('解析模型输出：点赞/评论、无评论、容错前缀与格式', () => {
  assert.deepEqual(parseHousemateReaction('点赞：是\n评论：恭喜搬新家！'), {
    like: true,
    comment: '恭喜搬新家！',
  });
  assert.deepEqual(parseHousemateReaction('点赞：否\n评论：无'), { like: false, comment: '' });
  assert.deepEqual(parseHousemateReaction('点赞: 是\n评论: 「好耶」'), { like: true, comment: '好耶' });
  // 缺前缀：整段去掉点赞行后当评论
  assert.deepEqual(parseHousemateReaction('点赞：是\n记得请客'), { like: true, comment: '记得请客' });
  // 空输入
  assert.deepEqual(parseHousemateReaction(''), { like: false, comment: '' });
  // 超长截断
  const long = parseHousemateReaction(`点赞：是\n评论：${'啊'.repeat(200)}`);
  assert.ok(long.comment.length <= 120);
});

test('解析模型输出：否定优先、点赞行不落成评论（实测的 8 例）', () => {
  // 只回答了点赞问题：不能变成正文就是「否」/「是」的评论（runHousemateReactions
  // 用 !like && !comment 判断跳过，这类垃圾评论正好绕过了那道闸）。
  assert.deepEqual(parseHousemateReaction('否'), { like: false, comment: '' });
  assert.deepEqual(parseHousemateReaction('是'), { like: false, comment: '' });
  // 否定读成点赞的语义反转：「点赞…是」比「不点赞」靠后，取靠前的否定
  assert.deepEqual(parseHousemateReaction('不点赞是因为今天没空'), {
    like: false,
    comment: '不点赞是因为今天没空',
  });
  // 只删匹配片段会把「我点赞：否」剩成「我」
  assert.deepEqual(parseHousemateReaction('我点赞：否'), { like: false, comment: '' });
  assert.deepEqual(parseHousemateReaction('不点赞'), { like: false, comment: '' });
  // 反向：肯定在前、评论里出现「我不点赞」时不能被带偏
  assert.deepEqual(parseHousemateReaction('点赞：是\n评论：我不点赞'), {
    like: true,
    comment: '我不点赞',
  });
  // 行内字段被削掉，剩下的正文保留
  assert.deepEqual(parseHousemateReaction('点赞：是 因为今天开心'), {
    like: true,
    comment: '因为今天开心',
  });

  // 按提示词格式输出时必须完全正确（防过度修正）
  assert.deepEqual(parseHousemateReaction('点赞：否'), { like: false, comment: '' });
  assert.deepEqual(parseHousemateReaction('点赞：是\n评论：无'), { like: true, comment: '' });
  assert.deepEqual(parseHousemateReaction('点赞：否\n评论：不去了'), { like: false, comment: '不去了' });
});

test('选出待反应的同住角色：排除发帖人、已点赞或已评论者', () => {
  const mates = [
    { id: 'c1', name: '甲' },
    { id: 'c2', name: '乙' },
    { id: 'c3', name: '丙' },
    { id: 'c4', name: '丁' },
  ];
  const target = {
    ...moment,
    likes: [{ by: 'character', characterId: 'c2', name: '乙' }],
    comments: [{ by: 'character', characterId: 'c3', name: '丙', text: 'hi' }],
  };
  const pending = selectReactingHousemates({ reactors: mates, moment: target });
  // c1 是发帖人排除，c2 已赞、c3 已评 → 只剩 c4
  assert.deepEqual(pending.map(item => item.id), ['c4']);
  // max 限制
  assert.equal(selectReactingHousemates({ reactors: mates, moment, max: 2 }).length, 2);
});

test('合并反应：新增点赞与评论，去重不重复写', () => {
  let list = [moment];
  list = mergeReactionIntoMoments(list, 'm1', {
    characterId: 'c2', name: '乙', like: true, comment: '恭喜！', createdAt: 100,
  });
  assert.equal(list[0].likes.length, 1);
  assert.equal(list[0].likes[0].characterId, 'c2');
  assert.equal(list[0].comments.length, 1);
  assert.equal(list[0].comments[0].text, '恭喜！');
  // 同一角色重复合并 → 不变
  list = mergeReactionIntoMoments(list, 'm1', {
    characterId: 'c2', name: '乙', like: true, comment: '又来', createdAt: 200,
  });
  assert.equal(list[0].likes.length, 1);
  assert.equal(list[0].comments.length, 1);
  // 其它动态不动
  assert.equal(mergeReactionIntoMoments([moment], 'missing', { characterId: 'c2' }).length, 1);
});
