// 制卡工坊（桌面）：问答式生成角色卡 + 逐字段编辑 + 导入角色库。
//
// 复用共享层（全部纯 JS，无 react-native 依赖，已用静态依赖图核对过）：
//   · cardForge/forge/state.js —— FORGE_QUESTIONS 问题表、recordAnswer 状态推进；
//   · cardForge/forge/prompts.js —— buildGeneratePrompt（问答 → 一次生成的提示词）；
//   · cardForge/forge/draft.js —— createForgeDraft / projectForgeDraft / draftToCharacterPatch；
//   · cardForge/forge.js —— FORGE_SYSTEM / FORGE_SAMPLING_OVERRIDES / parseCardPatch；
//   · storage/cardForge.js —— getCardForge / saveCardForge（含读坏拒绝写守卫）。
//
// 与手机的差异只在交互载体：手机是多步向导 + 底部按钮；桌面把「问答」与「草稿编辑」
// 并排放在同一页，便于边答边改。生成与解析走同一条 applyGeneratedPatch 路径。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslation } from '../../../../src/i18n/I18nContext.js';
import {
  FORGE_SAMPLING_OVERRIDES,
  FORGE_SYSTEM,
  parseCardPatch,
} from '../../../../src/cardForge/forge.js';
import { createForgeDraft, draftToCharacterPatch } from '../../../../src/cardForge/forge/draft.js';
import { buildGeneratePrompt } from '../../../../src/cardForge/forge/prompts.js';
import {
  FORGE_QUESTIONS,
  createForgeState,
  currentQuestion,
  recordAnswer,
} from '../../../../src/cardForge/forge/state.js';
import { FORGE_FIELDS, FIELD_LABELS } from '../../../../src/cardForge/forge/shared.js';
import { buildJsonRepairPrompt } from '../../../../src/cardForge/forge/prompts.js';
import { mergeDraft } from '../../../../src/cardForge/forge/patch.js';
import { EMPTY_REPLY_TEXT, getConfigFingerprint, sendChatMessage } from '../../../../src/network/api.js';
import { getApiConfigs } from '../../../../src/storage/apiConfigs.js';
import { clearCardForge, getCardForge, saveCardForge } from '../../../../src/storage/cardForge.js';
import { useApp } from '../../../../src/context/AppContext.js';
import { Alert } from '../../platform/alert.js';
import { Button, Card, Field, Row, TextInput } from '../../settings/ui.jsx';

export default function CardForgeScreen({ palette, fonts }) {
  const { t } = useTranslation();
  const { addCharacter, ensureCharacterSession } = useApp();
  const [state, setState] = useState(createForgeState);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [freeDraft, setFreeDraft] = useState('');
  const abortRef = useRef(null);

  // 读回上次的草稿（含问答进度）。读失败时用全新状态，但**不**自动保存覆盖。
  useEffect(() => {
    let cancelled = false;
    getCardForge()
      .then(stored => { if (!cancelled && stored) setState(stored); })
      .catch(() => {})
      .then(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // 每次状态变化都落盘（制卡是长流程，关掉窗口不该丢几十道问答）。
  const persist = useCallback(async next => {
    try {
      await saveCardForge(next);
    } catch (error) {
      // 读坏守卫会抛错：此时不能假装保存成功，也不该清空界面。
      Alert.alert(t('forge.screen.alert.draftSaveFailed.title'), t('forge.screen.alert.draftSaveFailed.body'));
    }
  }, [t]);

  const update = useCallback(next => {
    setState(next);
    persist(next);
  }, [persist]);

  const question = currentQuestion(state);
  const draft = state.draft || createForgeDraft();

  // 调模型：问答 → 一次生成（共享层提示词），解析失败自动修复重试一次（与手机同一条链）。
  const generate = async () => {
    if (busy) return;
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const { configs, activeId } = await getApiConfigs();
      const current = configs.find(item => item.id === activeId) || configs[0];
      if (!current) throw new Error(t('forge.error.noModel'));
      const request = userPrompt => sendChatMessage([
        { role: 'system', content: FORGE_SYSTEM },
        { role: 'user', content: userPrompt },
      ], {
        stream: false,
        signal: controller.signal,
        expectedConfigId: String(current.id || ''),
        expectedConfigFingerprint: getConfigFingerprint(current),
        overrides: FORGE_SAMPLING_OVERRIDES,
      });
      const raw = await request(buildGeneratePrompt(state));
      if (!String(raw || '').trim() || raw === EMPTY_REPLY_TEXT) {
        throw new Error(t('forge.screen.error.emptyAiReply'));
      }
      let patch = parseCardPatch(raw);
      if (!patch) patch = parseCardPatch(await request(buildJsonRepairPrompt(raw)));
      if (!patch) throw new Error(t('forge.screen.note.generateNoJson'));
      // mergeDraft 是共享层的不可变合并（保留 systemPrompt / 世界书 / 正则等不改写字段）。
      update(mergeDraft(state, patch));
    } catch (error) {
      if (!error || error.name !== 'AbortError') {
        Alert.alert(t('forge.screen.alert.generateFailed.title'), String((error && error.message) || t('forge.screen.alert.retryLater')));
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  };

  const stop = () => {
    if (abortRef.current) abortRef.current.abort();
  };

  // 导入角色库：走共享层 draftToCharacterPatch，再交给 AppContext 建角色 + 建会话。
  const importToLibrary = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const patch = draftToCharacterPatch(draft);
      if (!String(patch.name || '').trim()) {
        Alert.alert(t('forge.screen.alert.cardEmpty.title'), t('forge.screen.alert.cardEmpty.body'));
        return;
      }
      const created = await addCharacter(patch);
      const id = created && created.id;
      if (id) await ensureCharacterSession(id).catch(() => {});
      Alert.alert(t('settings.api.saved.title'), t('forge.screen.note.imported', { name: String(patch.name || '') }));
    } catch (error) {
      Alert.alert(t('forge.screen.alert.forgeFailed.title'), String((error && error.message) || t('common.error.retryLater')));
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    Alert.alert(t('forge.screen.reset'), t('forge.screen.alert.draftResetNeeded.bodyEdit'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('forge.screen.reset'),
        style: 'destructive',
        onPress: async () => {
          try {
            await clearCardForge();
          } catch (error) {}
          const fresh = createForgeState();
          setState(fresh);
          setFreeDraft('');
        },
      },
    ]);
  };

  const answer = value => {
    if (!question) return;
    update(recordAnswer(state, question.id, value));
    setFreeDraft('');
  };

  const fieldLabel = useMemo(() => key => {
    const label = FIELD_LABELS[key];
    // FIELD_LABELS 是共享层自带的中文标签（不进 i18n，见该文件说明）；
    // 桌面直接用它，缺失时回落字段名。
    return label || key;
  }, []);

  // 进度用「第几步 / 共几题」+ 草稿摘要（共享层没有专门的进度词条，不新造）。
  const progressText = `${Math.min(state.step || 0, FORGE_QUESTIONS.length)} / ${FORGE_QUESTIONS.length}`;

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 16, minWidth: 0 }}>
      <Card title={t('ext.home.forge')} hint={t('forge.hint')} palette={palette} fonts={fonts}>
        {loading ? (
          <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('backup.progress.ratio')}</div>
        ) : (
          <>
            <div style={{ fontSize: fonts.scaled(11), color: palette.primaryMuted || palette.primary }}>
              {progressText}
            </div>
            {question ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: fonts.scaled(13), fontWeight: 700 }}>{question.prompt}</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {(question.options || []).filter(option => !option.free).map(option => (
                    <Button
                      key={option.id}
                      label={option.label}
                      onClick={() => answer(option.label)}
                      palette={palette}
                      fonts={fonts}
                    />
                  ))}
                </div>
                {question.freeHint ? (
                  <Row>
                    <div style={{ flex: 1, minWidth: 200 }}>
                      <TextInput
                        value={freeDraft}
                        onChange={setFreeDraft}
                        placeholder={question.freeHint}
                        palette={palette}
                        fonts={fonts}
                      />
                    </div>
                    <Button
                      label={t('common.save')}
                      onClick={() => { if (String(freeDraft).trim()) answer(String(freeDraft).trim()); }}
                      palette={palette}
                      fonts={fonts}
                      disabled={!String(freeDraft).trim()}
                    />
                  </Row>
                ) : null}
              </div>
            ) : (
              <div style={{ fontSize: fonts.scaled(12), color: palette.textMuted, lineHeight: 1.7 }}>
                {t('forge.screen.draftEmpty')}
              </div>
            )}
            <Row>
              <Button
                label={busy ? t('forge.screen.busy') : t('forge.screen.generate')}
                onClick={generate}
                palette={palette}
                fonts={fonts}
                primary
                disabled={busy}
              />
              {busy ? (
                <Button label={t('chat.running.stop')} onClick={stop} palette={palette} fonts={fonts} />
              ) : null}
              <Button label={t('forge.screen.import')} onClick={importToLibrary} palette={palette} fonts={fonts} disabled={busy} />
              <Button label={t('forge.screen.reset')} onClick={reset} palette={palette} fonts={fonts} disabled={busy} tone={palette.danger || '#ff5a5f'} />
            </Row>
          </>
        )}
      </Card>

      <Card title={t('forge.title')} hint={t('forge.hint')} palette={palette} fonts={fonts}>
        {FORGE_FIELDS.map(key => (
          <Field key={key} label={fieldLabel(key)} palette={palette} fonts={fonts}>
            <TextInput
              value={String(draft[key] || '')}
              onChange={value => update({ ...state, draft: { ...draft, [key]: value } })}
              palette={palette}
              fonts={fonts}
            />
          </Field>
        ))}
        <Field label={t('character.fields.tags.label')} palette={palette} fonts={fonts}>
          <TextInput
            value={(Array.isArray(draft.tags) ? draft.tags : []).join(t('character.library.group.nameJoin'))}
            onChange={value => update({
              ...state,
              draft: {
                ...draft,
                tags: String(value || '')
                  .split(/[,，、]/)
                  .map(item => item.trim())
                  .filter(Boolean),
              },
            })}
            placeholder={t('character.fields.tags.placeholder')}
            palette={palette}
            fonts={fonts}
          />
        </Field>
      </Card>
    </div>
  );
}