// AS2：ConfirmFlow 的界面（对话流内的题卡组，ConfirmBar 同款形态）。
//
// 为什么是对话流内联而不是 Modal：① 与 ConfirmBar 同一套「问什么就留在它问的那件事
// 旁边」的纪律；② 刚修的 R6 教训——列表/滚动塞进弹窗背景层是 Android 手势雷区，
// 内联卡组（≤4 题）根本不需要滚动，雷区直接消失。
//
// 纯展示组件：不持有待确认状态，宿主决定「现在在等哪一次确认」（与 ConfirmBar 同款分工）。
// 每题渲染 [是][否][其他?]；「其他」按 type 展开成候选列表 / 预填输入框 / 空输入框。
// 全部作答才允许提交（提交按钮在缺答时禁用并提示还差哪题）——半截答案回给模型只会
// 让它猜。关掉/取消 = 整卡作废（宿主按「未确认」处理）。

import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../../theme/ThemeContext.js';
import { useTranslation } from '../../i18n/I18nContext.js';

// 每题的作答状态：{ answer: '' | 'yes' | 'no' | 'custom', custom: string }
function emptyAnswers(questions) {
  const map = {};
  (Array.isArray(questions) ? questions : []).forEach(question => {
    map[question.id] = { answer: '', custom: question.other && question.other.type === 'edit'
      ? String(question.other.prefill || '')
      : '' };
  });
  return map;
}

export default function ConfirmFlowSheet({
  questions,
  busy = false,
  onSubmit,
  onCancel,
}) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const list = Array.isArray(questions) ? questions : [];
  const [answers, setAnswers] = useState(() => emptyAnswers(list));
  const [openOther, setOpenOther] = useState({});

  // 题卡换了（宿主复用了组件）：重置作答与展开态，否则会把上一卡的答案带到新卡上。
  const signature = list.map(item => `${item.id}:${item.text}`).join('|');
  const [lastSignature, setLastSignature] = useState(signature);
  if (signature !== lastSignature) {
    setLastSignature(signature);
    setAnswers(emptyAnswers(list));
    setOpenOther({});
  }

  const patch = (id, next) => setAnswers(current => ({ ...current, [id]: { ...current[id], ...next } }));

  // 提交结算（对齐纯模块 validateConfirmAnswers 的语义）：选了是/否用选择；
  // 没选但输入框里有字（含 edit 预填）→ 视作「其他：<原文>」。为什么在提交时归一：
  // 多行输入的 onEndEditing 在「点提交按钮」时不必然触发（Android 不必然先失焦），
  // 只靠它把 answer 置成 custom 会出现「改了字却被告知还有题没答」的假缺口。
  const settled = list.map(question => {
    const state = answers[question.id] || {};
    if (state.answer === 'yes' || state.answer === 'no') {
      return { id: question.id, answer: state.answer };
    }
    const text = String(state.custom || '').trim();
    return text ? { id: question.id, answer: 'custom', custom: text } : null;
  });
  const complete = list.length > 0 && settled.every(item => item !== null);
  const missingCount = settled.filter(item => item === null).length;

  const submit = () => {
    if (!complete || busy) return;
    onSubmit(settled);
  };

  const pickCustom = (question, value) => {
    patch(question.id, { answer: 'custom', custom: value });
    setOpenOther(current => ({ ...current, [question.id]: false }));
  };

  return (
    <View style={styles.card}>
      {list.map((question, index) => {
        const state = answers[question.id] || { answer: '', custom: '' };
        const expanded = openOther[question.id] === true;
        const other = question.other || { type: 'free' };
        return (
          <View key={question.id} style={styles.question}>
            <Text style={styles.questionText}>
              {list.length > 1 ? `${index + 1}. ${question.text}` : question.text}
            </Text>
            <View style={styles.row}>
              <TouchableOpacity
                style={[styles.choice, state.answer === 'yes' && styles.choiceActive]}
                onPress={() => patch(question.id, { answer: 'yes' })}
                disabled={busy}
                accessibilityRole="button"
                accessibilityState={{ selected: state.answer === 'yes' }}
              >
                <Text style={[styles.choiceText, state.answer === 'yes' && styles.choiceTextActive]}>
                  {t('workspace.confirmFlow.yes')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.choice, state.answer === 'no' && styles.choiceActive]}
                onPress={() => patch(question.id, { answer: 'no' })}
                disabled={busy}
                accessibilityRole="button"
                accessibilityState={{ selected: state.answer === 'no' }}
              >
                <Text style={[styles.choiceText, state.answer === 'no' && styles.choiceTextActive]}>
                  {t('workspace.confirmFlow.no')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.otherToggle, expanded && styles.otherToggleActive]}
                onPress={() => setOpenOther(current => ({ ...current, [question.id]: !current[question.id] }))}
                disabled={busy}
                accessibilityRole="button"
                accessibilityState={{ expanded }}
              >
                <Text style={[styles.choiceText, expanded && styles.choiceTextActive]}>
                  {state.answer === 'custom' ? t('workspace.confirmFlow.customChosen') : t('workspace.confirmFlow.other')}
                </Text>
                <Ionicons
                  name={expanded ? 'chevron-up' : 'chevron-down'}
                  size={13}
                  color={theme.colors.textFaint}
                  accessibilityElementsHidden
                  importantForAccessibility="no"
                />
              </TouchableOpacity>
            </View>

            {expanded ? (
              other.type === 'list' && other.options && other.options.length > 0 ? (
                // 候选列表：自带滚动 + maxHeight（题卡多/选项长都不撑破对话流）。
                <ScrollView style={styles.optionList} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                  {other.options.map(option => (
                    <TouchableOpacity
                      key={option.id}
                      style={styles.optionRow}
                      onPress={() => pickCustom(question, option.label)}
                      disabled={busy}
                      accessibilityRole="button"
                    >
                      <Text style={styles.optionText} numberOfLines={2} ellipsizeMode="middle">{option.label}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              ) : (
                <TextInput
                  style={styles.input}
                  value={state.custom}
                  onChangeText={value => patch(question.id, { custom: value })}
                  onEndEditing={() => {
                    if (String(state.custom || '').trim()) patch(question.id, { answer: 'custom' });
                  }}
                  placeholder={other.type === 'free'
                    ? (other.placeholder || t('workspace.confirmFlow.freePlaceholder'))
                    : t('workspace.confirmFlow.editPlaceholder')}
                  placeholderTextColor={theme.colors.textFaint}
                  multiline
                  keyboardShouldPersistTaps="handled"
                />
              )
            ) : null}
          </View>
        );
      })}

      <View style={styles.footer}>
        <TouchableOpacity style={styles.cancel} onPress={onCancel} disabled={busy} accessibilityRole="button">
          <Text style={styles.cancelText}>{t('common.cancel')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.submit, (!complete || busy) && styles.disabled]}
          onPress={submit}
          disabled={!complete || busy}
          accessibilityRole="button"
        >
          <Text style={styles.submitText}>{t('workspace.confirmFlow.submit')}</Text>
        </TouchableOpacity>
      </View>
      {!complete && missingCount > 0 ? (
        <Text style={styles.hint}>{t('workspace.confirmFlow.missing', { count: missingCount })}</Text>
      ) : null}
    </View>
  );
}

function createStyles(theme, fonts, tokens) {
  return StyleSheet.create({
    card: {
      marginHorizontal: 12,
      marginBottom: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderRadius: tokens.radius.md,
      backgroundColor: theme.colors.surfaceAlt,
      borderWidth: tokens.border.thin,
      borderColor: theme.colors.primaryMutedAlpha(0.5),
    },
    question: { marginBottom: 10 },
    questionText: { color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '600', lineHeight: fonts.scaled(18) },
    row: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 8, gap: 8 },
    choice: {
      paddingHorizontal: 14,
      paddingVertical: 6,
      borderRadius: tokens.radius.sm,
      borderWidth: tokens.border.thin,
      borderColor: theme.colors.surfaceBorder,
    },
    otherToggle: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: tokens.radius.sm,
      borderWidth: tokens.border.thin,
      borderColor: theme.colors.surfaceBorder,
      gap: 4,
    },
    choiceActive: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
    otherToggleActive: { borderColor: theme.colors.primary },
    choiceText: { color: theme.colors.textMuted, fontSize: fonts.scaled(12.5), fontWeight: '600' },
    choiceTextActive: { color: theme.colors.primaryContrast },
    optionList: { maxHeight: 200, marginTop: 8 },
    optionRow: {
      paddingVertical: 8,
      paddingHorizontal: 10,
      borderRadius: tokens.radius.sm,
      backgroundColor: theme.colors.surface,
      marginBottom: 6,
    },
    optionText: { color: theme.colors.text, fontSize: fonts.scaled(12.5) },
    input: {
      marginTop: 8,
      minHeight: 44,
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderRadius: tokens.radius.sm,
      borderWidth: tokens.border.thin,
      borderColor: theme.colors.surfaceBorder,
      backgroundColor: theme.colors.surface,
      color: theme.colors.text,
      fontSize: fonts.scaled(13),
    },
    footer: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 10 },
    cancel: { paddingHorizontal: 10, paddingVertical: 6 },
    cancelText: { color: theme.colors.textMuted, fontSize: fonts.scaled(12.5), fontWeight: '600' },
    submit: {
      paddingHorizontal: 14,
      paddingVertical: 7,
      borderRadius: tokens.radius.sm,
      backgroundColor: theme.colors.primary,
    },
    submitText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(12.5), fontWeight: '700' },
    disabled: { opacity: 0.5 },
    hint: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginTop: 6, textAlign: 'right' },
  });
}
