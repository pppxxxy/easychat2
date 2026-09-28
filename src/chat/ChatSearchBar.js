// 聊天内搜索栏。从 src/ChatScreen.js 原样外提（无行为变化）。

import React, { useMemo } from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext';
import { createChatStyles } from './chatStyles';

export default function ChatSearchBar({
  visible,
  query,
  onChangeQuery,
  matchCount,
  activeMatchIndex,
  onPrev,
  onNext,
  onClose,
}) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createChatStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  if (!visible) return null;

  return (
    <View style={styles.searchBar}>
      <Ionicons name="search" size={15} color={theme.colors.textFaint} />
      <TextInput
        style={styles.searchInput}
        value={query}
        onChangeText={onChangeQuery}
        placeholder="在本对话中搜索"
        placeholderTextColor={theme.colors.textFaint}
        autoFocus
        returnKeyType="search"
        onSubmitEditing={() => onNext()}
      />
      <Text style={styles.searchCount}>
        {matchCount ? `${activeMatchIndex + 1}/${matchCount}` : '0/0'}
      </Text>
      <TouchableOpacity
        onPress={onPrev}
        disabled={matchCount === 0}
        hitSlop={6}
        style={styles.searchNav}
      >
        <Ionicons
          name="chevron-up"
          size={18}
          color={matchCount ? theme.colors.primarySoft : theme.colors.textFaint}
        />
      </TouchableOpacity>
      <TouchableOpacity
        onPress={onNext}
        disabled={matchCount === 0}
        hitSlop={6}
        style={styles.searchNav}
      >
        <Ionicons
          name="chevron-down"
          size={18}
          color={matchCount ? theme.colors.primarySoft : theme.colors.textFaint}
        />
      </TouchableOpacity>
      <TouchableOpacity onPress={onClose} hitSlop={6} style={styles.searchNav}>
        <Ionicons name="close" size={18} color={theme.colors.primarySoft} />
      </TouchableOpacity>
    </View>
  );
}
