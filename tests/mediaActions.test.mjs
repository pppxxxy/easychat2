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

test('图片/表情包走独立菜单项：保存 / 保存为表情包 / 引用 / 删除消息', () => {
  const source = read('src/chat/MessageBubble.js');
  assert.match(source, /const isMediaMessage = !!message\.image;/, '应识别媒体消息');
  // 媒体菜单分支
  assert.match(source, /key: 'save', label: '保存图片'/, '媒体菜单应含「保存图片」');
  assert.match(source, /key: 'sticker', label: '保存为表情包'/, '媒体菜单应含「保存为表情包」');
  assert.match(source, /key: 'delete', label: '删除消息'/, '媒体菜单应含「删除消息」');
  // 引用：媒体消息没有正文，但引用走占位文本（【图片】/【表情包：名字】），
  // 和文字消息引用一样能进输入区的引用条——所以媒体菜单必须提供引用入口。
  assert.match(source, /key: 'quote', label: '引用'/, '媒体菜单应含「引用」');
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
  // 播报按钮对媒体消息隐藏（无正文可播）
  assert.match(source, /!isUser && !isMediaMessage && onBroadcast/, '媒体消息不显示播报');
});

test('媒体消息的引用两处入口都接线（菜单 + 长按），且引用占位文本参与请求', () => {
  const bubble = read('src/chat/MessageBubble.js');
  const list = read('src/chat/MessageList.js');
  const chat = read('src/ChatScreen.js');
  // 菜单项走 onQuote，MessageList 把 onQuoteMessage 转发给气泡
  assert.match(bubble, /key: 'quote', label: '引用', icon: 'chatbubble-ellipses-outline', onPress: \(\) => onQuote\(message\)/, '菜单引用应调用 onQuote(message)');
  assert.match(list, /onQuote=\{onQuoteMessage\}/, 'MessageList 应把 onQuoteMessage 接到 onQuote');
  // 长按菜单（媒体消息的隐藏入口）同样要有引用，且用 messagesRef 找到目标消息
  assert.match(chat, /const target = messagesRef\.current\.find\(item => item && item\.id === messageId\)/, '长按菜单应能定位到目标消息');
  assert.match(chat, /\.\.\.\(target \? \[\{ text: '引用', onPress: \(\) => onQuoteMessage\(target\) \}\] : \[\]\)/, '长按菜单应在能找到消息时提供引用');
  // 引用占位文本进入模型请求（buildQuotePayload → quote → chatPipeline 的 [引用…] 段）
  const helpers = read('src/chat/chatHelpers.js');
  assert.match(helpers, /if \(stickerName\) return `【表情包：\$\{stickerName\}】`/, '表情包引用占位文本');
  assert.match(helpers, /return '【图片】'/, '图片引用占位文本');
  const pipeline = read('src/prompt/chatPipeline.js');
  assert.match(pipeline, /\[引用\$\{String\(quote\.name \|\| ''\)\.trim\(\) \|\| '对方'\}的消息\]/, '引用文本进入用户消息提示');
});

test('角色发出的媒体消息同样渲染图片（回归：助手表情包渲染成空气泡）', () => {
  const source = read('src/chat/MessageBubble.js');
  // 渲染分支不得再用 isUser 限定：角色也能真的发表情包（[[表情包:名称]]）
  assert.match(source, /\n\s*\) : message\.image\?\.uri \? \(/, '媒体渲染分支不应限定 isUser');
  assert.equal(
    /\) : isUser && message\.image\?\.uri \? \(/.test(source),
    false,
    '旧的 isUser && message.image 渲染条件必须不复存在（助手媒体消息会渲染成空气泡）'
  );
  // 样式名不再带 user 前缀（同一组样式两边共用）
  assert.match(source, /<View style=\{styles\.mediaBox\}>/, '应使用共用 mediaBox 样式');
  assert.match(source, /style=\{\[styles\.messageImage, \{ width: mediaWidth, height: mediaHeight \}\]\}/, '应使用共用 messageImage 样式');
  const styles = read('src/chat/chatStyles.js');
  assert.match(styles, /mediaBox: \{/, 'chatStyles 应有 mediaBox');
  assert.match(styles, /messageImage: \{/, 'chatStyles 应有 messageImage');
  assert.match(styles, /mediaName: \{/, 'chatStyles 应有 mediaName');
  // 助手表情包消息由 ChatScreen.buildAssistantReply 生成并覆盖 role:'assistant'
  const chat = read('src/ChatScreen.js');
  assert.match(chat, /return items\.map\(item => \(item\.kind === STICKER_MESSAGE_KIND \? \{ \.\.\.item, role: ASSISTANT_ID \} : item\)\)/, '助手表情包应覆盖 role 为 assistant');
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
