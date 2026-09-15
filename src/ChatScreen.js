import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import Markdown from 'react-native-markdown-display';
import RenderHtml from 'react-native-render-html';

import { isCanceledError, sendChatMessage } from './api';
import { buildRequestMessages } from './chatPipeline';
import { isStaleReply } from './chatRace';
import { useApp } from './context/AppContext';
import { applyRegexScripts, REGEX_PLACEMENT } from './regexEngine';
import { maskSecrets } from './secrets';
import { getMessages, getUserProfile, saveMessages } from './storage';

const USER_ID = 'user';
const ASSISTANT_ID = 'assistant';
const SYSTEM_ERROR_ID = 'system-error';
const MONO_FONT = Platform.OS === 'ios' ? 'Menlo' : 'monospace';
const THINKING_PLACEHOLDER = '正在思考...';
const NEAR_BOTTOM_THRESHOLD = 80;

const markdownStyles = {
  body: { color: '#1a1a2e', fontSize: 15, lineHeight: 22 },
  heading1: { color: '#000' },
  heading2: { color: '#000' },
  heading3: { color: '#000' },
  heading4: { color: '#000' },
  heading5: { color: '#000' },
  heading6: { color: '#000' },
  hr: { backgroundColor: '#ddd' },
  blockquote: { backgroundColor: '#f5f5f5', borderColor: '#6c63ff' },
  code_inline: {
    color: '#c7254e',
    backgroundColor: '#f5f5f5',
    borderWidth: 0,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
    fontFamily: MONO_FONT,
  },
  code_block: {
    color: '#333',
    backgroundColor: '#f5f5f5',
    borderWidth: 0,
    borderRadius: 8,
    padding: 10,
    fontFamily: MONO_FONT,
  },
  fence: {
    color: '#333',
    backgroundColor: '#f5f5f5',
    borderWidth: 0,
    borderRadius: 8,
    padding: 10,
    fontFamily: MONO_FONT,
  },
  link: { color: '#6c63ff' },
  bullet_list_icon: { color: '#1a1a2e' },
  ordered_list_icon: { color: '#1a1a2e' },
  bullet_list_content: { flex: 1, color: '#1a1a2e' },
  ordered_list_content: { flex: 1, color: '#1a1a2e' },
};

const HTML_TAG_PATTERN = /<\/?(?:div|span|blockquote|q|section|article|details|summary|table|thead|tbody|tr|td|th|ul|ol|li|p|h[1-6]|hr|br|b|i|u|strong|em|font|img|a|code|pre)\b[^>]*>/i;

const htmlBaseStyle = {
  color: '#1a1a2e',
  fontSize: 15,
  lineHeight: 22,
};

const htmlTagsStyles = {
  a: { color: '#6c63ff' },
  code: { fontFamily: MONO_FONT, color: '#c7254e', backgroundColor: '#f5f5f5' },
  pre: { fontFamily: MONO_FONT, color: '#333', backgroundColor: '#f5f5f5' },
  q: { color: '#1a1a2e' },
};

function containsHtml(text) {
  return HTML_TAG_PATTERN.test(String(text || ''));
}

function getHttpStatus(error) {
  return error?.status || error?.statusCode || error?.response?.status || null;
}

function buildErrorRawText(error) {
  const message = error?.message || '请检查 API 配置或网络连接。';
  const status = getHttpStatus(error);
  const stack = error?.stack || '';
  const lines = [message];
  if (status) {
    lines.push(`HTTP 状态码: ${status}`);
  }
  if (stack) {
    lines.push(stack);
  }
  return lines.join('\n');
}

function buildGreetingMessage(characterId, firstMes, userName) {
  const text = String(firstMes || '').trim();
  if (!text) return null;
  const replaced = userName ? text.replace(/\{\{user\}\}/g, userName) : text;
  return {
    id: `greeting-${characterId}`,
    role: ASSISTANT_ID,
    text: replaced,
  };
}

const MessageBubble = React.memo(function MessageBubble({ message, characterName, characterAvatar, userAvatarUri }) {
  const isUser = message.role === USER_ID;
  const { width } = useWindowDimensions();
  const renderHtml =
    !isUser && !message.pending && containsHtml(message.text);
  const contentWidth = Math.max(200, Math.floor((width - 28) * 0.88) - 28);
  const htmlSource = useMemo(() => ({ html: message.text }), [message.text]);

  const avatarElement = isUser ? (
    <View style={styles.avatarContainerRight}>
      {userAvatarUri ? (
        <Image source={{ uri: userAvatarUri }} style={styles.avatarImage} />
      ) : (
        <View style={styles.avatarPlaceholderUser}>
          <Text style={styles.avatarPlaceholderText}>
            {'我'}
          </Text>
        </View>
      )}
    </View>
  ) : (
    <View style={styles.avatarContainer}>
      {characterAvatar ? (
        <Image source={{ uri: characterAvatar }} style={styles.avatarImage} />
      ) : (
        <View style={styles.avatarPlaceholder}>
          <Text style={styles.avatarPlaceholderText}>
            {(characterName || '?').charAt(0)}
          </Text>
        </View>
      )}
    </View>
  );

  return (
    <View style={[styles.messageRow, isUser ? styles.messageRowRight : styles.messageRowLeft]}>
      {!isUser ? avatarElement : null}
      <View style={[styles.messageContent]}>
        {!isUser ? <Text style={styles.nameLabel}>{characterName || ''}</Text> : null}
        <View style={[styles.bubble, isUser ? styles.userBubble : styles.assistantBubble]}>
          {isUser ? (
            <Text style={styles.messageText}>{message.text}</Text>
          ) : renderHtml ? (
            <RenderHtml
              contentWidth={contentWidth}
              source={htmlSource}
              baseStyle={htmlBaseStyle}
              tagsStyles={htmlTagsStyles}
              defaultTextProps={{ selectable: true }}
            />
          ) : (
            <Markdown style={markdownStyles}>{message.text}</Markdown>
          )}
        </View>
      </View>
      {isUser ? avatarElement : null}
    </View>
  );
});

function ErrorBubble({ message, rawError, onCopied }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(async () => {
    const payload = rawError || message.detail || message.text || '';
    await Clipboard.setStringAsync(payload);
    setCopied(true);
    onCopied?.();
    setTimeout(() => setCopied(false), 1500);
  }, [message.detail, message.text, onCopied, rawError]);

  return (
    <View style={[styles.messageRow, styles.messageRowLeft]}>
      <View style={[styles.bubble, styles.errorBubble]}>
        <Text style={styles.errorBadge}>系统报错</Text>
        <TouchableOpacity onPress={() => setExpanded(current => !current)} activeOpacity={0.8}>
          <Text style={styles.errorSummary}>请求失败，点击查看详情</Text>
        </TouchableOpacity>
        {expanded ? (
          <Text style={styles.errorDetail} selectable>
            {maskSecrets(message.detail || message.text || '')}
          </Text>
        ) : null}
        <View style={styles.errorActions}>
          <TouchableOpacity style={styles.copyButton} onPress={onCopy}>
            <Text style={styles.copyButtonText}>{copied ? '已复制' : '复制报错'}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

export default function ChatScreen() {
  const scrollRef = useRef(null);
  const errorRawRef = useRef({});
  const lastSavedSnapshotRef = useRef(null);
  const saveFailedRef = useRef(false);
  const { character, characters, activeId, loaded, switchCharacter } = useApp();
  const characterId = character.id || 'default';
  const activeCharacterIdRef = useRef(characterId);
  const atBottomRef = useRef(true);
  const abortRef = useRef(null);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState([]);
  const [isSending, setIsSending] = useState(false);
  const [ready, setReady] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [userAvatar, setUserAvatar] = useState('');

  const onSwitch = useCallback(id => {
    setSwitcherOpen(false);
    if (id === activeCharacterIdRef.current) return;
    switchCharacter(id).catch(() => {
      Alert.alert('切换失败', '请检查存储空间或权限。');
    });
  }, [switchCharacter]);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollToEnd?.({ animated: true });
    });
  }, []);

  const autoScrollToBottom = useCallback(() => {
    if (atBottomRef.current) scrollToBottom();
  }, [scrollToBottom]);

  const onMessagesScroll = useCallback(({ nativeEvent }) => {
    const { contentOffset, contentSize, layoutMeasurement } = nativeEvent;
    const distanceFromBottom =
      contentSize.height - layoutMeasurement.height - contentOffset.y;
    atBottomRef.current = distanceFromBottom <= NEAR_BOTTOM_THRESHOLD;
  }, []);

  const persistableMessages = useMemo(
    () => (messages || []).filter(item => item && !item.pending),
    [messages]
  );
  const persistableSnapshot = useMemo(
    () => JSON.stringify(persistableMessages),
    [persistableMessages]
  );
  const renderedMessages = useMemo(
    () => messages.map((message, index) => {
      if (!message) return message;
      if (message.pending) return message;
      const depth = messages.length - 1 - index;
      if (message.role === ASSISTANT_ID) {
        const text = applyRegexScripts(
          message.text,
          character.regexScripts,
          REGEX_PLACEMENT.AI_OUTPUT,
          { mode: 'display', depth }
        );
        return text === message.text ? message : { ...message, text };
      }
      if (message.role === USER_ID) {
        const text = applyRegexScripts(
          message.text,
          character.regexScripts,
          REGEX_PLACEMENT.USER_INPUT,
          { mode: 'display', depth }
        );
        return text === message.text ? message : { ...message, text };
      }
      return message;
    }),
    [messages, character.regexScripts]
  );

  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    activeCharacterIdRef.current = characterId;
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setReady(false);
    setIsSending(false);
    errorRawRef.current = {};
    let userProfileCache = null;
    const profilePromise = getUserProfile().then(profile => {
      userProfileCache = profile;
      setUserAvatar(profile.avatarUri || '');
    }).catch(() => {});
    getMessages(characterId)
      .then(async list => {
        if (cancelled) return;
        await profilePromise;
        const initial = Array.isArray(list) ? list : [];
        const greeting = initial.length === 0
          ? buildGreetingMessage(characterId, character.firstMes, userProfileCache?.userName)
          : null;
        lastSavedSnapshotRef.current = JSON.stringify(initial);
        setMessages(greeting ? [greeting] : initial);
      })
      .catch(() => {
        if (cancelled) return;
        lastSavedSnapshotRef.current = '[]';
        setMessages([]);
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [characterId, loaded]);

  useEffect(() => {
    if (!ready) return;
    if (persistableSnapshot === lastSavedSnapshotRef.current) return;
    lastSavedSnapshotRef.current = persistableSnapshot;
    saveMessages(characterId, persistableMessages).catch(() => {
      if (!saveFailedRef.current) {
        saveFailedRef.current = true;
        Alert.alert('聊天记录保存失败', '请检查存储空间或权限。');
      }
    });
  }, [characterId, persistableSnapshot, ready]);

  useEffect(() => () => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
  }, []);

  const onStop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
  }, []);

  const onClear = useCallback(() => {
    Alert.alert('清空聊天', '确定删除当前会话记录吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '清空',
        style: 'destructive',
        onPress: () => {
          errorRawRef.current = {};
          setMessages([]);
        }
      }
    ]);
  }, []);

  const onSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isSending || !ready) return;
    const sendCharacterId = activeCharacterIdRef.current;

    const userMessage = {
      id: `${Date.now()}-user`,
      role: USER_ID,
      text,
    };
    const pendingAssistantMessage = {
      id: `${Date.now()}-assistant`,
      role: ASSISTANT_ID,
      text: THINKING_PLACEHOLDER,
      pending: true,
    };

    const nextMessages = [...messages, userMessage, pendingAssistantMessage];
    setInput('');
    setMessages(nextMessages);
    setIsSending(true);
    atBottomRef.current = true;
    scrollToBottom();

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const userProfile = await getUserProfile();
      const requestMessages = buildRequestMessages({
        character,
        historyMessages: messages,
        userText: text,
        userProfile,
      });

      const reply = await sendChatMessage(
        requestMessages,
        {
          signal: controller.signal,
          onChunk: fullText => {
            if (isStaleReply(activeCharacterIdRef.current, sendCharacterId)) return;
            setMessages(current =>
              current.map(item =>
                item.id === pendingAssistantMessage.id
                  ? { ...item, text: fullText }
                  : item
              )
            );
          }
        }
      );

      setMessages(current => {
        if (isStaleReply(activeCharacterIdRef.current, sendCharacterId)) return current;
        return current.map(item =>
          item.id === pendingAssistantMessage.id
            ? { ...item, text: reply || '没有收到回复。', pending: false }
            : item
        );
      });
    } catch (error) {
      if (isCanceledError(error)) {
        setMessages(current => {
          if (isStaleReply(activeCharacterIdRef.current, sendCharacterId)) return current;
          const pendingItem = current.find(item => item.id === pendingAssistantMessage.id);
          const hasPartial = !!pendingItem
            && typeof pendingItem.text === 'string'
            && pendingItem.text.trim().length > 0
            && pendingItem.text !== THINKING_PLACEHOLDER;
          if (hasPartial) {
            return current.map(item => (
              item.id === pendingAssistantMessage.id ? { ...item, pending: false } : item
            ));
          }
          return current.filter(item => item.id !== pendingAssistantMessage.id);
        });
        return;
      }
      const rawText = buildErrorRawText(error);
      const errorMessage = {
        id: `${pendingAssistantMessage.id}-error`,
        role: SYSTEM_ERROR_ID,
        text: '请求失败，点击查看详情',
        detail: maskSecrets(rawText),
      };
      if (!isStaleReply(activeCharacterIdRef.current, sendCharacterId)) {
        errorRawRef.current[errorMessage.id] = rawText;
      }
      setMessages(current => {
        if (isStaleReply(activeCharacterIdRef.current, sendCharacterId)) return current;
        const pendingItem = current.find(item => item.id === pendingAssistantMessage.id);
        const hasPartial = !!pendingItem
          && typeof pendingItem.text === 'string'
          && pendingItem.text.trim().length > 0
          && pendingItem.text !== THINKING_PLACEHOLDER;
        if (hasPartial) {
          return current
            .map(item => (
              item.id === pendingAssistantMessage.id ? { ...item, pending: false } : item
            ))
            .concat(errorMessage);
        }
        return current.map(item => (
          item.id === pendingAssistantMessage.id ? errorMessage : item
        ));
      });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setIsSending(false);
      autoScrollToBottom();
    }
  }, [autoScrollToBottom, character, input, isSending, messages, ready, scrollToBottom]);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 80 : 0}
    >
      <View style={styles.topBar}>
        <TouchableOpacity
          style={styles.topBarButton}
          onPress={() => setSwitcherOpen(true)}
          disabled={!loaded}
          activeOpacity={0.8}
        >
          <Text style={styles.topBarLabel}>当前角色</Text>
          <Text style={styles.topBarName} numberOfLines={1}>
            {character.name || 'EasyChat2 助手'}
          </Text>
          <Text style={styles.topBarAction}>切换</Text>
        </TouchableOpacity>
      </View>
      <ScrollView
        ref={scrollRef}
        style={styles.messages}
        contentContainerStyle={styles.messagesContent}
        onContentSizeChange={autoScrollToBottom}
        onScroll={onMessagesScroll}
        scrollEventThrottle={16}
        keyboardShouldPersistTaps="handled"
      >
        {messages.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>开始聊天</Text>
            <Text style={styles.emptyText}>
              当前角色：{character.name || 'EasyChat2 助手'}{'\n'}
              请先在“设置”里填写 API Key，然后输入消息。
            </Text>
          </View>
        ) : (
          renderedMessages.map(message =>
            message.role === SYSTEM_ERROR_ID ? (
              <ErrorBubble
                key={message.id}
                message={message}
                rawError={errorRawRef.current[message.id]}
              />
            ) : (
              <MessageBubble
                key={message.id}
                message={message}
                characterName={character.name}
                characterAvatar={character.avatarUri}
                userAvatarUri={userAvatar}
              />
            )
          )
        )}
      </ScrollView>

      <View style={styles.inputBar}>
        {messages.length > 0 ? (
          <TouchableOpacity style={styles.clearButton} onPress={onClear} disabled={isSending}>
            <Text style={styles.clearText}>清空</Text>
          </TouchableOpacity>
        ) : null}
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="输入消息..."
          placeholderTextColor="#888"
          multiline
          editable={!isSending && ready}
        />
        {isSending ? (
          <TouchableOpacity style={[styles.sendButton, styles.stopButton]} onPress={onStop}>
            <Text style={styles.sendText}>停止</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.sendButton, (!input.trim() || !ready) && styles.sendButtonDisabled]}
            onPress={onSend}
            disabled={!input.trim() || !ready}
          >
            <Text style={styles.sendText}>发送</Text>
          </TouchableOpacity>
        )}
      </View>

      <Modal
        visible={switcherOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setSwitcherOpen(false)}
      >
        <TouchableOpacity
          style={styles.modalBackdrop}
          activeOpacity={1}
          onPress={() => setSwitcherOpen(false)}
        >
          <TouchableOpacity style={styles.modalSheet} activeOpacity={1} onPress={() => {}}>
            <Text style={styles.modalTitle}>选择角色</Text>
            <ScrollView style={styles.modalList} keyboardShouldPersistTaps="handled">
              {characters.map(item => {
                const selected = item.id === activeId;
                return (
                  <TouchableOpacity
                    key={item.id}
                    style={[styles.modalRow, selected && styles.modalRowActive]}
                    onPress={() => onSwitch(item.id)}
                    activeOpacity={0.8}
                  >
                    <Text
                      style={[styles.modalRowText, selected && styles.modalRowTextActive]}
                      numberOfLines={1}
                    >
                      {item.name || '未命名角色'}
                    </Text>
                    {selected ? <Text style={styles.modalBadge}>当前</Text> : null}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  topBar: {
    borderBottomWidth: 1,
    borderBottomColor: '#2d2d44',
    backgroundColor: '#1a1a2e',
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  topBarButton: { flexDirection: 'row', alignItems: 'center' },
  topBarLabel: { color: '#888', fontSize: 12, marginRight: 8 },
  topBarName: { color: '#fff', fontWeight: '700', flexShrink: 1 },
  topBarAction: { color: '#8b85ff', fontSize: 12, fontWeight: '700', marginLeft: 8 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    padding: 24,
  },
  modalSheet: {
    backgroundColor: '#24243b',
    borderRadius: 12,
    padding: 16,
    maxHeight: '70%',
  },
  modalTitle: { color: '#fff', fontSize: 16, fontWeight: '800', marginBottom: 12 },
  modalList: { maxHeight: 360 },
  modalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#2d2d44',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 8,
  },
  modalRowActive: { borderWidth: 1, borderColor: '#6c63ff' },
  modalRowText: { color: '#d9d9e6', flex: 1, marginRight: 8 },
  modalRowTextActive: { color: '#fff', fontWeight: '700' },
  modalBadge: { color: '#c8c4ff', fontSize: 12, fontWeight: '700' },
  container: {
    flex: 1,
    backgroundColor: '#1a1a2e',
  },
  messages: {
    flex: 1,
  },
  messagesContent: {
    flexGrow: 1,
    paddingHorizontal: 14,
    paddingVertical: 16,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  emptyTitle: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '800',
    marginBottom: 8,
  },
  emptyText: {
    color: '#aaa',
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
  },
  messageRow: {
    marginVertical: 5,
    flexDirection: 'row',
  },
  messageRowLeft: {
    justifyContent: 'flex-start',
  },
  messageRowRight: {
    justifyContent: 'flex-end',
  },
  avatarContainer: {
    width: 34,
    height: 34,
    borderRadius: 8,
    marginRight: 8,
    overflow: 'hidden',
    alignSelf: 'flex-start',
    marginTop: 16,
  },
  avatarContainerRight: {
    width: 34,
    height: 34,
    borderRadius: 8,
    marginLeft: 8,
    overflow: 'hidden',
    alignSelf: 'flex-start',
    marginTop: 16,
  },
  avatarImage: {
    width: 34,
    height: 34,
  },
  avatarPlaceholder: {
    width: 34,
    height: 34,
    borderRadius: 8,
    backgroundColor: '#6c63ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarPlaceholderUser: {
    width: 34,
    height: 34,
    borderRadius: 8,
    backgroundColor: '#555',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarPlaceholderText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 14,
  },
  messageContent: {
    maxWidth: '92%',
  },
  nameLabel: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
    marginBottom: 2,
    marginLeft: 2,
  },
  messageRowLeft: {
    justifyContent: 'flex-start',
  },
  messageRowRight: {
    justifyContent: 'flex-end',
  },
  bubble: {
    maxWidth: '95%',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  userBubble: {
    backgroundColor: '#6c63ff',
    borderBottomRightRadius: 6,
  },
  assistantBubble: {
    backgroundColor: '#f0f0f0',
    borderBottomLeftRadius: 6,
  },
  errorBubble: {
    backgroundColor: '#5a1d1d',
    borderColor: '#8b2e2e',
    borderWidth: 1,
    borderBottomLeftRadius: 6,
    maxWidth: '92%',
  },
  errorBadge: {
    color: '#ffb4b4',
    fontSize: 12,
    fontWeight: '800',
    marginBottom: 6,
  },
  errorSummary: {
    color: '#ffd6d6',
    fontSize: 15,
    lineHeight: 21,
  },
  errorDetail: {
    color: '#ffd6d6',
    fontSize: 13,
    lineHeight: 19,
    marginTop: 10,
  },
  errorActions: {
    marginTop: 10,
    alignItems: 'flex-end',
  },
  copyButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 12,
    backgroundColor: '#7a2a2a',
  },
  copyButtonText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  messageText: {
    color: '#fff',
    fontSize: 15,
    lineHeight: 21,
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 10,
    borderTopWidth: 1,
    borderTopColor: '#2d2d44',
    backgroundColor: '#1a1a2e',
  },
  input: {
    flex: 1,
    minHeight: 42,
    maxHeight: 110,
    borderRadius: 20,
    backgroundColor: '#2d2d44',
    color: '#fff',
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
  },
  sendButton: {
    marginLeft: 8,
    minWidth: 58,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#6c63ff',
  },
  sendButtonDisabled: {
    opacity: 0.45,
  },
  stopButton: {
    backgroundColor: '#7a2a2a',
  },
  sendText: {
    color: '#fff',
    fontWeight: '800',
  },
  clearButton: {
    marginRight: 8,
    height: 42,
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  clearText: {
    color: '#aaa',
    fontWeight: '700',
  },
});
