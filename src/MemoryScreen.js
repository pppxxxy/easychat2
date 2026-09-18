import React, { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useApp } from './context/AppContext';
import SearchScreen from './SearchScreen';

function formatTime(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return '';
  const date = new Date(value);
  const now = new Date();
  const pad = number => String(number).padStart(2, '0');
  if (date.toDateString() === now.toDateString()) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return '昨天';
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function RowAction({ icon, color, onPress, label }) {
  return (
    <TouchableOpacity
      style={styles.rowAction}
      onPress={onPress}
      accessibilityLabel={label}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
    >
      <Ionicons name={icon} size={18} color={color} />
    </TouchableOpacity>
  );
}

export default function MemoryScreen({ navigation }) {
  const {
    sessions,
    characters,
    loaded,
    switchSession,
    switchCharacter,
    pinSession,
    cloneSession,
    deleteSession,
    setPendingTarget,
  } = useApp();

  const [searchOpen, setSearchOpen] = useState(false);

  const characterMap = useMemo(() => {
    const map = new Map();
    (Array.isArray(characters) ? characters : []).forEach(character => {
      map.set(character.id, character);
    });
    return map;
  }, [characters]);

  const visibleSessions = useMemo(
    () => (Array.isArray(sessions) ? sessions : []).filter(
      session => String(session.preview || '').trim().length > 0
    ),
    [sessions]
  );

  const onOpen = useCallback(async session => {
    try {
      await switchCharacter(session.characterId);
      await switchSession(session.id);
      navigation.navigate('聊天');
    } catch (error) {
      Alert.alert('打开失败', '请检查存储空间或权限。');
    }
  }, [navigation, switchCharacter, switchSession]);

  const onPin = useCallback(async session => {
    try {
      await pinSession(session.id);
    } catch (error) {
      Alert.alert('置顶失败', '请检查存储空间或权限。');
    }
  }, [pinSession]);

  const onClone = useCallback(session => {
    Alert.alert('克隆会话', '将复制这段对话为一段新的会话。', [
      { text: '取消', style: 'cancel' },
      {
        text: '克隆',
        onPress: () => {
          cloneSession(session.id).catch(() => {
            Alert.alert('克隆失败', '请检查存储空间或权限。');
          });
        },
      },
    ]);
  }, [cloneSession]);

  const onDelete = useCallback(session => {
    Alert.alert('删除会话', '将删除这段对话及其全部消息。', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          deleteSession(session.id).catch(() => {
            Alert.alert('删除失败', '请检查存储空间或权限。');
          });
        },
      },
    ]);
  }, [deleteSession]);

  const onOpenResult = useCallback(async result => {
    try {
      await switchCharacter(result.characterId);
      await switchSession(result.sessionId);
      setPendingTarget({ sessionId: result.sessionId, messageId: result.messageId });
      setSearchOpen(false);
      navigation.navigate('聊天');
    } catch (error) {
      Alert.alert('打开失败', '请检查存储空间或权限。');
    }
  }, [navigation, setPendingTarget, switchCharacter, switchSession]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>记忆</Text>
        <View style={styles.headerRight}>
          <Text style={styles.count}>
            {loaded ? `${visibleSessions.length} 段对话` : '加载中'}
          </Text>
          <TouchableOpacity
            style={styles.searchButton}
            onPress={() => setSearchOpen(true)}
            activeOpacity={0.7}
            accessibilityLabel="搜索历史聊天记录"
          >
            <Ionicons name="search" size={18} color="#c8c4ff" />
          </TouchableOpacity>
        </View>
      </View>
      {loaded && visibleSessions.length === 0 ? (
        <View style={styles.emptyWrap}>
          <Ionicons name="albums-outline" size={40} color="#5a5a78" />
          <Text style={styles.emptyTitle}>还没有历史对话</Text>
          <Text style={styles.emptyHint}>去聊天页开始一段新的对话吧。</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        >
          {visibleSessions.map(session => {
            const character = characterMap.get(session.characterId);
            const name = (character && character.name) || '未命名角色';
            const isClone = !!session.clonedFrom;
            return (
              <View key={session.id} style={styles.card}>
                <TouchableOpacity
                  style={styles.cardMain}
                  activeOpacity={0.75}
                  onPress={() => onOpen(session)}
                >
                  {character && character.avatarUri ? (
                    <Image source={{ uri: character.avatarUri }} style={styles.avatar} />
                  ) : (
                    <View style={[styles.avatar, styles.avatarFallback]}>
                      <Text style={styles.avatarText}>{name.slice(0, 1)}</Text>
                    </View>
                  )}
                  <View style={styles.cardText}>
                    <View style={styles.nameRow}>
                      <Text style={styles.name} numberOfLines={1}>{name}</Text>
                      {isClone ? <Text style={styles.badge}>副本</Text> : null}
                      {session.pinned ? (
                        <Ionicons name="star" size={12} color="#f2c14e" style={styles.pinMark} />
                      ) : null}
                    </View>
                    <Text style={styles.preview} numberOfLines={2}>
                      {session.preview}
                    </Text>
                    <Text style={styles.time}>{formatTime(session.updatedAt)}</Text>
                  </View>
                </TouchableOpacity>
                <View style={styles.actions}>
                  <RowAction
                    icon={session.pinned ? 'star' : 'star-outline'}
                    color={session.pinned ? '#f2c14e' : '#9a9ab5'}
                    label="置顶"
                    onPress={() => onPin(session)}
                  />
                  <RowAction
                    icon="copy-outline"
                    color="#9a9ab5"
                    label="克隆"
                    onPress={() => onClone(session)}
                  />
                  <RowAction
                    icon="trash-outline"
                    color="#ff6b81"
                    label="删除"
                    onPress={() => onDelete(session)}
                  />
                </View>
              </View>
            );
          })}
        </ScrollView>
      )}

      <SearchScreen
        visible={searchOpen}
        onClose={() => setSearchOpen(false)}
        onOpenResult={onOpenResult}
        characters={characters}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1a1a2e' },
  header: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 10,
  },
  title: { color: '#ffffff', fontSize: 20, fontWeight: '800' },
  count: { color: '#8a8aa3', fontSize: 13 },
  headerRight: { flexDirection: 'row', alignItems: 'center' },
  searchButton: {
    marginLeft: 12,
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(108,99,255,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(139,133,255,0.35)',
  },
  listContent: { paddingHorizontal: 16, paddingBottom: 24 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#2d2d44',
    borderRadius: 14,
    marginBottom: 10,
    paddingLeft: 12,
    borderWidth: 1,
    borderColor: '#35354f',
  },
  cardMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingRight: 6,
  },
  avatar: { width: 46, height: 46, borderRadius: 12, backgroundColor: '#3a3a55' },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#c9c9e0', fontSize: 18, fontWeight: '700' },
  cardText: { flex: 1, marginLeft: 12 },
  nameRow: { flexDirection: 'row', alignItems: 'center' },
  name: { color: '#ffffff', fontSize: 15, fontWeight: '700', maxWidth: '70%' },
  badge: {
    marginLeft: 6,
    color: '#b9b3ff',
    fontSize: 10,
    fontWeight: '700',
    backgroundColor: 'rgba(108,99,255,0.25)',
    borderRadius: 6,
    paddingHorizontal: 5,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  pinMark: { marginLeft: 6 },
  preview: { color: '#a8a8c2', fontSize: 13, lineHeight: 18, marginTop: 4 },
  time: { color: '#6f6f8d', fontSize: 11, marginTop: 5 },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: 8,
  },
  rowAction: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 80,
  },
  emptyTitle: { color: '#c9c9e0', fontSize: 15, fontWeight: '700', marginTop: 14 },
  emptyHint: { color: '#7d7d99', fontSize: 13, marginTop: 6 },
});
