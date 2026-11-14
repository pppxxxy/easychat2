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
import { buildGeneratePrompt, buildImageCardPrompt } from '../../../../src/cardForge/forge/prompts.js';
import { readImageDataUri } from '../../../../src/chat/attachments.js';
import { capabilitiesForModel, getActiveModel } from '../../../../src/storage/apiConfigs.js';
import { markMediaWrite } from '../../../../src/storage/mediaProtection.js';
import { getBridge } from '../../platform/bridge.js';
import { documentDirectory } from '../../platform/fileSystem.js';
import { mediaUrl } from '../../platform/mediaUrl.js';
import {
  FORGE_QUESTIONS,
  createForgeState,
  currentQuestion,
  recordAnswer,
} from '../../../../src/cardForge/forge/state.js';
import { FORGE_FIELDS, FIELD_LABELS } from '../../../../src/cardForge/forge/shared.js';
import ForgeAdvancedPanels from './ForgeAdvancedPanels.jsx';
import { buildJsonRepairPrompt } from '../../../../src/cardForge/forge/prompts.js';
import { mergeDraft } from '../../../../src/cardForge/forge/patch.js';
import { EMPTY_REPLY_TEXT, getConfigFingerprint, sendChatMessage } from '../../../../src/network/api.js';
import { getApiConfigs } from '../../../../src/storage/apiConfigs.js';
import { clearCardForge, getCardForge, saveCardForge } from '../../../../src/storage/cardForge.js';
import { useApp } from '../../../../src/context/AppContext.js';
import { Alert } from '../../platform/alert.js';
import { Button, Card, Field, Row, TextInput } from '../../settings/ui.jsx';
import { FieldAssistBox, ForgeSimulationPanel } from './forgeAssist.jsx';

export default function CardForgeScreen({ palette, fonts }) {
  const { t } = useTranslation();
  const { addCharacter, ensureCharacterSession } = useApp();
  const [state, setState] = useState(createForgeState);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [freeDraft, setFreeDraft] = useState('');
  // 按图片生成：参考图 + 补充要求（与手机同一条链路，只是选图走 media.pick）。
  const [referenceUri, setReferenceUri] = useState('');
  const [imageHint, setImageHint] = useState('');
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

  // 「按图片生成角色」：把所选图片作为识图输入发给当前模型，读图后写回整卡文本字段。
  // 与手机同一判定：先看**当前模型**是否 declared supportsVision，没有就明确拒绝
  //（不要退化成「发纯文字」，那会让用户以为模型读了图）。
  const imageToCard = async () => {
    if (busy) return;
    if (!referenceUri) {
      Alert.alert(t('forge.alert.pickImageFirst.title'), t('forge.alert.pickImageFirst.bodyAvatar'));
      return;
    }
    setBusy(true);
    try {
      const { configs, activeId } = await getApiConfigs();
      const current = configs.find(item => item.id === activeId) || configs[0];
      if (!current) throw new Error(t('forge.error.noModel'));
      const vision = capabilitiesForModel(current, getActiveModel(current)).supportsVision === true;
      if (!vision) throw new Error(t('forge.screen.error.visionUnsupported'));

      const dataUri = await readImageDataUri(referenceUri);
      if (!dataUri) throw new Error(t('forge.screen.error.readImageFailed'));
      const prompt = buildImageCardPrompt({ hint: imageHint, hasAvatar: true, hasBg: false });
      const raw = await sendChatMessage([
        { role: 'system', content: FORGE_SYSTEM },
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: dataUri } },
          ],
        },
      ], {
        stream: false,
        expectedConfigId: String(current.id || ''),
        expectedConfigFingerprint: getConfigFingerprint(current),
        overrides: FORGE_SAMPLING_OVERRIDES,
      });
      if (!String(raw || '').trim() || raw === EMPTY_REPLY_TEXT) {
        throw new Error(t('forge.screen.error.emptyAiReply'));
      }
      const patch = parseCardPatch(raw);
      if (!patch) throw new Error(t('forge.screen.note.generateNoJson'));
      // 只合并文本字段：世界书/正则/预设等集合保持草稿原样（与手机同口径）。
      update(mergeDraft(state, patch));
      Alert.alert(t('settings.api.saved.title'), t('forge.screen.note.generated', { fields: Object.keys(patch).join(', ') }));
    } catch (error) {
      Alert.alert(
        t('forge.screen.alert.generateFailed.title'),
        String((error && error.message) || t('forge.screen.alert.retryLater'))
      );
    } finally {
      setBusy(false);
    }
  };

  // 选图：复制到 documents/card-forge/ 并登记媒体保护（备份导出不会把它当孤儿清掉）。
  const pickReference = async () => {
    const picked = await getBridge().media.pick('image');
    const item = picked && !picked.canceled && Array.isArray(picked.items) ? picked.items[0] : null;
    if (!item) return;
    const ext = (String(item.uri || '').split('.').pop() || 'png').slice(0, 5);
    const destination = `${documentDirectory}card-forge/ref-${Date.now()}.${ext}`;
    try {
      await getBridge().fs.copy(item.uri, destination);
      markMediaWrite(destination);
      setReferenceUri(destination);
    } catch (error) {
      Alert.alert(t('forge.alert.readImageFailed.title'), t('forge.alert.readImageFailed.body'));
    } finally {
      getBridge().fs.delete(item.uri, true).catch(() => {});
    }
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

      <Card title={t('forge.imageCard.title')} hint={t('forge.imageCard.hint')} palette={palette} fonts={fonts}>
        <Row>
          <Button label={t('forge.imageCard.pick')} onClick={pickReference} palette={palette} fonts={fonts} disabled={busy} />
          {referenceUri ? (
            <>
              <img
                src={mediaUrl(referenceUri) || ''}
                alt=""
                style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 8, border: `1px solid ${palette.divider}` }}
              />
              <Button
                label={t('character.fields.image.clear')}
                onClick={() => setReferenceUri('')}
                palette={palette}
                fonts={fonts}
                disabled={busy}
              />
            </>
          ) : null}
        </Row>
        <Field label={t('forge.alert.describeFirst.body')} palette={palette} fonts={fonts}>
          <TextInput
            value={imageHint}
            onChange={setImageHint}
            placeholder={t('forge.alert.describeFirst.body')}
            palette={palette}
            fonts={fonts}
          />
        </Field>
        <Row>
          <Button
            label={busy ? t('forge.screen.busy') : t('forge.imageCard.generate')}
            onClick={imageToCard}
            palette={palette}
            fonts={fonts}
            primary
            disabled={busy || !referenceUri}
          />
          <span style={{ fontSize: fonts.scaled(10), color: palette.textFaint, lineHeight: 1.6 }}>
            {t('forge.screen.error.visionUnsupported')}
          </span>
        </Row>
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
            {/* 辅助生成：按用户描述让模型改写这一个字段（共享层提示词与解析）。 */}
            <FieldAssistBox
              fieldLabel={fieldLabel(key)}
              currentValue={String(draft[key] || '')}
              palette={palette}
              fonts={fonts}
              onApply={value => update({ ...state, draft: { ...draft, [key]: value } })}
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
        {/* systemPrompt / 世界书 / 正则 / 预设：此前整块缺失，生成或导入出来的
            高级内容用户看不到也改不了。 */}
        <ForgeAdvancedPanels
          draft={draft}
          onChange={next => update({ ...state, draft: next })}
          palette={palette}
          fonts={fonts}
        />
      </Card>
      <ForgeSimulationPanel draft={draft} palette={palette} fonts={fonts} />
    </div>
  );
}