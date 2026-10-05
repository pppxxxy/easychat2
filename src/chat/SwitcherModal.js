// 角色/群聊切换弹窗。从 src/ChatScreen.js 原样外提（无行为变化）。
// 2026-10-06 行组件统一：行渲染改走 SessionRow（与记忆页/搜索结果同一套视觉），
// 群聊行顺带补出预览与相对时间（数据本就在 session 对象上，此前没显示）。
// 注意：这是「角色/群聊」切换器，不是会话切换器——角色行没有会话预览可显示。

import React, { useMemo } from 'react';
import { Modal, ScrollView, Text, TouchableOpacity } from 'react-native';

import SessionRow, { SessionAvatar, formatSessionTime } from '../memory/SessionRow.js';
import { useTheme } from '../theme/ThemeContext.js';
import { createChatStyles } from './chatStyles.js';

export default function SwitcherModal({
  visible,
  onClose,
  characters,
  isGroup,
  activeId,
  onSwitch,
  groupSessions,
  activeSessionId,
  onSwitchGroup,
  groupSessionName,
}) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createChatStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  // 群聊三叠头像需要成员角色资料：characters 是全量角色表，现场建索引。
  const characterMap = useMemo(() => {
    const map = new Map();
    (Array.isArray(characters) ? characters : []).forEach(item => {
      map.set(item.id, item);
    });
    return map;
  }, [characters]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <TouchableOpacity
        style={styles.modalBackdrop}
        activeOpacity={1}
        onPress={onClose}
      >
        <TouchableOpacity style={styles.modalSheet} activeOpacity={1} onPress={() => {}}>
          <Text style={styles.modalTitle}>选择角色或群聊</Text>
          <ScrollView style={styles.modalList} keyboardShouldPersistTaps="handled">
            {characters.map(item => (
              <SessionRow
                key={item.id}
                mode="switch"
                avatar={<SessionAvatar uri={item.avatarUri || ''} name={item.name || ''} size={36} />}
                name={item.name || '未命名角色'}
                active={!isGroup && item.id === activeId}
                onPress={() => onSwitch(item.id)}
              />
            ))}
            {groupSessions.map(item => {
              const name = groupSessionName(item);
              const members = (item.members || []).map(id => characterMap.get(id)).filter(Boolean);
              return (
                <SessionRow
                  key={`group-${item.id}`}
                  mode="switch"
                  avatar={(
                    <SessionAvatar
                      isGroup
                      uri={item.avatarUri || ''}
                      name={name}
                      members={members}
                      size={36}
                    />
                  )}
                  name={name}
                  preview={String(item.preview || '').trim()}
                  time={formatSessionTime(item.updatedAt)}
                  active={item.id === activeSessionId}
                  onPress={() => onSwitchGroup(item.id)}
                />
              );
            })}
          </ScrollView>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}
