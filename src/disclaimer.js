import React from 'react';
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

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

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.65)',
    justifyContent: 'center',
    padding: 24,
  },
  sheet: {
    backgroundColor: '#232338',
    borderRadius: 16,
    padding: 18,
    maxHeight: '75%',
    borderWidth: 1,
    borderColor: '#35354f',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 8,
  },
  title: { color: '#fff', fontSize: 16, fontWeight: '800', marginBottom: 12 },
  body: { flexGrow: 0 },
  text: { color: '#cfcbe6', fontSize: 14, lineHeight: 22 },
  button: {
    backgroundColor: '#6c63ff',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 16,
    shadowColor: '#6c63ff',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
    elevation: 4,
  },
  buttonText: { color: '#fff', fontWeight: '800' },
});
