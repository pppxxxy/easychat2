# 需求实施计划：语音消息

## 阶段 A：录音与音频落盘

- [ ] A1. `app.json` 从 `blockedPermissions` 移除 `RECORD_AUDIO`，补 `expo-av` 麦克风权限文案（需求 7.1）
- [ ] A2. `src/storage/sessions.js` 新增 `collectVoiceFiles()`，并入删除会话的清理链路（需求 2.3、2.4）
- [ ] A3. `src/chat/useChatRecorder.js`：录制生命周期 + 权限 + 时长上下限 + 进行中反馈（需求 1.1、1.2、1.5、1.6）
- [ ] A4. 录音结束把文件落盘到 `documentDirectory/voice/` 并产出 `{ uri, durationMs, mime }`（需求 2.3）

## 阶段 B：转写（先复用、失败补配、再占位）

- [ ] B1. `src/transcription.js`：`normalizeTranscriptionConfig` / `resolveTranscription` / `transcribeAudio` / `isUnsupportedTranscriptionError`（需求 3.1、3.2、3.3、3.4）
- [ ] B2. `src/storage/settings.js` 新增 `getTranscriptionSettings` / `saveTranscriptionSettings`，键 `@easychat2_transcription`，密钥走保险箱（需求 4.1、4.4、4.5）
- [ ] B3. `src/SettingsScreen.js` 新增「语音转文字」配置卡：选择/新增/删除/编辑 + 默认「仅复用当前聊天来源」（需求 4.2、4.3、4.5）
- [ ] B4. `ChatScreen` 发送流程接入转写回退顺序，并缓存「来源是否支持转写」判定（需求 3.4、3.5）
- [ ] B5. 功能说明文案明确「转写会上传音频到所选服务商」（需求 3.6）

## 阶段 C：语音消息展示与回放

- [ ] C1. `src/voiceMessages.js`：`VOICE_MESSAGE_KIND` / `createVoiceMessage` / `getVoicePromptText` / `isVoiceMessage`（需求 2.1）
- [ ] C2. `src/chatPipeline.js` 对 voice 消息使用 `getVoicePromptText` 投影上下文（需求 3.4）
- [ ] C3. `src/chat/VoiceBubble.js`：时长 + 播放控件 + 错误态，`MessageBubble` 接入（需求 2.1、2.2、2.5）
- [ ] C4. 音频缺失/损坏时提示 `语音不可用`，不阻断聊天（需求 2.5）

## 阶段 D：模型能力标记

- [ ] D1. `src/storage/apiConfigs.js` 新增 `supportsAudio`（需求 6.1）
- [ ] D2. `src/api.js` 把 `supportsAudio` 纳入 `getConfigFingerprint`（需求 6.3）
- [ ] D3. 设置页「确认模型能力」弹窗新增「支持语音识别」开关（需求 6.1、6.2）

## 阶段 E：角色卡语音形态

- [ ] E1. `src/storage/characters.js` 新增 `voiceDisplay` 字段，默认 `'text'`（需求 5.1、5.2）
- [ ] E2. `src/CharacterEditForm.js` 新增语音形态选择（需求 5.1）
- [ ] E3. `src/chat/useChatTts.js` 按 `voiceDisplay` 决定自动合成与展示（需求 5.3、5.4）
- [ ] E4. `'voice'` 模式隐藏正文但保留入库与上下文；TTS 失败降级仅文字（需求 5.4、5.5）

## 阶段 F：检查点 - 确保所有可运行验证通过

- [ ] F1. `npm run lint` 无输出
- [ ] F2. `npm test` 全绿（新增转写/投影/回收测试）
- [ ] F3. `npm run test:coverage` 不低于地板

## 阶段 G：回归与文档

- [ ] G1. `npx expo export --platform android` 通过
- [ ] G2. `SMOKE_TEST.md` 增加语音消息走查项（录音→转写→发送、补配引导、三档语音形态、回放、删除回收）
- [ ] G3. 同步 `.monkeycode/docs/`（INTERFACES.md、数据与状态.md、界面层.md）
- [ ] G4. 明确不在本次范围：端侧转写、WebRTC 通话、历史音频回传
