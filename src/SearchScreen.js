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

import { searchMessages } from './storage/sessions.js';
import SessionRow, { SessionAvatar } from './memory/SessionRow.js';
import { EmptyState } from './ui/index.js';
import { useTheme } from './theme/ThemeContext.js';
import { useTranslation } from './i18n/I18nContext.js';
// 时间标签与聊天页定位条共用同一个函数（此前这里是逐字重复的一份实现，中英格式化
// 要改两处——两处都是「1月2日 09:05」的硬编码中文）。t 显式传入，跟随界面语言。
import { formatScrubberTime } from './chat/chatHelpers.js';

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
  const { t } = useTranslation();
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
      Alert.alert(t('search.alert.failed.title'), t('common.error.retryLater'));
    } finally {
      if (searchControllerRef.current === controller) searchControllerRef.current = null;
      if (requestId === searchRequestRef.current) setSearching(false);
    }
  }, [abortSearch, keyword, t]);

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
              placeholder={t('search.history.placeholder')}
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
            <Text style={styles.cancelText}>{t('common.cancel')}</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity
          style={[styles.searchButton, (searching || !keyword.trim()) && styles.disabled]}
          onPress={runSearch}
          disabled={searching || !keyword.trim()}
          activeOpacity={0.8}
        >
          <Text style={styles.searchButtonText}>{searching ? t('search.action.searching') : t('search.action.search')}</Text>
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
            ListHeaderComponent={<Text style={styles.count}>{t('search.result.count', { count: results.length })}</Text>}
            renderItem={({ item: result }) => {
              const character = characterMap.get(result.characterId);
              const isGroup = result.sessionType === 'group';
              const name = isGroup
                ? (result.sessionName || t('common.groupChat'))
                : ((character && character.name) || t('search.result.missingCharacter'));
              return (
                <SessionRow
                  mode="result"
                  avatar={(
                    <SessionAvatar
                      isGroup={isGroup}
                      uri={isGroup ? '' : ((character && character.avatarUri) || '')}
                      name={name}
                    />
                  )}
                  name={name}
                  preview={buildSnippet(result.text, keyword)}
                  time={formatScrubberTime(result.updatedAt, t)}
                  onPress={() => onPick(result)}
                />
              );
            }}
          />
        ) : (
          <EmptyState
            icon={searched ? 'search-outline' : 'chatbubbles-outline'}
            title={searched ? t('search.empty.notFound.title') : t('search.empty.hint.title')}
            description={searched ? t('search.empty.notFound.description') : t('search.empty.hint.description')}
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
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 80 },
});
