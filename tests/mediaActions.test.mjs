// 图片/表情包消息的操作入口源码断言。
//
// 回归背景：MessageBubble 的操作行渲染条件曾写作
//   `!message.pending && !selectionMode && !message.image`
// ——最后那个 `!message.image` 把所有图片/表情包消息排除在外，于是它们永远
// 没有「⋯」菜单，图片操作只能靠长按手势触发（隐藏手势，用户难发现），
// 也没有任何修改重发的入口。
//
// UI 层（RN hooks/JSX）无法在纯 Node 里执行，按仓库既有惯例用源码断言锁定链路。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = relPath => fs.readFileSync(path.resolve(relPath), 'utf8');

test('操作行渲染条件不再排除图片消息（回归：图片/表情包缺「⋯」菜单）', () => {
  const source = read('src/chat/MessageBubble.js');
  // 操作行应只受 pending 与多选态约束
  assert.match(
    source,
    /\{!message\.pending && !selectionMode \? \(/,
    '操作行条件应为 !pending && !selectionMode（不得再排除 message.image）'
  );
  assert.equal(
    /\{!message\.pending && !selectionMode && !message\.image \? \(/.test(source),
    false,
    '旧的 !message.image 排除条件必须不复存在'
  );
  // 「⋯」按钮与菜单本体仍在
  assert.match(source, /accessibilityLabel="更多操作"/, '应保留「⋯」按钮');
  assert.match(source, /setActionsOpen\(true\)/, '「⋯」应打开操作菜单');
});

test('图片/表情包走独立菜单项：保存 / 保存为表情包 / 删除消息', () => {
  const source = read('src/chat/MessageBubble.js');
  assert.match(source, /const isMediaMessage = !!message\.image;/, '应识别媒体消息');
  // 媒体菜单分支
  assert.match(source, /key: 'save', label: '保存图片'/, '媒体菜单应含「保存图片」');
  assert.match(source, /key: 'sticker', label: '保存为表情包'/, '媒体菜单应含「保存为表情包」');
  assert.match(source, /key: 'delete', label: '删除消息'/, '媒体菜单应含「删除消息」');
  // 表情包本身不再提供「保存为表情包」（它已经是表情包）
  assert.match(
    source,
    /onSaveAsSticker && !message\.image\.stickerId/,
    '已是表情包的消息不应再出现「保存为表情包」'
  );
  // 媒体菜单不含无意义的文本操作
  const mediaBranch = source.slice(
    source.indexOf('const isMediaMessage = !!message.image;'),
    source.indexOf('    : [')
  );
  assert.equal(mediaBranch.includes("label: '复制'"), false, '媒体消息无正文，不应有「复制」');
  assert.equal(mediaBranch.includes("label: '选择文本'"), false, '媒体消息无正文，不应有「选择文本」');
  assert.equal(mediaBranch.includes("label: '引用'"), false, '媒体菜单不放引用（图片无正文可引用）');
  // 播报按钮对媒体消息隐藏（无正文可播）
  assert.match(source, /!isUser && !isMediaMessage && onBroadcast/, '媒体消息不显示播报');
});

test('图片消息可修改重发：回填附件而非正文', () => {
  const source = read('src/chat/MessageBubble.js');
  const sendSource = read('src/chat/useChatSend.js');
  // 媒体菜单里的修改重发仅对用户消息开放（助手图片不可撤回重发）
  assert.match(
    source,
    /isUser && onEditUserMessage\s*\?\s*\{ key: 'edit', label: '修改重发'/,
    '媒体菜单的修改重发应限定用户消息'
  );
  // 撤回时把图片放回附件区并刷新保护集合
  assert.match(sendSource, /latestPlan\.attachments/, '撤回逻辑应读取回填附件');
  assert.match(
    sendSource,
    /setAttachments\(current => \{\s*\n\s*const next = \[\.\.\.current, \.\.\.restored\]/,
    '撤回后应把图片追加回附件区'
  );
  assert.match(
    sendSource,
    /syncProtectedAttachmentUris\(\);/,
    '回填附件后应刷新保护集合，避免被孤儿文件回收误删'
  );
  // 确认文案按类型区分
  assert.match(sendSource, /isMediaPlan/, '应区分媒体撤回文案');
  assert.match(sendSource, /把图片放回待发送附件/, '媒体撤回提示应说明回到附件区');
});

test('三个点菜单的接线贯通：ChatScreen → MessageList → MessageBubble', () => {
  const chatSource = read('src/ChatScreen.js');
  const listSource = read('src/chat/MessageList.js');
  // ChatScreen 把媒体操作回调传给 MessageList
  assert.match(chatSource, /onSaveImage=\{ saveImage \}/, 'ChatScreen 应传 onSaveImage');
  assert.match(chatSource, /onSaveAsSticker=\{ openStickerNamePrompt \}/, 'ChatScreen 应传 onSaveAsSticker');
  assert.match(chatSource, /onDeleteImageMessage=\{ confirmDeleteImageMessage \}/, 'ChatScreen 应传 onDeleteImageMessage');
  // MessageList 接收并转发
  for (const prop of ['onSaveImage', 'onSaveAsSticker', 'onDeleteImageMessage']) {
    assert.ok(listSource.includes(`${prop},`), `MessageList 应解构 ${prop}`);
    assert.ok(listSource.includes(`${prop}={${prop}}`), `MessageList 应转发 ${prop}`);
  }
  // 长按手势保留（媒体消息长按仍可用，作为既有快捷方式）
  assert.match(listSource, /if \(message\.image\) openImageActions/, '长按图片的既有入口应保留');
});
