import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { searchMessages } from './storage';
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
  const { theme, fonts } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts), [theme, fonts]);

  const characterMap = useMemo(() => {
    const map = new Map();
    (Array.isArray(characters) ? characters : []).forEach(character => {
      map.set(character.id, character);
    });
    return map;
  }, [characters]);

  const runSearch = useCallback(async () => {
    const query = keyword.trim();
    if (!query) {
      setResults([]);
      setSearched(false);
      return;
    }
    setSearching(true);
    try {
      const list = await searchMessages(query);
      setResults(list);
      setSearched(true);
    } catch (error) {
      Alert.alert('搜索失败', '请稍后重试。');
    } finally {
      setSearching(false);
    }
  }, [keyword]);

  const handleClose = () => {
    setKeyword('');
    setResults([]);
    setSearched(false);
    onClose();
  };

  const onPick = result => {
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
              onChangeText={setKeyword}
              onSubmitEditing={runSearch}
              returnKeyType="search"
              placeholder="搜索历史聊天记录"
              placeholderTextColor={theme.colors.textFaint}
              autoFocus
            />
            {keyword ? (
              <TouchableOpacity onPress={() => setKeyword('')} hitSlop={8}>
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
          <ScrollView
            style={styles.list}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.listContent}
          >
            <Text style={styles.count}>{`找到 ${results.length} 条记录`}</Text>
            {results.map(result => {
              const character = characterMap.get(result.characterId);
              return (
                <TouchableOpacity
                  key={`${result.sessionId}-${result.messageId}`}
                  style={styles.item}
                  activeOpacity={0.75}
                  onPress={() => onPick(result)}
                >
                  <View style={styles.itemHeader}>
                    <Text style={styles.itemName} numberOfLines={1}>
                      {(character && character.name) || '未命名角色'}
                    </Text>
                    <Text style={styles.itemTime}>{formatTime(result.updatedAt)}</Text>
                  </View>
                  <Text style={styles.itemText} numberOfLines={2}>
                    {buildSnippet(result.text, keyword)}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        ) : (
          <View style={styles.center}>
            <Ionicons
              name={searched ? 'search-outline' : 'chatbubbles-outline'}
              size={36}
              color={theme.colors.textFaint}
            />
            <Text style={styles.emptyText}>
              {searched ? '没有找到匹配的记录' : '输入关键词搜索全部历史对话'}
            </Text>
          </View>
        )}
      </KeyboardAvoidingView>
    </Modal>
  );
}

const createStyles = (theme, fonts) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background, paddingTop: 48 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderRadius: 12,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: theme.colors.divider,
  },
  input: { flex: 1, color: theme.colors.text, fontSize: fonts.scaled(15), paddingVertical: 10, marginLeft: 8 },
  cancel: { paddingHorizontal: 12, paddingVertical: 8 },
  cancelText: { color: theme.colors.primaryMuted, fontSize: fonts.scaled(15), fontWeight: '700' },
  searchButton: {
    marginTop: 12,
    marginHorizontal: 16,
    backgroundColor: theme.colors.primary,
    borderRadius: 12,
    paddingVertical: 11,
    alignItems: 'center',
  },
  searchButtonText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(15), fontWeight: '700' },
  disabled: { opacity: 0.5 },
  list: { flex: 1, marginTop: 8 },
  listContent: { paddingHorizontal: 16, paddingBottom: 24 },
  count: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), marginVertical: 10 },
  item: {
    backgroundColor: theme.colors.surface,
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: theme.colors.divider,
  },
  itemHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  itemName: { color: theme.colors.text, fontSize: fonts.scaled(14), fontWeight: '700', flex: 1, marginRight: 8 },
  itemTime: { color: theme.colors.textFaint, fontSize: fonts.scaled(11) },
  itemText: { color: theme.colors.textMuted, fontSize: fonts.scaled(13), lineHeight: fonts.scaled(19), marginTop: 6 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 80 },
  emptyText: { color: theme.colors.textFaint, fontSize: fonts.scaled(14), marginTop: 12 },
});
