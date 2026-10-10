// 工作区设置的设置页编排（2026-10-07 快赢2 自 SettingsScreen 编排层迁出）。
// 模式切换走 patchWorkspaceSettings 局部更新——整体 save 会把 location /
// allowCommandExecution 归一化回默认值，表现为「切一下模式，刚选好的文件夹就没了」。

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { useTranslation } from '../i18n/I18nContext.js';
import { getWorkspaceSettings, patchWorkspaceSettings } from '../storage/workspace.js';
import { pickWorkspaceFolder } from '../workspace/picker.js';
import { resolveGitRunner } from '../workspace/native.js';

// characterId：沙盒是 root/<characterId>/，git 仓库要建在同一个沙盒里，所以初始化必须
// 用与工具执行时（ctx.characterId）一致的角色 id。缺省 'default' 与旧调用点行为一致。
export default function useWorkspaceSettings({ characterId = 'default' } = {}) {
  const { t } = useTranslation();
  const [workspaceMode, setWorkspaceMode] = useState('ask');
  const workspaceModeRef = useRef('ask');
  const [workspaceFolder, setWorkspaceFolder] = useState({ kind: 'app', uri: '', name: '' });
  const [commandExecution, setCommandExecution] = useState(false);
  const [pythonExecution, setPythonExecution] = useState(false);
  const [localGit, setLocalGit] = useState(false);
  const [workspaceFolderBusy, setWorkspaceFolderBusy] = useState(false);
  // 异步保存（选文件夹 / 命令开关）回来时组件可能已卸载，setState 前先查这个 ref。
  const settingsMountedRef = useRef(true);

  useEffect(() => {
    settingsMountedRef.current = true;
    return () => { settingsMountedRef.current = false; };
  }, []);

  useEffect(() => {
    getWorkspaceSettings()
      .then(settings => {
        workspaceModeRef.current = settings.mode;
        setWorkspaceMode(settings.mode);
        setWorkspaceFolder(settings.location);
        setCommandExecution(settings.allowCommandExecution);
        setPythonExecution(settings.allowPythonExecution);
        setLocalGit(settings.allowLocalGit);
      })
      .catch(() => {});
  }, []);

  const updateWorkspaceMode = useCallback(async mode => {
    workspaceModeRef.current = mode;
    setWorkspaceMode(mode);
    try {
      // 局部更新：整体 save 会把 location / 两个执行开关归一化回默认值，
      // 表现为「切一下模式，刚选好的文件夹和开关就没了」。
      const saved = await patchWorkspaceSettings({ mode });
      setCommandExecution(saved.allowCommandExecution);
      setPythonExecution(saved.allowPythonExecution);
    } catch (error) {
      Alert.alert(t('common.error.saveFailed'), t('common.error.storageOrPermission'));
    }
  }, []);

  // 选文件夹：系统选择器（SAF）已经带 takePersistableUriPermission，重启后仍有效。
  // 取消不是错误，不提示；失败才提示。
  const chooseWorkspaceFolder = useCallback(async () => {
    if (workspaceFolderBusy) return;
    setWorkspaceFolderBusy(true);
    try {
      const picked = await pickWorkspaceFolder();
      if (!picked) return;
      const saved = await patchWorkspaceSettings({ location: { kind: 'saf', uri: picked.uri, name: picked.name } });
      setWorkspaceFolder(saved.location);
      setCommandExecution(saved.allowCommandExecution);
      setPythonExecution(saved.allowPythonExecution);
    } catch (error) {
      Alert.alert(t('settings.workspace.folder.err.title'), (error && error.message) || t('settings.workspace.folder.err.body'));
    } finally {
      setWorkspaceFolderBusy(false);
    }
  }, [t, workspaceFolderBusy]);

  const resetWorkspaceFolder = useCallback(async () => {
    try {
      const saved = await patchWorkspaceSettings({ location: { kind: 'app', uri: '', name: '' } });
      setWorkspaceFolder(saved.location);
      setCommandExecution(saved.allowCommandExecution);
      setPythonExecution(saved.allowPythonExecution);
    } catch (error) {
      Alert.alert(t('common.error.saveFailed'), t('common.error.storageOrPermission'));
    }
  }, []);

  // 命令执行的开关放在确认弹框之后：这是「模型生成的命令会在手机里真的跑」的开关，
  // 不能一点就生效。
  const toggleCommandExecution = useCallback((value) => {
    if (!value) {
      patchWorkspaceSettings({ allowCommandExecution: false })
        .then(saved => {
          if (settingsMountedRef.current) setCommandExecution(saved.allowCommandExecution);
        })
        .catch(() => Alert.alert(t('common.error.saveFailed'), t('common.error.storageOrPermission')));
      return;
    }
    Alert.alert(
      t('settings.workspace.shell.confirm.title'),
      t('settings.workspace.shell.confirm.body'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('settings.workspace.shell.confirm.ok'),
          style: 'destructive',
          onPress: () => {
            patchWorkspaceSettings({ allowCommandExecution: true })
              .then(saved => {
                if (settingsMountedRef.current) setCommandExecution(saved.allowCommandExecution);
              })
              .catch(() => Alert.alert(t('common.error.saveFailed'), t('common.error.storageOrPermission')));
          },
        },
      ]
    );
  }, [t]);

  // 「允许模型运行 Python」的开关：同样放在确认弹框之后。两个执行开关**各自独立**——
  // 开一个不会顺手把另一个也打开，关一个也不影响另一个。
  const togglePythonExecution = useCallback((value) => {
    const save = next => patchWorkspaceSettings({ allowPythonExecution: next })
      .then(saved => {
        if (settingsMountedRef.current) setPythonExecution(saved.allowPythonExecution);
      })
      .catch(() => Alert.alert(t('common.error.saveFailed'), t('common.error.storageOrPermission')));
    if (!value) {
      save(false);
      return;
    }
    Alert.alert(
      t('settings.workspace.pythonExec.confirm.title'),
      t('settings.workspace.pythonExec.confirm.body'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('settings.workspace.pythonExec.confirm.ok'), style: 'destructive', onPress: () => save(true) },
      ]
    );
  }, [t]);

  // 本地版本控制开关（W7）。打开时**顺手把仓库建起来**：三个 git 只读工具不带副作用
  //（readOnly 不能被「顺手 init」破坏），所以初始化只能发生在这个用户显式动作里。
  // 初始化失败不翻开关——否则会留下「设置里显示已开启、工具却每次报没有仓库」的假状态。
  const toggleLocalGit = useCallback((value) => {
    const save = next => patchWorkspaceSettings({ allowLocalGit: next })
      .then(saved => {
        if (settingsMountedRef.current) setLocalGit(saved.allowLocalGit);
        return saved;
      })
      .catch(() => {
        Alert.alert(t('common.error.saveFailed'), t('common.error.storageOrPermission'));
        return null;
      });
    if (!value) {
      save(false);
      return;
    }
    Alert.alert(
      t('settings.workspace.localGit.confirm.title'),
      t('settings.workspace.localGit.confirm.body'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('settings.workspace.localGit.confirm.ok'),
          onPress: () => {
            save(true).then(saved => {
              if (!saved) return;
              const runner = resolveGitRunner(saved);
              if (!runner) return;
              runner.ensureRepo({ characterId }).catch(() => {
                Alert.alert(t('settings.workspace.localGit.initFailed.title'), t('settings.workspace.localGit.initFailed.body'));
              });
            });
          },
        },
      ]
    );
  }, [characterId, t]);

  return {
    workspaceMode,
    workspaceFolder,
    commandExecution,
    pythonExecution,
    localGit,
    workspaceFolderBusy,
    updateWorkspaceMode,
    chooseWorkspaceFolder,
    resetWorkspaceFolder,
    toggleCommandExecution,
    togglePythonExecution,
    toggleLocalGit,
  };
}
