// 聊天页顶栏（消息多选态 + 常规态）。从 src/ChatScreen.js 原样外提（无行为变化）。

import React, { useMemo } from 'react';
import { Image, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext.js';
import { createChatStyles } from './chatStyles.js';

export default function ChatTopBar({
  messageSelectionOpen,
  selectedCount,
  isSending,
  onCancelSelection,
  onDeleteSelected,
  onOpenSwitcher,
  loaded,
  isGroup,
  groupAvatarUri,
  characterAvatarUri,
  displayName,
  onNewChat,
  ready,
  autoBroadcast,
  onToggleBroadcast,
  onOpenMore,
}) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createChatStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  return (
    <View style={styles.topBar}>
      {messageSelectionOpen ? (
        <>
          <TouchableOpacity
            style={styles.selectionAction}
            onPress={onCancelSelection}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="取消选择消息"
          >
            <Ionicons name="close" size={16} color={theme.colors.primarySoft} />
            <Text style={styles.selectionActionText}>取消</Text>
          </TouchableOpacity>
          <Text style={styles.selectionCount}>已选择 {selectedCount} 条</Text>
          <TouchableOpacity
            style={[styles.selectionAction, isSending && styles.actionDisabled]}
            onPress={onDeleteSelected}
            disabled={isSending}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="删除选中消息"
          >
            <Ionicons name="trash-outline" size={16} color={theme.colors.danger} />
            <Text style={[styles.selectionActionText, styles.selectionDeleteText]}>删除</Text>
          </TouchableOpacity>
        </>
      ) : (
        <>
          <TouchableOpacity
            style={styles.characterChip}
            onPress={onOpenSwitcher}
            disabled={!loaded}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={isGroup ? '切换群聊' : '切换角色'}
            accessibilityState={{ disabled: !loaded }}
          >
            {isGroup ? (
              groupAvatarUri ? (
                <Image source={{ uri: groupAvatarUri }} style={styles.characterAvatar} />
              ) : (
                <View style={[styles.characterAvatar, styles.characterAvatarFallback]}>
                  <Ionicons name="people" size={13} color={theme.colors.primarySoft} />
                </View>
              )
            ) : characterAvatarUri ? (
              <Image source={{ uri: characterAvatarUri }} style={styles.characterAvatar} />
            ) : (
              <View style={[styles.characterAvatar, styles.characterAvatarFallback]}>
                <Ionicons name="person" size={13} color={theme.colors.primarySoft} />
              </View>
            )}
            <Text style={styles.characterName} numberOfLines={1}>
              {displayName}
            </Text>
            <Ionicons name="chevron-down" size={14} color={theme.colors.primaryMuted} style={styles.characterCaret} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.noticeButton, (isSending || !ready) && styles.actionDisabled]}
            onPress={onNewChat}
            disabled={isSending || !ready}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="新建对话"
            accessibilityState={{ disabled: isSending || !ready }}
          >
            <Ionicons name="add-circle-outline" size={13} color={theme.colors.primarySoft} />
            <Text style={styles.noticeButtonText}>新建</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.noticeButton, !autoBroadcast && styles.actionDisabled]}
            onPress={onToggleBroadcast}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={autoBroadcast ? '关闭自动播报' : '开启自动播报'}
          >
            <Ionicons
              name={autoBroadcast ? 'volume-high-outline' : 'volume-mute-outline'}
              size={13}
              color={theme.colors.primarySoft}
            />
            <Text style={styles.noticeButtonText}>{autoBroadcast ? '自动播报开' : '自动播报关'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.noticeButton}
            onPress={onOpenMore}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="更多功能"
          >
            <Ionicons name="ellipsis-horizontal" size={15} color={theme.colors.primarySoft} />
          </TouchableOpacity>
        </>
      )}
    </View>
  );
}
