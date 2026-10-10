// 工作区单屏（工作区唯一的一层 Modal）。
//
// 设计（v2 §0 三原则）：
//   1) 单屏原则：工作区只有一个屏幕，聊天区是主体，其余功能都是这块屏幕内的「面板」；
//   2) 左栏分组原则：左栏每个按钮 = 一个领域（对话 / 文件 / GitHub / 设置），点开一个面板；
//   3) 面板单开原则：任一时刻至多一个面板打开——全局弹窗嵌套从结构上根除。
//
// 此前是「设置页同时挂 WorkspaceChat 与 WorkspacePanel 两个平级 Modal，点链接再掀内部
// viewer」，三层 z 轴堆叠（用户截图 S3/S4 的原始诉求②）。现在设置页只挂这一个 Modal。
//
// 本阶段各领域面板复用既有组件（embedded 模式：不再各自套 Modal），后续阶段逐个替换为
// 专用面板并删除旧件（v2 Stage 2-5）；面板的二级层（预览/表单/目录下钻）都在面板内部，
// 不再出现跨面板的 Modal 叠 Modal。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../../theme/ThemeContext.js';
import { useTranslation } from '../../i18n/I18nContext.js';
import { getWorkspaceSettings } from '../../storage/workspace.js';
import { resolveWorkspaceAssistant } from '../assistant.js';
import { createWorkspaceStore } from '../native.js';
import ChatPanel from './ChatPanel.js';
import FilesPanel from './FilesPanel.js';
import GithubPanel from './GithubPanel.js';
import TerminalPanel from './TerminalPanel.js';
import WorkspaceSettingsPanel from './WorkspaceSettingsPanel.js';
import GitHistoryPanel from './GitHistoryPanel.js';

// 左栏领域键。顺序 = 使用频次：对话是主体，文件其次，GitHub / 终端再次，历史（W7 本地 git）
// 排在设置之前——它不属于「工具」，而是回看这几轮改了什么。设置始终最后。
const DOMAIN_KEYS = [
  { id: 'chat', icon: 'chatbubbles-outline', labelKey: 'workspace.screen.rail.chat' },
  { id: 'files', icon: 'folder-outline', labelKey: 'workspace.screen.rail.files' },
  { id: 'github', icon: 'logo-github', labelKey: 'workspace.screen.rail.github' },
  { id: 'terminal', icon: 'terminal-outline', labelKey: 'workspace.screen.rail.terminal' },
  { id: 'history', icon: 'time-outline', labelKey: 'workspace.screen.rail.history' },
  { id: 'settings', icon: 'settings-outline', labelKey: 'workspace.screen.rail.settings' },
];

export default function WorkspaceScreen({ visible, onClose }) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  const [panel, setPanel] = useState('chat');
  // 跨面板深链：聊天面板里的「导出/历史/环境配置」要直接落到文件面板的对应层
  //（文件面板的 initialSection 效应按 section 打开 docx 表单 / viewer / catalog）。
  const [filesSection, setFilesSection] = useState('');
  // 跨面板交接：GitHub 工作台的「让助手推送」把一条指令填进对话面板的输入框。
  const [draft, setDraft] = useState(null);
  // 工作区上下文：解析出的角色 + 沙盒 store。GitHub 面板与设置面板要用它们，
  // 由屏幕统一持有，避免每个面板各建一份（对话/文件面板仍是自包含的，见各自实现）。
  const [characterId, setCharacterId] = useState('default');
  const storeRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // 关闭时回到默认面板，下次进来是聊天。
  useEffect(() => {
    if (visible) return;
    setPanel('chat');
  }, [visible]);

  useEffect(() => {
    if (!visible) return undefined;
    let alive = true;
    (async () => {
      try {
        const settings = await getWorkspaceSettings();
        if (!alive) return;
        try {
          storeRef.current = createWorkspaceStore(settings);
        } catch (error) {
          storeRef.current = null;
        }
        const resolved = await resolveWorkspaceAssistant(settings.assistantCharacterId);
        if (alive && resolved && resolved.id) setCharacterId(resolved.id);
      } catch (error) {}
    })();
    return () => { alive = false; };
  }, [visible]);

  const openFiles = useCallback(section => {
    setFilesSection(String(section || ''));
    setPanel('files');
  }, []);
  const backToChat = useCallback(() => setPanel('chat'), []);
  // 交接：切到对话面板并把指令交给它填进输入框（token 让同一段文本也能重复交接）。
  const handoffToChat = useCallback(text => {
    setDraft({ text: String(text || ''), token: Date.now() });
    setPanel('chat');
  }, []);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.topBar}>
          <Text style={styles.title}>{t('workspace.home.title')}</Text>
          <TouchableOpacity
            style={styles.exitButton}
            onPress={onClose}
            hitSlop={8}
            accessibilityLabel={t('workspace.home.exit')}
          >
            <Ionicons name="close" size={22} color={theme.colors.text} />
          </TouchableOpacity>
        </View>

        <View style={styles.mainRow}>
          {/* 领域排到六个，窄屏或大字号下可能超高——rail 自己滚，不裁掉最后一项。 */}
          <ScrollView
            style={styles.rail}
            contentContainerStyle={styles.railContent}
            showsVerticalScrollIndicator={false}
          >
            {DOMAIN_KEYS.map(item => {
              const active = panel === item.id;
              return (
                <TouchableOpacity
                  key={item.id}
                  style={[styles.railItem, active && styles.railItemActive]}
                  onPress={() => setPanel(item.id)}
                  activeOpacity={0.8}
                  accessibilityLabel={t(item.labelKey)}
                >
                  <Ionicons
                    name={item.icon}
                    size={21}
                    color={active ? theme.colors.primary : theme.colors.primarySoft}
                  />
                  <Text style={[styles.railLabel, active && styles.railLabelActive]} numberOfLines={2}>
                    {t(item.labelKey)}
                  </Text>
                </TouchableOpacity>
              );
            })}
            {/* 弹性留白：领域已排满（六个），窄屏上靠 rail 自身滚动，不再往内容区挤。 */}
            <View style={styles.railSpacer} />
          </ScrollView>

          <View style={styles.content}>
            {panel === 'chat' ? (
              <ChatPanel
                visible={visible}
                onClose={onClose}
                draft={draft}
                onOpenPanel={openFiles}
              />
            ) : null}
            {panel === 'files' ? (
              <FilesPanel
                visible={visible}
                embedded
                initialSection={filesSection}
                onClose={backToChat}
                onOpenHistory={() => setPanel('history')}
              />
            ) : null}
            {panel === 'github' ? (
              <GithubPanel characterId={characterId} storeRef={storeRef} onHandoff={handoffToChat} />
            ) : null}
            {panel === 'terminal' ? (
              <TerminalPanel characterId={characterId} />
            ) : null}
            {panel === 'history' ? (
              <GitHistoryPanel characterId={characterId} />
            ) : null}
            {panel === 'settings' ? (
              <WorkspaceSettingsPanel characterId={characterId} onClose={backToChat} />
            ) : null}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background, paddingTop: 44 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingBottom: 8,
    borderBottomWidth: tokens.border.thin,
    borderBottomColor: theme.colors.divider,
  },
  title: { color: theme.colors.text, fontSize: fonts.scaled(16), fontWeight: '800' },
  exitButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
  },
  mainRow: { flex: 1, flexDirection: 'row' },
  rail: {
    width: 76,
    paddingTop: 10,
    paddingHorizontal: 6,
    borderRightWidth: tokens.border.thin,
    borderRightColor: theme.colors.divider,
    backgroundColor: theme.colors.surfaceAlt,
  },
  railItem: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: tokens.radius.md,
    marginBottom: 6,
  },
  railItemActive: { backgroundColor: theme.colors.surface },
  railLabel: {
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(10),
    lineHeight: fonts.scaled(14),
    textAlign: 'center',
    marginTop: 4,
  },
  railLabelActive: { color: theme.colors.primary, fontWeight: '700' },
  railContent: { paddingBottom: 12 },
  railSpacer: { flex: 1 },
  content: { flex: 1 },
});
