import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { searchMessages } from './storage';
import { EmptyState } from './ui';
import { useTheme } from './theme/ThemeContext';

function formatTime(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return '';
  const date = new Date(value);
  const pad = number => String(number).padStart(2, '0');
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function buildSnippet(text, keyword) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  const keywordLower = String(keyword || '').toLowerCase();
  const index = source.toLowerCase().indexOf(keywordLower);
  if (index < 0) return source.slice(0, 80);
  const start = Math.max(0, index - 18);
  const end = Math.min(source.length, index + keyword.length + 40);
  return `${start > 0 ? '…' : ''}${source.slice(start, end)}${end < source.length ? '…' : ''}`;
}

export default function SearchScreen({ visible, onClose, onOpenResult, characters }) {
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const searchRequestRef = useRef(0);
  const searchControllerRef = useRef(null);
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  const characterMap = useMemo(() => {
    const map = new Map();
    (Array.isArray(characters) ? characters : []).forEach(character => {
      map.set(character.id, character);
    });
    return map;
  }, [characters]);

  const abortSearch = useCallback(() => {
    if (searchControllerRef.current) {
      searchControllerRef.current.abort();
      searchControllerRef.current = null;
    }
  }, []);

  useEffect(() => () => abortSearch(), [abortSearch]);

  const runSearch = useCallback(async () => {
    const query = keyword.trim();
    const requestId = ++searchRequestRef.current;
    abortSearch();
    if (!query) {
      setResults([]);
      setSearched(false);
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    searchControllerRef.current = controller;
    setSearching(true);
    try {
      const list = await searchMessages(query, { signal: controller.signal });
      if (controller.signal.aborted || requestId !== searchRequestRef.current) return;
      setResults(list);
      setSearched(true);
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      if (requestId !== searchRequestRef.current) return;
      Alert.alert('搜索失败', '请稍后重试。');
    } finally {
      if (searchControllerRef.current === controller) searchControllerRef.current = null;
      if (requestId === searchRequestRef.current) setSearching(false);
    }
  }, [abortSearch, keyword]);

  const handleKeywordChange = value => {
    searchRequestRef.current += 1;
    abortSearch();
    setSearching(false);
    setResults([]);
    setSearched(false);
    setKeyword(value);
  };

  const handleClose = () => {
    searchRequestRef.current += 1;
    abortSearch();
    setSearching(false);
    setKeyword('');
    setResults([]);
    setSearched(false);
    onClose();
  };

  const onPick = result => {
    searchRequestRef.current += 1;
    abortSearch();
    onOpenResult(result);
    setKeyword('');
    setResults([]);
    setSearched(false);
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleClose}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.header}>
          <View style={styles.searchBox}>
            <Ionicons name="search" size={16} color={theme.colors.textFaint} />
            <TextInput
              style={styles.input}
              value={keyword}
              onChangeText={handleKeywordChange}
              onSubmitEditing={runSearch}
              returnKeyType="search"
              placeholder="搜索历史聊天记录"
              placeholderTextColor={theme.colors.textFaint}
              autoFocus
            />
            {keyword ? (
              <TouchableOpacity onPress={() => handleKeywordChange('')} hitSlop={8}>
                <Ionicons name="close-circle" size={16} color={theme.colors.textFaint} />
              </TouchableOpacity>
            ) : null}
          </View>
          <TouchableOpacity style={styles.cancel} onPress={handleClose} activeOpacity={0.7}>
            <Text style={styles.cancelText}>取消</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity
          style={[styles.searchButton, (searching || !keyword.trim()) && styles.disabled]}
          onPress={runSearch}
          disabled={searching || !keyword.trim()}
          activeOpacity={0.8}
        >
          <Text style={styles.searchButtonText}>{searching ? '搜索中...' : '搜索'}</Text>
        </TouchableOpacity>

        {searching ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.colors.primary} />
          </View>
        ) : results.length > 0 ? (
          <FlatList
            data={results}
            keyExtractor={(result, index) => `${result.sessionId}-${result.messageId || 'message'}-${index}`}
            style={styles.list}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.listContent}
            ListHeaderComponent={<Text style={styles.count}>{`找到 ${results.length} 条记录`}</Text>}
            renderItem={({ item: result }) => {
              const character = characterMap.get(result.characterId);
              return (
                <TouchableOpacity
                  style={styles.item}
                  activeOpacity={0.75}
                  onPress={() => onPick(result)}
                >
                  <View style={styles.itemHeader}>
                    <Text style={styles.itemName} numberOfLines={1}>
                      {result.sessionType === 'group'
                        ? (result.sessionName || '群聊')
                        : ((character && character.name) || '角色资料缺失')}
                    </Text>
                    <Text style={styles.itemTime}>{formatTime(result.updatedAt)}</Text>
                  </View>
                  <Text style={styles.itemText} numberOfLines={2}>
                    {buildSnippet(result.text, keyword)}
                  </Text>
                </TouchableOpacity>
              );
            }}
          />
        ) : (
          <EmptyState
            icon={searched ? 'search-outline' : 'chatbubbles-outline'}
            title={searched ? '未找到匹配记录' : '搜索历史对话'}
            description={searched ? '请换个关键词重新搜索。' : '输入关键词搜索全部角色的聊天记录。'}
          />
        )}
      </KeyboardAvoidingView>
    </Modal>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background, paddingTop: 48 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: tokens.spacing.lg },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.radius.md,
    paddingHorizontal: tokens.spacing.md,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    minHeight: tokens.metrics.fieldHeight,
  },
  input: { flex: 1, color: theme.colors.text, fontSize: fonts.scaled(15), paddingVertical: 10, marginLeft: tokens.spacing.sm },
  cancel: { paddingHorizontal: tokens.spacing.md, paddingVertical: tokens.spacing.sm },
  cancelText: { color: theme.colors.primaryMuted, fontSize: fonts.scaled(15), fontWeight: '700' },
  searchButton: {
    marginTop: tokens.spacing.md,
    marginHorizontal: tokens.spacing.lg,
    backgroundColor: theme.colors.primary,
    borderRadius: tokens.metrics.buttonRadius,
    paddingVertical: 11,
    alignItems: 'center',
    ...tokens.elevation(1, theme),
  },
  searchButtonText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(15), fontWeight: '700' },
  disabled: { opacity: tokens.opacity.disabled },
  list: { flex: 1, marginTop: tokens.spacing.sm },
  listContent: { paddingHorizontal: tokens.spacing.lg, paddingBottom: tokens.spacing.xl },
  count: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), marginVertical: 10 },
  item: {
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.radius.md,
    padding: tokens.spacing.md,
    marginBottom: tokens.metrics.cardGap,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
  },
  itemHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  itemName: { color: theme.colors.text, fontSize: fonts.scaled(14), fontWeight: '700', flex: 1, marginRight: tokens.spacing.sm },
  itemTime: { color: theme.colors.textFaint, fontSize: fonts.scaled(11) },
  itemText: { color: theme.colors.textMuted, fontSize: fonts.scaled(13), lineHeight: fonts.scaled(19), marginTop: 6 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 80 },
});
