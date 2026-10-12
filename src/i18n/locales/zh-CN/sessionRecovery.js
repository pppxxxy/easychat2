// i18n 词条 · sessionRecovery 域（zh-CN 基准）。聚合入口见 ../zh-CN.js。
export const sessionRecovery = {
  // 面板名与「关闭」是两个语义，不能共用一个键（形态照 transcription.title +
  // transcription.closeA11y）。此前 title 被误写成关闭文案 ⇒ 面板标题显示成「关闭」。
  // 面板名沿用同一入口的既有措辞 memory.a11y.recover「恢复丢失的对话」。
  'sessionRecovery.title': '恢复丢失的对话',
  'sessionRecovery.closeA11y': '关闭',
  'sessionRecovery.back': '返回列表',
  // ⚠️ 下面 6 条曾**整块错位一格**（拆分前就存在，见 git show cbe0715^:src/i18n/locales/zh-CN.js）：
  // subtitleSingle 里是 noPreview 的文案、previewLabel 里是 meta 的格式、noPreview 里是
  // metaGroupSuffix 的文案、meta 里是 noCharacters.title、timeUnknown 里是 noCharacters.desc。
  // 使用点：SessionRecoveryModal.js:105-106（subtitle*）、:109（previewLabel，预览块上方的**标签**）、
  // :111/:163（noPreview，无预览时的回落）、:114/:168（meta + timeUnknown，消息条数与时间）。
  'sessionRecovery.subtitleGroup': '这段群聊有 {count} 位发言者，它原本属于哪个角色？选定后，它和它的记忆摘要都会回到列表里。',
  'sessionRecovery.subtitleSingle': '这段对话原本属于哪个角色？选定后，它和它的记忆摘要都会回到列表里。',
  'sessionRecovery.previewLabel': '消息预览',
  'sessionRecovery.noPreview': '（无预览）',
  'sessionRecovery.meta': '{count} 条消息 · {time}',
  'sessionRecovery.timeUnknown': '时间未知',
  'sessionRecovery.a11y.recoverTo': '恢复到 {name}',
  'sessionRecovery.unnamedCharacter': '未命名角色',
  'sessionRecovery.subtitleList': '这些对话的消息都还在，只是会话记录丢了（旧版本新建对话时误删）。点进任意一段，选它原本属于哪个角色即可找回。',
  'sessionRecovery.subtitleEmpty': '没有发现丢失的对话。',
  'sessionRecovery.a11y.pickSession': '选择这段对话',
  'sessionRecovery.metaGroup': ' · 疑似群聊',
  'sessionRecovery.metaGroupSuffix': ' · 疑似群聊（{count} 位）',
  'sessionRecovery.noCharacters.desc': '请先在角色页创建或导入角色。',
  'sessionRecovery.noCharacters.title': '没有可选角色',
  'sessionRecovery.recommended': '推荐',
};
