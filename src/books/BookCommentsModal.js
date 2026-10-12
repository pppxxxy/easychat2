import React from 'react';
import { ActivityIndicator, Modal, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { GhostButton } from '../ui/index.js';

// 书评/角色评论弹层：纯展示组件，生成与引用动作由阅读器注入。
export default function BookCommentsModal({
  visible,
  onClose,
  styles,
  theme,
  t,
  characters,
  characterId,
  setCharacterId,
  generating,
  commentError,
  retry,
  comments,
  onCommentOnPage,
  onCommentChapter,
  onQuoteComment,
  activeCharacterName,
  pageGenerateDisabled,
  chapterGenerateDisabled,
}) {
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.container, styles.modalRoot]}>
        <View style={styles.modalTopBar}>
          <TouchableOpacity style={styles.backButton} onPress={onClose}>
            <Ionicons name="chevron-back" size={20} color={theme.colors.textMuted} />
            <Text style={styles.backText}>{t('books.reader.returnToReading')}</Text>
          </TouchableOpacity>
          <Text style={styles.title}>{t('books.comments.title')}</Text>
          <View style={styles.topActions} />
        </View>
        <View style={styles.commentsBody}>
          <Text style={styles.sectionHint}>{t('books.comments.characterLabel')}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipScroll}>
            {characters.map(entry => {
              const selected = entry.id === characterId;
              return (
                <TouchableOpacity
                  key={entry.id}
                  style={[styles.characterChip, selected && styles.characterChipActive]}
                  onPress={() => setCharacterId(entry.id)}
                  activeOpacity={0.8}
                >
                  <Text
                    style={[styles.characterChipText, selected && styles.characterChipTextActive]}
                    numberOfLines={1}
                  >
                    {String(entry.name || '').trim() || t('common.characterFallback')}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
          <View style={styles.generateRow}>
            <TouchableOpacity
              style={styles.generateButton}
              onPress={onCommentOnPage}
              disabled={pageGenerateDisabled}
              activeOpacity={0.85}
            >
              {generating
                ? <ActivityIndicator size="small" color={theme.colors.primaryContrast} />
                : <Ionicons name="chatbubbles" size={15} color={theme.colors.primaryContrast} />}
              <Text style={styles.generateText}>
                {t('books.comments.generate', { character: activeCharacterName })}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.generateButton, styles.generateButtonChapter]}
              onPress={onCommentChapter}
              disabled={chapterGenerateDisabled}
              activeOpacity={0.85}
            >
              <Ionicons name="book-outline" size={15} color={theme.colors.primarySoft} />
              <Text style={[styles.generateText, styles.generateTextChapter]}>
                {t('books.comments.generateChapter', { character: activeCharacterName })}
              </Text>
            </TouchableOpacity>
          </View>
          {commentError ? (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>{commentError}</Text>
              <GhostButton title={t('common.retry')} small onPress={retry} />
            </View>
          ) : null}
          {comments.length === 0 && !generating ? (
            <Text style={styles.emptyComments}>
              {characters.length > 0
                ? t('books.comments.empty', { character: t('common.characterFallback') })
                : t('books.comments.empty.noCharacter')}
            </Text>
          ) : null}
          {comments.map(comment => (
            <View key={comment.id} style={styles.commentCard}>
              <View style={styles.commentHead}>
                <Text style={styles.commentName} numberOfLines={1}>
                  {comment.characterName || t('common.characterFallback')}
                  {comment.chapterTitle ? ` · ${comment.chapterTitle}` : ''}
                </Text>
                <TouchableOpacity
                  style={styles.quoteButton}
                  onPress={() => onQuoteComment(comment)}
                  activeOpacity={0.85}
                >
                  <Text style={styles.quoteButtonText}>{t('books.comments.quote')}</Text>
                </TouchableOpacity>
              </View>
              <Text style={styles.commentText}>{comment.text}</Text>
            </View>
          ))}
        </View>
      </View>
    </Modal>
  );
}
