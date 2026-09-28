import React, { useMemo } from 'react';
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import ChapterSections from './ChapterSections.js';
import { useTheme } from './theme/ThemeContext.js';

export const DISCLAIMER_TEXT =
  'EasyChat2 是一个开源 AI 聊天工具，仅供学习交流使用。\n\n'
  + '适用人群与法律合规告知：根据《生成式人工智能服务管理暂行办法》《未成年人网络保护条例》等相关法律法规，'
  + '本应用作为拟人化 AI 互动服务，依法不向未成年人提供虚拟伴侣、虚拟亲属等亲密关系类服务；'
  + '向不满十四周岁未成年人提供其他拟人化互动服务的，应当取得监护人同意。用户应自行确认其使用行为符合所在地法律法规。\n\n'
  + '本告知为法律合规声明，不构成对 Apache-2.0 许可证条款的修改或附加限制；本应用仍以 Apache-2.0 授权。\n\n'
  + '用户自行配置 API 端点与密钥，所有聊天内容直发到用户指定的服务地址。\n\n'
  + '请仅使用各平台官方提供的 API 服务。EasyChat2 不提供任何共享 API Key、代理地址、中转接口或非官方接口。'
  + '使用非官方渠道、共享密钥或代理服务产生的一切后果，由用户自行承担。\n\n'
  + 'AI 生成内容标识：AI 生成或改写的角色卡与界面内容带有「本内容由 AI 生成」标识，'
  + '导出文件的元数据中内嵌生成属性信息，可被识别与追溯。'
  + '用户不得擅自删除、篡改或隐匿 AI 生成标识后对外传播，由此产生的责任由用户自行承担。'
  + 'AI 生成的角色卡仅供个人虚构创作与测试使用，不得用于商业用途，'
  + '不得用于生成违法、不良或侵害第三方权益的内容。\n\n'
  + '技术局限告知：受限于现有技术，AI 生成的内容可能不准确、不完整，或与已有作品存在相似性，'
  + '用户应在使用前自行审核并确认有权使用相关内容。\n\n'
  + '开发者不对用户使用本应用产生的任何后果负责，包括但不限于：\n'
  + '- 第三方服务中断或数据泄露\n'
  + '- 因配置错误导致的安全问题\n'
  + '- 生成的任何内容的准确性、合法性——用户对 AI 生成内容的真实性、合法性、准确性自行承担全部责任\n\n'
  + '使用即代表同意以上条款。';

// 结构化条款：与 DISCLAIMER_TEXT 同源，便于弹窗与教学章分节展示。
export const DISCLAIMER_SECTIONS = [
  {
    title: '应用性质',
    icon: 'information-circle-outline',
    body: 'EasyChat2 是一个开源 AI 聊天工具，仅供学习交流使用。',
  },
  {
    title: '适用人群与法律合规告知',
    icon: 'shield-outline',
    body: '根据《生成式人工智能服务管理暂行办法》《未成年人网络保护条例》等相关法律法规，本应用作为拟人化 AI 互动服务，'
      + '依法不向未成年人提供虚拟伴侣、虚拟亲属等亲密关系类服务；向不满十四周岁未成年人提供其他拟人化互动服务的，'
      + '应当取得监护人同意。用户应自行确认其使用行为符合所在地法律法规。',
    bullets: [
      '本告知为法律合规声明，不构成对 Apache-2.0 许可证条款的修改或附加限制；本应用仍以 Apache-2.0 授权。',
    ],
  },
  {
    title: '数据与配置',
    icon: 'server-outline',
    body: '用户自行配置 API 端点与密钥，所有聊天内容直发到用户指定的服务地址。',
    bullets: [
      '请仅使用各平台官方提供的 API 服务。EasyChat2 不提供任何共享 API Key、代理地址、中转接口或非官方接口。',
      '使用非官方渠道、共享密钥或代理服务产生的一切后果，由用户自行承担。',
    ],
  },
  {
    title: 'AI 生成内容标识',
    icon: 'sparkles-outline',
    body: 'AI 生成或改写的角色卡与界面内容带有「本内容由 AI 生成」标识，导出文件的元数据中内嵌生成属性信息，可被识别与追溯。',
    bullets: [
      '不得擅自删除、篡改或隐匿 AI 生成标识后对外传播，由此产生的责任由用户自行承担。',
      'AI 生成的角色卡仅供个人虚构创作与测试使用，不得用于商业用途，不得用于生成违法、不良或侵害第三方权益的内容。',
    ],
  },
  {
    title: '技术局限告知',
    icon: 'warning-outline',
    body: '受限于现有技术，AI 生成的内容可能不准确、不完整，或与已有作品存在相似性，用户应在使用前自行审核并确认有权使用相关内容。',
  },
  {
    title: '免责范围',
    icon: 'shield-outline',
    body: '开发者不对用户使用本应用产生的任何后果负责，包括但不限于：',
    bullets: [
      '第三方服务中断或数据泄露',
      '因配置错误导致的安全问题',
      '生成的任何内容的准确性、合法性——用户对 AI 生成内容的真实性、合法性、准确性自行承担全部责任',
    ],
  },
  {
    title: '条款同意',
    icon: 'checkmark-circle-outline',
    body: '使用即代表同意以上条款。',
  },
];

export default function DisclaimerModal({ visible, title = '免责条款', content = DISCLAIMER_TEXT, sections, onClose }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const list = Array.isArray(sections)
    ? sections
    : (content === DISCLAIMER_TEXT ? DISCLAIMER_SECTIONS : null);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.title}>{title}</Text>
          <ScrollView style={styles.body}>
            {list ? (
              <ChapterSections sections={list} />
            ) : (
              <Text style={styles.text}>{content}</Text>
            )}
          </ScrollView>
          <TouchableOpacity style={styles.button} onPress={onClose} activeOpacity={0.8}>
            <Text style={styles.buttonText}>我知道了</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.65)',
    justifyContent: 'center',
    padding: 24,
  },
  sheet: {
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.radius.lg,
    padding: 18,
    maxHeight: '75%',
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.divider,
    ...tokens.elevation(2, theme),
  },
  title: { color: theme.colors.text, fontSize: fonts.scaled(16), fontWeight: '800', marginBottom: 12 },
  body: { flexGrow: 0 },
  text: { color: theme.colors.textMuted, fontSize: fonts.scaled(14), lineHeight: fonts.scaled(22) },
  button: {
    backgroundColor: theme.colors.primary,
    borderRadius: tokens.metrics.buttonRadius,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 16,
    ...tokens.elevation(3, theme),
  },
  buttonText: { color: theme.colors.primaryContrast, fontWeight: '800' },
});
