// 从对话生成角色卡（桌面）：把当前会话的对话记录交给模型，提炼成一张角色卡。
//
// 对应手机 chat/ConversationCardModal 的**生成**部分；结果直接写进制卡草稿
//（storage/cardForge 的 saveCardForge），用户可以在制卡页查看/修改/导入角色库。
//
// 全部复用共享层：
//   · formatConversationTranscript —— 截断口径（总字数 + 单条字数）与手机一致；
//   · buildConversationCardPrompt —— 提炼要求与输出规则；
//   · parseCardPatch —— 解析模型返回的 JSON（失败自动修复重试一次，与制卡页同链）。
import { useState } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { parseCardPatch, FORGE_SAMPLING_OVERRIDES, FORGE_SYSTEM } from '../../../src/cardForge/forge.js';
import {
  buildConversationCardPrompt,
  formatConversationTranscript,
} from '../../../src/cardForge/forge/conversation.js';
import { buildJsonRepairPrompt } from '../../../src/cardForge/forge/prompts.js';
import { mergeDraft } from '../../../src/cardForge/forge/patch.js';
import { createForgeState } from '../../../src/cardForge/forge/state.js';
import { getCardForge, saveCardForge } from '../../../src/storage/cardForge.js';
import { getConfigFingerprint, sendChatMessage, EMPTY_REPLY_TEXT } from '../../../src/network/api.js';
import { getApiConfigs } from '../../../src/storage/apiConfigs.js';
import { Button, Card, Field, Row, TextInput } from '../settings/ui.jsx';
import { Alert } from '../platform/alert.js';

export default function ConversationCardPanel({ messages, characterName, userName, palette, fonts, onGenerated }) {
  const { t } = useTranslation();
  const [hint, setHint] = useState('');
  const [busy, setBusy] = useState(false);

  const generate = async () => {
    if (busy) return;
    const list = Array.isArray(messages) ? messages : [];
    if (list.length === 0) {
      Alert.alert(t('chat.export.empty'), t('chat.export.empty'));
      return;
    }
    setBusy(true);
    try {
      const transcript = formatConversationTranscript(list, { characterName, userName });
      const prompt = buildConversationCardPrompt({
        transcript: transcript.text,
        characterName,
        userName,
        hint,
        dropped: transcript.dropped || 0,
      });
      const { configs, activeId } = await getApiConfigs();
      const current = configs.find(item => item.id === activeId) || configs[0];
      if (!current) throw new Error(t('forge.error.noModel'));
      const request = userPrompt => sendChatMessage([
        { role: 'system', content: FORGE_SYSTEM },
        { role: 'user', content: userPrompt },
      ], {
        stream: false,
        expectedConfigId: String(current.id || ''),
        expectedConfigFingerprint: getConfigFingerprint(current),
        overrides: FORGE_SAMPLING_OVERRIDES,
      });
      const raw = await request(prompt);
      if (!String(raw || '').trim() || raw === EMPTY_REPLY_TEXT) {
        throw new Error(t('forge.screen.error.emptyAiReply'));
      }
      let patch = parseCardPatch(raw);
      // 解析失败多为 JSON 被截断/含非法转义：回传片段自修复重试一次。
      if (!patch) patch = parseCardPatch(await request(buildJsonRepairPrompt(raw)));
      if (!patch) throw new Error(t('forge.screen.note.generateNoJson'));

      // 写回制卡草稿：保留既有 state 里的问答与「原样保留字段」，只合并新卡内容。
      const existing = await getCardForge().catch(() => null);
      const baseState = existing || createForgeState();
      const next = mergeDraft(baseState, patch);
      await saveCardForge(next);
      Alert.alert(t('settings.api.saved.title'), t('forge.screen.note.generated', { fields: Object.keys(patch).join(', ') }));
      setHint('');
      if (typeof onGenerated === 'function') onGenerated(next);
    } catch (error) {
      Alert.alert(
        t('forge.screen.alert.generateFailed.title'),
        String((error && error.message) || t('forge.screen.alert.retryLater'))
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={t('desktop.conversationCard.title')}
      hint={t('desktop.conversationCard.hint')}
      palette={palette}
      fonts={fonts}
    >
      <Field label={t('forge.alert.describeFirst.body')} palette={palette} fonts={fonts}>
        <TextInput
          value={hint}
          onChange={setHint}
          placeholder={t('forge.alert.describeFirst.body')}
          palette={palette}
          fonts={fonts}
        />
      </Field>
      <Row>
        <Button
          label={busy ? t('forge.screen.busy') : t('desktop.conversationCard.generate')}
          onClick={generate}
          palette={palette}
          fonts={fonts}
          primary
          disabled={busy}
        />
      </Row>
    </Card>
  );
}
