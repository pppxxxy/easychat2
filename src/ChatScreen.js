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

import { sendChatMessage } from './api';
import { useApp } from './context/AppContext';
import { getMessages, saveMessages } from './storage';

const USER_ID = 'user';
const ASSISTANT_ID = 'assistant';

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

export default function ChatScreen() {
  const scrollRef = useRef(null);
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
        onPress: () => setMessages([])
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
      const history = messages.map(item => ({
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
      Alert.alert('发送失败', error?.message || '请检查 API 配置或网络连接。');
      setMessages(current => current.filter(item => item.id !== pendingAssistantMessage.id));
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
          messages.map(message => <MessageBubble key={message.id} message={message} />)
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
