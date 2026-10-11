// 「删除全部角色」的确认流程（从 CharacterLibraryScreen 抽出：屏幕是行数棘轮文件）。
//
// iOS 用 Alert.prompt 输入「删除」二字确认；Android 没有 Alert.prompt，退化为二段确认
// （不可逆操作仍要二次确认），否则删除全部角色在 Android 上永远走「不支持」分支、功能不可达。
//
// t 由调用方注入（与屏幕共用同一 i18n 实例）；onConfirm 在确认后执行。

import { Alert } from 'react-native';

export function confirmDeleteAll({ t, onConfirm }) {
  if (!Alert.prompt) {
    Alert.alert(t('character.library.deleteAll.title'), t('character.library.deleteAll.body'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('character.library.deleteAll.confirm'), style: 'destructive', onPress: onConfirm },
    ]);
    return;
  }
  Alert.prompt(t('character.library.prompt.title'), t('character.library.prompt.body'), value => {
    // 确认词固定为「删除」二字，不随界面语言变化。
    if (String(value || '').trim() === '删除') onConfirm();
    else Alert.alert(t('character.library.prompt.mismatch.title'), t('character.library.prompt.mismatch.body'));
  });
}
