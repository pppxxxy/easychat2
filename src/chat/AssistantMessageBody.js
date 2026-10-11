import React, { useMemo } from 'react';
import { Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import Markdown from 'react-native-markdown-display';
import RenderHtml from 'react-native-render-html';

import {
  collectTNodeText,
  createHtmlBaseStyle,
  createHtmlTagsStyles,
  createMarkdownStyles,
  customHTMLElementModels,
  prepareAssistantHtml,
  regexClassesStyles,
  regexDomVisitors,
} from './assistantRender.js';
import { containsHtml } from './plainText.js';
import { clampMarkdownText } from './markdownGuard.js';
import { shouldRenderRichHtml, splitFullHtmlDocument } from './richHtml.js';
import RichHtmlMessage from './RichHtmlMessage.js';
import { useTheme } from '../theme/ThemeContext.js';

// 助手正文渲染：与聊天页共用 assistantRender 的配置，保证制卡预览看到的效果一致。
// 聊天页因气泡宽度/操作等耦合保留自己的 JSX，这里只服务预览等轻量场景。
export default function AssistantMessageBody({
  text,
  richHtmlEnabled = true,
  fullWidth = true,
  contentWidth: providedContentWidth = 0,
  onCommand,
  // 正文取色：缺省走聊天气泡的助手文字色（浅底深字）；在深底容器（工作区文件预览、
  // 制卡预览的气泡底色不同）里必须显式传，否则深底深字不可见。
  textColor,
}) {
  const { theme, fonts, tokens } = useTheme();
  const { width } = useWindowDimensions();
  const markdownStyles = useMemo(() => createMarkdownStyles(theme, fonts, tokens, textColor), [theme, fonts, tokens, textColor]);
  const htmlBaseStyle = useMemo(() => createHtmlBaseStyle(theme, fonts, textColor), [theme, fonts, textColor]);
  const htmlTagsStyles = useMemo(() => createHtmlTagsStyles(theme, fonts, textColor), [theme, fonts, textColor]);
  const contentWidth = providedContentWidth > 0
    ? providedContentWidth
    : (fullWidth ? Math.max(200, width - 48) : Math.max(200, Math.floor((width - 48) * 0.9)));

  const markdownRules = useMemo(() => ({
    code_block: (node, children, parent, ruleStyles, inheritedStyles) => {
      let content = typeof node.content === 'string' ? node.content : '';
      if (content.endsWith('\n')) content = content.slice(0, -1);
      return (
        <ScrollView key={node.key} horizontal showsHorizontalScrollIndicator={false} style={{ maxWidth: '100%' }}>
          <Text style={[inheritedStyles, ruleStyles.code_block]}>{content}</Text>
        </ScrollView>
      );
    },
    fence: (node, children, parent, ruleStyles, inheritedStyles) => {
      let content = typeof node.content === 'string' ? node.content : '';
      if (content.endsWith('\n')) content = content.slice(0, -1);
      return (
        <ScrollView key={node.key} horizontal showsHorizontalScrollIndicator={false} style={{ maxWidth: '100%' }}>
          <Text style={[inheritedStyles, ruleStyles.fence]}>{content}</Text>
        </ScrollView>
      );
    },
  }), []);

  const htmlRenderers = useMemo(() => ({
    button: ({ tnode }) => {
      const encoded = (tnode && tnode.attributes && tnode.attributes['data-command']) || '';
      let command = encoded;
      try {
        command = encoded ? decodeURIComponent(encoded) : '';
      } catch (error) {
        command = encoded;
      }
      const label = collectTNodeText(tnode).trim();
      const onPress = command && onCommand ? () => onCommand(command) : undefined;
      return (
        <Pressable
          onPress={onPress}
          style={{ marginTop: 6, borderRadius: tokens.radius.sm, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: theme.colors.panelButtonBg }}
        >
          <Text style={{ color: theme.colors.panelButtonText, fontSize: 13, lineHeight: 18 }}>{label}</Text>
        </Pressable>
      );
    },
  }), [onCommand, theme.colors.panelButtonBg, theme.colors.panelButtonText, tokens.radius.sm]);

  const renderHtml = containsHtml(text);
  const renderRichHtml = renderHtml && shouldRenderRichHtml(text, richHtmlEnabled);
  const richHtmlParts = useMemo(
    () => (renderRichHtml ? splitFullHtmlDocument(text) : null),
    [text, renderRichHtml]
  );

  const renderSegment = segment => {
    const value = String(segment || '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (!value) return null;
    if (!containsHtml(value)) {
      // 截断超长文本再交给 markdown-it，防 linkify-it ReDoS 卡死。
      const { text: safeText } = clampMarkdownText(value);
      return <Markdown style={markdownStyles} rules={markdownRules}>{safeText}</Markdown>;
    }
    return (
      <RenderHtml
        contentWidth={contentWidth}
        source={{ html: prepareAssistantHtml(value).replace(/\n/g, '<br/>') }}
        baseStyle={htmlBaseStyle}
        tagsStyles={htmlTagsStyles}
        classesStyles={regexClassesStyles}
        domVisitors={regexDomVisitors}
        customHTMLElementModels={customHTMLElementModels}
        renderers={htmlRenderers}
        defaultTextProps={{ selectable: true }}
      />
    );
  };

  if (renderRichHtml) {
    return richHtmlParts ? (
      <View>
        {renderSegment(richHtmlParts.before)}
        <RichHtmlMessage
          html={richHtmlParts.document}
          onCommand={(command, token) => onCommand && onCommand(command, token)}
          fullWidth={fullWidth}
          allowFullscreenVideo
        />
        {renderSegment(richHtmlParts.after)}
      </View>
    ) : (
      <RichHtmlMessage
        html={text}
        onCommand={(command, token) => onCommand && onCommand(command, token)}
        fullWidth={fullWidth}
        allowFullscreenVideo
      />
    );
  }

  if (renderHtml) {
    return (
      <RenderHtml
        contentWidth={contentWidth}
        source={{ html: prepareAssistantHtml(text) }}
        baseStyle={htmlBaseStyle}
        tagsStyles={htmlTagsStyles}
        classesStyles={regexClassesStyles}
        domVisitors={regexDomVisitors}
        customHTMLElementModels={customHTMLElementModels}
        renderers={htmlRenderers}
        defaultTextProps={{ selectable: true }}
      />
    );
  }

  const plainMarkdown = clampMarkdownText(text).text;
  return <Markdown style={markdownStyles} rules={markdownRules}>{plainMarkdown}</Markdown>;
}
