// 长说明的二段式呈现：默认只显示「灰字小号 + info 图标」的一行，点按才展开完整说明。
// 用于开关行后那些 50+ 字的长 hint，避免折叠展开后一屏被说明文字淹没。
import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';

export default function CollapsibleHint({ children, style, label }) {
  const { theme, fonts } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts), [theme, fonts]);
  const [open, setOpen] = useState(false);
  const text = label || t('common.hintLabel');
  return (
    <View style={style}>
      <TouchableOpacity
        style={styles.row}
        onPress={() => setOpen(value => !value)}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={open ? t('common.collapse', { label: text }) : t('common.expand', { label: text })}
      >
        <Ionicons
          name={open ? 'information-circle' : 'information-circle-outline'}
          size={14}
          color={theme.colors.textFaint}
        />
        <Text style={styles.label}>{open ? t('common.collapse', { label: text }) : text}</Text>
      </TouchableOpacity>
      {open ? <Text style={styles.text}>{children}</Text> : null}
    </View>
  );
}

const createStyles = (theme, fonts) => StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
    marginTop: 2,
    marginBottom: 2,
  },
  label: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(12),
    marginLeft: 4,
  },
  text: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(12),
    lineHeight: fonts.scaled(18),
    marginTop: 2,
    marginBottom: 4,
  },
});
