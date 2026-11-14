// 角色编辑草稿（桌面）：切走 / 关窗后回来能恢复未保存的编辑。
//
// 存储与「读即取走」语义都在共享层 src/storage/characters/index.js：
//   · saveCharacterEditDraft(id, formState, signature)  800ms 防抖写；
//   · takeCharacterEditDraft(id)                        读即取走（只弹一次恢复框）；
//   · clearCharacterEditDraft(id)                       不脏 / 保存成功后清。
// 抽成 hook 而不是留在编辑页：那边已到 800 行棘轮，且这段与「表单长什么样」无关——
// 它只关心「脏了没」与「角色 id」。
import { useCallback, useEffect, useRef } from 'react';

import {
  clearCharacterEditDraft,
  saveCharacterEditDraft,
  takeCharacterEditDraft,
} from '../../../src/storage/characters.js';
import { Alert } from '../platform/alert.js';

// 防抖时长与手机一致（CharacterDetailScreen 的 draftTimerRef 用 800ms）。
const DRAFT_DEBOUNCE_MS = 800;

export default function useDesktopCharacterDraft({
  characterId,
  form,
  dirty,
  baselineRef,
  onRestore,
  t,
}) {
  const draftTimerRef = useRef(null);
  const askedRef = useRef('');
  const onRestoreRef = useRef(onRestore);
  onRestoreRef.current = onRestore;

  // 恢复：每个角色只问一次。takeCharacterEditDraft 读即取走，同一份草稿不会重复弹。
  useEffect(() => {
    const id = String(characterId || '');
    if (!id || askedRef.current === id) return;
    askedRef.current = id;
    takeCharacterEditDraft(id)
      .then(draft => {
        if (!draft || !draft.formState) return;
        Alert.alert(
          t('character.detail.draftFound.title'),
          t('character.detail.draftFound.body'),
          [
            { text: t('character.detail.draftFound.discard'), style: 'destructive' },
            {
              text: t('character.detail.draftFound.restore'),
              onPress: () => {
                if (typeof onRestoreRef.current === 'function') onRestoreRef.current(draft.formState);
              },
            },
          ]
        );
      })
      .catch(() => {});
  }, [characterId, t]);

  // 暂存：脏表单防抖写一次；不脏就清（与手机同一判据）。
  useEffect(() => {
    const id = String(characterId || '');
    if (!id) return undefined;
    clearTimeout(draftTimerRef.current);
    draftTimerRef.current = null;
    if (!dirty) {
      clearCharacterEditDraft(id).catch(() => {});
      return undefined;
    }
    const formState = form;
    const signature = baselineRef && baselineRef.current ? baselineRef.current : '';
    draftTimerRef.current = setTimeout(() => {
      saveCharacterEditDraft(id, formState, signature).catch(() => {});
    }, DRAFT_DEBOUNCE_MS);
    return () => {
      clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    };
  }, [baselineRef, characterId, dirty, form]);

  // 保存成功后清草稿：否则下次进来会问「恢复吗」，而那份内容其实已落库。
  const clearDraft = useCallback(() => {
    const id = String(characterId || '');
    if (!id) return;
    clearCharacterEditDraft(id).catch(() => {});
  }, [characterId]);

  return { clearDraft };
}
