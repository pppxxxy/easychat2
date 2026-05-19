import React, { useCallback, useState } from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Bubble, GiftedChat, Send } from 'react-native-gifted-chat';

import { sendChatMessage } from './api';

const USER_ID = 1;
const ASSISTANT_ID = 2;

export default function ChatScreen() {
  const [messages, setMessages] = useState([]);
  const [isTyping, setIsTyping] = useState(false);

  const onSend = useCallback(async (newMessages = []) => {
    if (!newMessages.length || isTyping) return;

    const userMsg = newMessages[0];
    const botId = `${Date.now()}-bot`;
    const botPlaceholder = {
      _id: botId,
      text: '',
      createdAt: new Date(Date.now() + 1),
      user: { _id: ASSISTANT_ID, name: '助手' }
    };

    setMessages(prev => GiftedChat.append(prev, newMessages));
    setMessages(prev => GiftedChat.append(prev, [botPlaceholder]));
    setIsTyping(true);

    try {
      const history = [...messages].reverse().map(item => ({
        role: item.user?._id === USER_ID ? 'user' : 'assistant',
        content: item.text
      }));
      const reply = await sendChatMessage([
        { role: 'system', content: '你是 EasyChat2 的智能助手，回答简洁清晰。' },
        ...history,
        { role: 'user', content: userMsg.text }
      ]);
      setMessages(prev => prev.map(item => item._id === botId ? { ...item, text: reply } : item));
    } catch (error) {
      Alert.alert('发送失败', error.message);
      setMessages(prev => prev.filter(item => item._id !== botId));
    } finally {
      setIsTyping(false);
    }
  }, [isTyping, messages]);

  return (
    <View style={styles.container}>
      <GiftedChat
        messages={messages}
        onSend={onSend}
        user={{ _id: USER_ID, name: '我' }}
        isTyping={isTyping}
        placeholder="输入消息..."
        renderBubble={props => (
          <Bubble
            {...props}
            wrapperStyle={{ right: { backgroundColor: '#6c63ff' }, left: { backgroundColor: '#2d2d44' } }}
            textStyle={{ right: { color: '#fff' }, left: { color: '#f4f4ff' } }}
          />
        )}
        renderSend={props => (
          <Send {...props}>
            <View style={styles.sendButton}>
              <Text style={styles.sendText}>发送</Text>
            </View>
          </Send>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1a1a2e' },
  sendButton: { paddingHorizontal: 14, paddingVertical: 9, marginRight: 8, marginBottom: 6, borderRadius: 18, backgroundColor: '#6c63ff' },
  sendText: { color: '#fff', fontWeight: '700' }
});
