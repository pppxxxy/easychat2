// 系统报错气泡。从 src/ChatScreen.js 原样外提（无行为变化）。

import React, { useCallback, useMemo, useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';

import { maskSecrets } from '../storage/secrets.js';
import { useTheme } from '../theme/ThemeContext.js';
import { createChatStyles } from './chatStyles.js';

export default function ErrorBubble({ message, rawError, onCopied, fullWidth, selectionMode, selected }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createChatStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(async () => {
    const payload = maskSecrets(rawError || message.detail || message.text || '');
    try {
      await Clipboard.setStringAsync(payload);
      setCopied(true);
      onCopied?.();
      setTimeout(() => setCopied(false), 1500);
    } catch (error) {}
  }, [message.detail, message.text, onCopied, rawError]);

  return (
     <View style={[
       styles.messageRow,
       fullWidth ? styles.messageRowFullWidth : styles.messageRowLeft,
     ]}>
      <View style={[
        styles.bubble,
         fullWidth ? styles.bubbleFullWidth : styles.bubbleBounded,
         fullWidth ? styles.errorBubbleFullWidth : styles.errorBubbleBounded,
        selected ? styles.bubbleSelected : null,
      ]}>
        <Text style={styles.errorBadge}>系统报错</Text>
        <TouchableOpacity onPress={() => setExpanded(current => !current)} activeOpacity={0.8}>
          <Text style={styles.errorSummary}>请求失败，点击查看详情</Text>
        </TouchableOpacity>
        {expanded ? (
          <Text style={styles.errorDetail} selectable>
            {maskSecrets(message.detail || message.text || '')}
          </Text>
        ) : null}
        {!selectionMode ? (
          <View style={styles.errorActions}>
            <TouchableOpacity style={styles.copyButton} onPress={onCopy}>
              <Text style={styles.copyButtonText}>{copied ? '已复制' : '复制报错'}</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </View>
    </View>
  );
}
