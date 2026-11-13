// 制卡辅助（桌面）：单字段 AI 改写 + 模拟对话预览。
//
// 对应手机 CardForgeEditor 的「辅助生成」与 CardPreviewModal 的「模拟对话」。两者都
// 复用共享层，不重写任何提示词或解析：
//   · 字段辅助：buildFieldAssistPrompt → useForgeRequests.sendAssistPrompt → parseFieldAssistText；
//   · 模拟对话：draftToCharacterPatch + buildRequestMessages 走 useForgeRequests.simulateChat
//     （真实聊天管道，不写会话、不落草稿、不影响角色库——与手机同一条纪律）。
//
// 桌面没有本地模型，但 useForgeRequests 会自然落到在线配置，不受影响。
import { useState } from 'react';

import { useTranslation } from '../../../../src/i18n/I18nContext.js';
import {
  buildFieldAssistPrompt,
  parseFieldAssistText,
} from '../../../../src/cardForge/forge/assist.js';
import useForgeRequests from '../../../../src/cardForge/useForgeRequests.js';
import { buildPreviewOpeningTurns, buildPreviewDisplayTurns } from '../../../../src/cardForge/preview.js';
import { Button, Card, Row, TextInput } from '../../settings/ui.jsx';
import { Alert } from '../../platform/alert.js';

const MAX_TURNS = 8;

// 单字段辅助：输入「想怎么改」，模型返回改写后的字段正文。
export function FieldAssistBox({ fieldLabel, currentValue, palette, fonts, onApply }) {
  const { t } = useTranslation();
  const requests = useForgeRequests(t);
  const [request, setRequest] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async () => {
    const instruction = String(request || '').trim();
    if (!instruction || busy) return;
    setBusy(true);
    try {
      const prompt = buildFieldAssistPrompt({
        fieldLabel,
        currentValue: String(currentValue || ''),
        request: instruction,
      });
      const raw = await requests.sendAssistPrompt(prompt);
      const text = parseFieldAssistText(raw);
      if (!text) throw new Error(t('forge.screen.error.emptyAiReply'));
      onApply(text);
      setRequest('');
    } catch (error) {
      // 空回复/解析失败都要明确提示：静默写空会把字段内容清掉。
      Alert.alert(
        t('forge.alert.generateFailed.title'),
        String((error && error.message) || t('forge.alert.generateFailed.bodyRetry'))
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <div style={{ flex: 1, minWidth: 120 }}>
        <TextInput
          value={request}
          onChange={setRequest}
          placeholder={t('forge.alert.describeFirst.body')}
          palette={palette}
          fonts={fonts}
        />
      </div>
      <Button
        label={busy ? t('backup.progress.ratio') : t('forge.assist.button')}
        onClick={run}
        palette={palette}
        fonts={fonts}
        disabled={busy || !String(request || '').trim()}
      />
    </div>
  );
}

// 模拟对话：用当前草稿的设定真实扮演，只读展示，不写任何存储。
export function ForgeSimulationPanel({ draft, palette, fonts }) {
  const { t } = useTranslation();
  const requests = useForgeRequests(t);
  const [input, setInput] = useState('');
  const [turns, setTurns] = useState(() => buildPreviewDisplayTurns(
    buildPreviewOpeningTurns(draft),
    draft
  ));
  const [busy, setBusy] = useState(false);

  const send = async () => {
    const text = String(input || '').trim();
    if (!text || busy) return;
    setBusy(true);
    const nextTurn = { id: `sim-user-${Date.now()}`, role: 'user', text };
    const history = turns.slice(-MAX_TURNS).map(turn => ({ role: turn.role, text: turn.text }));
    setTurns(current => [...current, nextTurn]);
    setInput('');
    try {
      const reply = await requests.simulateChat({
        draft,
        historyMessages: history,
        userText: text,
      });
      // 显示层与手机同口径：走 applyRegexScripts 的 display 通道
      //（这样卡里的正则脚本在预览里也能看到效果）。
      const displayTurns = buildPreviewDisplayTurns(
        [{ id: `sim-reply-${Date.now()}`, role: 'assistant', text: String(reply || '') }],
        draft
      );
      setTurns(current => [...current, ...displayTurns]);
    } catch (error) {
      Alert.alert(
        t('forge.preview.alert.failed.title'),
        String((error && error.message) || t('forge.preview.alert.failed.body'))
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={t('forge.preview.chatTitle')}
      hint={t('forge.preview.chatHint')}
      palette={palette}
      fonts={fonts}
    >
      {turns.length === 0 ? (
        <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>
          {t('forge.preview.noOpening')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 260, overflow: 'auto' }}>
          {turns.map(turn => (
            <div
              key={turn.id}
              style={{
                fontSize: fonts.scaled(12),
                lineHeight: 1.65,
                color: turn.role === 'user' ? palette.text : palette.textMuted,
                borderLeft: `2px solid ${turn.role === 'user' ? (palette.primaryMuted || palette.primary) : palette.divider}`,
                paddingLeft: 8,
                whiteSpace: 'pre-wrap',
              }}
            >
              {String(turn.text || '')}
            </div>
          ))}
        </div>
      )}
      <Row>
        <div style={{ flex: 1, minWidth: 160 }}>
          <TextInput
            value={input}
            onChange={setInput}
            placeholder={t('forge.preview.inputPlaceholder')}
            palette={palette}
            fonts={fonts}
          />
        </div>
        <Button
          label={busy ? t('forge.preview.typing') : t('forge.preview.send')}
          onClick={send}
          palette={palette}
          fonts={fonts}
          primary
          disabled={busy || !String(input || '').trim()}
        />
        <Button
          label={t('forge.preview.clear')}
          onClick={() => setTurns([])}
          palette={palette}
          fonts={fonts}
        />
      </Row>
    </Card>
  );
}