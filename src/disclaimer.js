import React, { useMemo } from 'react';
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { useTheme } from './theme/ThemeContext';

export const DISCLAIMER_TEXT =
  'EasyChat2 是一个开源 AI 聊天工具，仅供学习交流使用。\n\n'
  + '本应用面向成年人，禁止未成年人下载、安装或使用。\n\n'
  + '用户自行配置 API 端点与密钥，所有聊天内容直发到用户指定的服务地址。\n\n'
  + '开发者不对用户使用本应用产生的任何后果负责，包括但不限于：\n'
  + '- 第三方服务中断或数据泄露\n'
  + '- 因配置错误导致的安全问题\n'
  + '- 生成的任何内容的准确性、合法性\n\n'
  + '使用即代表同意以上条款。';

export default function DisclaimerModal({ visible, title = '免责条款', content = DISCLAIMER_TEXT, onClose }) {
  const { theme, fonts } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts), [theme, fonts]);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.title}>{title}</Text>
          <ScrollView style={styles.body}>
            <Text style={styles.text}>{content}</Text>
          </ScrollView>
          <TouchableOpacity style={styles.button} onPress={onClose} activeOpacity={0.8}>
            <Text style={styles.buttonText}>我知道了</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const createStyles = (theme, fonts) => StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.65)',
    justifyContent: 'center',
    padding: 24,
  },
  sheet: {
    backgroundColor: theme.colors.surface,
    borderRadius: 16,
    padding: 18,
    maxHeight: '75%',
    borderWidth: 1,
    borderColor: theme.colors.divider,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 8,
  },
  title: { color: theme.colors.text, fontSize: fonts.scaled(16), fontWeight: '800', marginBottom: 12 },
  body: { flexGrow: 0 },
  text: { color: theme.colors.textMuted, fontSize: fonts.scaled(14), lineHeight: fonts.scaled(22) },
  button: {
    backgroundColor: theme.colors.primary,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
    elevation: 4,
  },
  buttonText: { color: theme.colors.primaryContrast, fontWeight: '800' },
});
