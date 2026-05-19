import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

export default function CharacterScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>角色</Text>
      <Text style={styles.text}>角色管理功能已预留，后续可以继续扩展角色设定、世界书和导入导出。</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1a1a2e', padding: 20 },
  title: { color: '#fff', fontSize: 24, fontWeight: '800', marginBottom: 12 },
  text: { color: '#ccc', fontSize: 16, lineHeight: 24 }
});
