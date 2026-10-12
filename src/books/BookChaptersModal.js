import React from 'react';
import { FlatList, Modal, Text, TextInput, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { EmptyState } from '../ui/index.js';
import ChapterScrubber from './ChapterScrubber.js';

// 章节目录弹层：纯展示组件，跳转/搜索/进度数据与列表 ref 由阅读器注入。
export default function BookChaptersModal({
  visible,
  onClose,
  styles,
  theme,
  t,
  item,
  chapterQuery,
  setChapterQuery,
  filteredChapters,
  chapterListRef,
  onChapterScrollToIndexFailed,
  currentChapterIndex,
  chapterProgressMap,
  jumpToBlock,
  chapterEntries,
}) {
  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={[styles.container, styles.modalRoot]}>
        <View style={styles.modalTopBar}>
          <TouchableOpacity
            style={styles.backButton}
            onPress={onClose}
          >
            <Ionicons name="chevron-back" size={20} color={theme.colors.textMuted} />
            <Text style={styles.backText}>{t('books.reader.returnToReading')}</Text>
          </TouchableOpacity>
          <Text style={styles.title}>{t('books.reader.chapterTitle')}</Text>
          <View style={styles.topActions} />
        </View>
        {item.chapters.length === 0 ? (
          <EmptyState
            icon="list-outline"
            title={t('books.reader.noChapters.title')}
            description={t('books.reader.noChapters.body')}
          />
        ) : (
          <View style={styles.chapterBody}>
            <View style={styles.chapterSearchRow}>
              <Ionicons name="search-outline" size={15} color={theme.colors.textFaint} />
              <TextInput
                style={styles.chapterSearchInput}
                value={chapterQuery}
                onChangeText={setChapterQuery}
                placeholder={t('books.reader.chapter.search')}
                placeholderTextColor={theme.colors.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="search"
              />
              {chapterQuery ? (
                <TouchableOpacity onPress={() => setChapterQuery('')} hitSlop={8}>
                  <Ionicons name="close-circle" size={15} color={theme.colors.textFaint} />
                </TouchableOpacity>
              ) : null}
            </View>
            {filteredChapters.length === 0 ? (
              <Text style={styles.chapterEmpty}>{t('books.reader.chapter.noMatch')}</Text>
            ) : (
              <FlatList
                data={filteredChapters}
                ref={chapterListRef}
                onScrollToIndexFailed={onChapterScrollToIndexFailed}
                keyExtractor={entry => `${entry.blockIndex}-${entry.index}`}
                contentContainerStyle={styles.chapterList}
                renderItem={({ item: entry }) => {
                  const current = entry.index === currentChapterIndex;
                  // 三态：未记录 → 未读；≥100 → 已读完；其余按记录的百分比。
                  const percent = chapterProgressMap[entry.index];
                  return (
                    <TouchableOpacity
                      style={[styles.chapterRow, current && styles.chapterRowCurrent]}
                      onPress={() => {
                        jumpToBlock(entry.blockIndex);
                        onClose();
                      }}
                      activeOpacity={0.8}
                    >
                      <View style={styles.chapterRowMain}>
                        <Text
                          style={[styles.chapterText, current && styles.chapterTextCurrent]}
                          numberOfLines={1}
                        >
                          {entry.title}
                        </Text>
                        {current ? (
                          <Text style={styles.chapterCurrentBadge}>{t('books.reader.chapter.current')}</Text>
                        ) : null}
                      </View>
                      <Text style={styles.chapterPercent}>
                        {percent == null
                          ? t('books.reader.chapter.unread')
                          : percent >= 100
                            ? t('books.reader.chapter.done')
                            : t('books.reader.chapter.progress', { percent })}
                      </Text>
                    </TouchableOpacity>
                  );
                }}
              />
            )}
            <ChapterScrubber
              chapters={chapterEntries}
              currentIndex={currentChapterIndex}
              onSeek={index => {
                const entry = chapterEntries[index];
                if (entry) jumpToBlock(entry.blockIndex);
              }}
            />
          </View>
        )}
      </View>
    </Modal>
  );
}
