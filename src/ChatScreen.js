import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';

import { sendChatMessage } from './api';
import { useApp } from './context/AppContext';
import { getMessages, saveMessages } from './storage';

const USER_ID = 'user';
const ASSISTANT_ID = 'assistant';
const SYSTEM_ERROR_ID = 'system-error';
const SECRET_PATTERN = /(sk-[a-zA-Z0-9]{20,}|Bearer\s+[a-zA-Z0-9\-_]+)/g;

function maskSecrets(text) {
  return String(text || '').replace(SECRET_PATTERN, '[API_KEY已隐藏]');
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

function MessageBubble({ message }) {
  const isUser = message.role === USER_ID;
  return (
    <View style={[styles.messageRow, isUser ? styles.messageRowRight : styles.messageRowLeft]}>
      <View style={[styles.bubble, isUser ? styles.userBubble : styles.assistantBubble]}>
        <Text style={styles.messageText}>{message.text}</Text>
      </View>
    </View>
  );
}

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
  const { character } = useApp();
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState([]);
  const [isSending, setIsSending] = useState(false);
  const [ready, setReady] = useState(false);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollToEnd?.({ animated: true });
    });
  }, []);

  useEffect(() => {
    getMessages().then(list => {
      setMessages(list);
      setReady(true);
    });
  }, []);

  useEffect(() => {
    if (!ready) return;
    saveMessages(messages);
  }, [messages, ready]);

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
    if (!text || isSending) return;

    const userMessage = {
      id: `${Date.now()}-user`,
      role: USER_ID,
      text,
    };
    const pendingAssistantMessage = {
      id: `${Date.now()}-assistant`,
      role: ASSISTANT_ID,
      text: '正在思考...',
      pending: true,
    };

    const nextMessages = [...messages, userMessage, pendingAssistantMessage];
    setInput('');
    setMessages(nextMessages);
    setIsSending(true);
    scrollToBottom();

    try {
      const history = messages
        .filter(item => item.role === USER_ID || item.role === ASSISTANT_ID)
        .map(item => ({
          role: item.role === USER_ID ? 'user' : 'assistant',
          content: item.text,
        }));

      const systemPrompt = (character.systemPrompt || '').trim()
        || '你是 EasyChat2 的智能助手，回答简洁清晰。';
      const characterName = (character.name || '').trim();
      const systemContent = characterName
        ? `你的名字是${characterName}。${systemPrompt}`
        : systemPrompt;

      const reply = await sendChatMessage([
        { role: 'system', content: systemContent },
        ...history,
        { role: 'user', content: text },
      ]);

      setMessages(current =>
        current.map(item =>
          item.id === pendingAssistantMessage.id
            ? { ...item, text: reply || '没有收到回复。', pending: false }
            : item
        )
      );
    } catch (error) {
      const rawText = buildErrorRawText(error);
      const errorMessage = {
        id: pendingAssistantMessage.id,
        role: SYSTEM_ERROR_ID,
        text: '请求失败，点击查看详情',
        detail: maskSecrets(rawText),
      };
      errorRawRef.current[errorMessage.id] = rawText;
      setMessages(current =>
        current.map(item => (item.id === pendingAssistantMessage.id ? errorMessage : item))
      );
    } finally {
      setIsSending(false);
      scrollToBottom();
    }
  }, [character.name, character.systemPrompt, input, isSending, messages, scrollToBottom]);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 80 : 0}
    >
      <ScrollView
        ref={scrollRef}
        style={styles.messages}
        contentContainerStyle={styles.messagesContent}
        onContentSizeChange={scrollToBottom}
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
          messages.map(message =>
            message.role === SYSTEM_ERROR_ID ? (
              <ErrorBubble
                key={message.id}
                message={message}
                rawError={errorRawRef.current[message.id]}
              />
            ) : (
              <MessageBubble key={message.id} message={message} />
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
          editable={!isSending}
        />
        <TouchableOpacity
          style={[styles.sendButton, (!input.trim() || isSending) && styles.sendButtonDisabled]}
          onPress={onSend}
          disabled={!input.trim() || isSending}
        >
          <Text style={styles.sendText}>{isSending ? '...' : '发送'}</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
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
  bubble: {
    maxWidth: '82%',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  userBubble: {
    backgroundColor: '#6c63ff',
    borderBottomRightRadius: 6,
  },
  assistantBubble: {
    backgroundColor: '#2d2d44',
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
