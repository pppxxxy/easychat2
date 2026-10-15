// FEAT-AC1 / FEAT-AC2 / FEAT-AC4：把「工具 → 宿主」的四个注入点一次接上。
//
// 为什么集中在一个 startup 模块（而不是继续堆在 App.js）：
//  · App.js 是装配根、贴着 800 行棘轮——每加一处接线都在逼近上限；
//  · 这四个 recorder 是同一类东西（工具层向内核留痕/刷快照），放一起便于对照与审计。
//
// 为什么用**注入**而不是让工具直接 import 内核：诊断 / overlayConfig 都依赖
// RN/expo，工具文件的定义要经 tools.js 索引层聚合（14 个测试 import 那个索引层），
// 静态引用会把纯 Node 单测整批拖崩。
//
// ⚠️ 缺一不可：此前只接了 setOverlaySnapshotRefresher / setMusicToolRecorder，
// 而 setSettingChangeRecorder（AC1 设置变更留痕）与 setReminderRecorder（AC4 提醒打点）
// **从未被宿主注入** → 生产里静默 no-op。本模块把四个补齐。

import { recordDiagnostic } from '../storage/diagnostics.js';
import { writeOverlayConfigSnapshot } from '../screenWatch/overlayConfig.js';
import {
  setOverlaySnapshotRefresher,
  setSettingChangeRecorder,
} from '../workspace/toolDefs/appSettingsTools.js';
import { setMusicToolRecorder } from '../workspace/toolDefs/musicTools.js';
import { setReminderRecorder } from '../workspace/toolDefs/reminderTools.js';

/**
 * 安装四个 recorder。
 *
 * @param {() => object|null} getCharacter 取「当前角色」的取值器（悬浮窗配置快照要用）。
 *   用取值器而不是直接传角色：注册点只有一个，闭包每次取**当时**的角色，
 *   不必因角色切换反复注册。
 * @returns {() => void} 卸载函数（把四个注入点还原为缺省 no-op）。
 */
export function installWorkspaceRecorders(getCharacter) {
  const readCharacter = typeof getCharacter === 'function' ? getCharacter : () => null;

  // 1) 设置变更后刷新悬浮窗配置快照（否则「设置开了、悬浮窗不响」）。
  setOverlaySnapshotRefresher(() => writeOverlayConfigSnapshot({ character: readCharacter() }));

  // 2) 音乐工具调用留痕（成功路径，非错误——传 { message } 不带堆栈）。
  setMusicToolRecorder({
    noteMusicTool(action, target) {
      recordDiagnostic('log', { message: `[music-tool] action=${action} target=${target || 'none'}` }, 'music');
    },
  });

  // 3) 设置变更留痕（key + 旧值→新值）。
  setSettingChangeRecorder({
    noteSettingChanged(key, oldValue, newValue) {
      recordDiagnostic('log', { message: `[app-setting] ${key} ${oldValue}->${newValue}` }, 'settings');
    },
  });

  // 4) 提醒打点（set / cancel）。
  setReminderRecorder({
    noteReminder(action, detail) {
      recordDiagnostic('log', { message: `[reminder] ${action} ${detail || 'none'}` }, 'reminder');
    },
  });

  return () => {
    setOverlaySnapshotRefresher(null);
    setMusicToolRecorder(null);
    setSettingChangeRecorder(null);
    setReminderRecorder(null);
  };
}