// 密钥输入框：带明文/密文显隐切换。API / 生图 / 向量 / GitHub 四处密钥共用。
import React, { useState } from 'react';
import { TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { TextField } from '../ui/index.js';

export default function SecretTextField({ value, onChangeText, placeholder, onEndEditing, theme, styles }) {
  const [visible, setVisible] = useState(false);
  return (
    <View style={styles.secretRow}>
      <TextField
        value={value}
        onChangeText={onChangeText}
        onEndEditing={onEndEditing}
        placeholder={placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={!visible}
        style={styles.secretInput}
      />
      <TouchableOpacity
        style={styles.secretToggle}
        onPress={() => setVisible(next => !next)}
        activeOpacity={0.7}
        accessibilityLabel={visible ? '隐藏密钥' : '显示密钥'}
      >
        <Ionicons name={visible ? 'eye-off-outline' : 'eye-outline'} size={17} color={theme.colors.textMuted} />
      </TouchableOpacity>
    </View>
  );
}
