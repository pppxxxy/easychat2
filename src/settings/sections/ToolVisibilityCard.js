// 设置页「工具使用提示」分区：总开关 + 按工具的开关。
//
// 需求：可按工具隐藏聊天页「使用了某工具」的提示（工具过程气泡），总开关一键全隐藏。
//
// 单一来源（本仓库的铁律，已被咬过六次以上）：
//   工具清单从 chat/chatTools.js 的**定义清单**派生（listChatToolDefinitions），
//   与 registerChatTools 同源。新增一个聊天工具时，这里的开关自动出现——
//   不需要、也不允许在设置页手抄第二份名字清单。
//
// 两条边界必须讲给用户听（否则「隐藏了却还是弹确认」会被当成 bug）：
//   1. 审批/确认弹层不受影响——需要点头的工具照常询问（隐藏它 = 工具静默执行）；
//   2. 失败提示不受影响——工具出错/超时/被拒照常显示。
//   两条的判定实现在 chat/toolNoticeVisibility.js，本组件不重复实现，
//   而是直接调 isToolNoticeHidden 取「当前生效状态」，界面与运行时判定因此不可能漂移。

import React from 'react';
import { Switch, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { FieldHint, FieldLabel } from '../../ui/index.js';
import CollapsibleHint from '../CollapsibleHint.js';
import { listChatToolDefinitions } from '../../chat/chatTools.js';
import { toolLabelKey } from '../../chat/toolBubbleView.js';
import { isToolNoticeHidden } from '../../chat/toolNoticeVisibility.js';

export default function ToolVisibilityCard(props) {
  const { styles, theme, t, chatOptions, updateChatOption } = props;
  const hideAll = chatOptions.hideAllToolNotices === true;
  const hidden = chatOptions.hiddenToolNotices || {};
  const tools = listChatToolDefinitions().map(definition => ({
    name: definition.name,
    // 未登记文案的工具回落到原始工具名：宁可显示得难看，也不吞掉一个开关。
    label: toolLabelKey(definition.name) ? t(toolLabelKey(definition.name)) : definition.name,
  }));
  const toggleTool = (name, value) => {
    const next = { ...hidden };
    if (value) next[name] = true;
    else delete next[name];
    updateChatOption('hiddenToolNotices', next);
  };
  return (
    <>
      <FieldLabel style={styles.label}>{t('settings.toolNotice.sectionTitle')}</FieldLabel>
      <View style={styles.capabilityRow}>
        <View style={styles.linkLeft}>
          <Ionicons name="eye-off-outline" size={17} color={theme.colors.primaryMuted} />
          <Text style={styles.linkText}>{t('settings.toolNotice.hideAll')}</Text>
        </View>
        <Switch
          value={hideAll}
          onValueChange={value => updateChatOption('hideAllToolNotices', value)}
          accessibilityLabel={t('settings.toolNotice.hideAll')}
          trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
          thumbColor={theme.colors.primaryContrast}
        />
      </View>
      <CollapsibleHint>{t('settings.toolNotice.hideAllHint')}</CollapsibleHint>
      {tools.map(tool => {
        // 生效状态直接问判定层（总开关打开时一律为「全部隐藏」），界面不自算。
        const effective = isToolNoticeHidden(tool.name, chatOptions);
        const stateText = hideAll
          ? t('settings.toolNotice.stateHiddenByAll')
          : (effective ? t('settings.toolNotice.stateHidden') : t('settings.toolNotice.stateVisible'));
        return (
          <View key={tool.name} style={styles.capabilityRow}>
            <View style={styles.linkLeft}>
              <Ionicons name="pricetag-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>{tool.label}</Text>
            </View>
            <Text style={styles.linkValue}>{stateText}</Text>
            <Switch
              value={effective}
              // 总开关打开时单项开关只作展示（值恒为「隐藏」），避免出现「总开关开着
              // 却有一项显示为关」的自相矛盾状态。
              disabled={hideAll}
              onValueChange={value => toggleTool(tool.name, value)}
              accessibilityLabel={tool.label}
              trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
              thumbColor={theme.colors.primaryContrast}
            />
          </View>
        );
      })}
      <FieldHint style={styles.hint}>{t('settings.toolNotice.boundaryHint')}</FieldHint>
    </>
  );
}
