// 消息气泡与文本高亮。从 src/ChatScreen.js 原样外提（无行为变化）。

import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import Ionicons from '@expo/vector-icons/Ionicons';
import Markdown from 'react-native-markdown-display';
import RenderHtml from 'react-native-render-html';

import { collectTNodeText, createHtmlBaseStyle, createHtmlTagsStyles, createMarkdownStyles, customHTMLElementModels, prepareAssistantHtml, regexClassesStyles, regexDomVisitors } from '../assistantRender.js';
import { containsHtml, messageCopyText } from '../plainText.js';
import { shouldRenderRichHtml, splitFullHtmlDocument } from '../richHtml.js';
import RichHtmlMessage from '../RichHtmlMessage.js';
import { useTheme } from '../theme/ThemeContext.js';
import { USER_ID } from './chatConstants.js';
import { createChatStyles } from './chatStyles.js';
import ThinkingIndicator from './ThinkingIndicator.js';

function renderHighlightedText(text, keyword, styles) {
  const source = String(text || '');
  const needle = String(keyword || '');
  if (!needle) return source;
  const lowerSource = source.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const parts = [];
  let index = 0;
  let count = 0;
  while (index < source.length) {
    const found = lowerSource.indexOf(lowerNeedle, index);
    if (found < 0) {
      parts.push(source.slice(index));
      break;
    }
    if (found > index) parts.push(source.slice(index, found));
    parts.push(
      <Text key={`hl-${count}`} style={styles.highlightText}>
        {source.slice(found, found + needle.length)}
      </Text>
    );
    count += 1;
    index = found + needle.length;
  }
  return parts;
}


const MessageBubble = React.memo(function MessageBubble({ message, rawText, characterName, characterAvatar, userAvatarUri, onSlashCommand, canRegenerate, onRegenerate, onEditUserMessage, onSelectText, onQuote, onPressQuote, onGenerateImage, onBroadcast, highlightKeyword, isMatch, isActiveMatch, fullWidth, thinkingDisplay, overlayActions, richHtmlEnabled, onReselectGreeting, onStartSelection, selectionMode, selected }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createChatStyles(theme, fonts, tokens), [theme, fonts, tokens]);
   const markdownStyles = useMemo(() => createMarkdownStyles(theme, fonts, tokens), [theme, fonts, tokens]);
   const markdownRules = useMemo(() => {
     const codeRule = (node, children, parent, ruleStyles, inheritedStyles, styleKey) => {
       let content = typeof node.content === 'string' ? node.content : '';
       if (content.endsWith('\n')) content = content.slice(0, -1);
       return (
         <ScrollView
           key={node.key}
           horizontal
           showsHorizontalScrollIndicator={false}
           style={styles.markdownCodeScroll}
         >
           <Text style={[inheritedStyles, ruleStyles[styleKey]]}>{content}</Text>
         </ScrollView>
       );
     };
     return {
       code_block: (node, children, parent, ruleStyles, inheritedStyles) => (
         codeRule(node, children, parent, ruleStyles, inheritedStyles, 'code_block')
       ),
       fence: (node, children, parent, ruleStyles, inheritedStyles) => (
         codeRule(node, children, parent, ruleStyles, inheritedStyles, 'fence')
       ),
       table: (node, children, parent, ruleStyles) => (
         <ScrollView
           key={node.key}
           horizontal
           showsHorizontalScrollIndicator={false}
           style={styles.markdownTableScroll}
         >
           <View style={ruleStyles._VIEW_SAFE_table}>{children}</View>
         </ScrollView>
       ),
     };
   }, [styles.markdownCodeScroll, styles.markdownTableScroll]);
   const htmlBaseStyle = useMemo(() => createHtmlBaseStyle(theme, fonts), [theme, fonts]);
  const htmlTagsStyles = useMemo(() => createHtmlTagsStyles(theme, fonts), [theme, fonts]);
  const isUser = message.role === USER_ID;
  const isGreeting = !isUser && (message.kind === 'greeting' || String(message.id || '').startsWith('greeting-'));
  const { width } = useWindowDimensions();
  const [copied, setCopied] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [reasoningPinned, setReasoningPinned] = useState(false);
  const [reasoningExpanded, setReasoningExpanded] = useState(false);
  const renderHtml =
    !isUser && !message.pending && containsHtml(message.text);
  // 含 <style>/<script> 的助手消息用 WebView 渲染，才能还原样式与交互。
  const renderRichHtml =
    renderHtml && shouldRenderRichHtml(message.text, richHtmlEnabled);
  // 完整 HTML 文档之外的叙事正文拆出来走 Markdown，避免被 WebView 文档分支整段丢弃。
  const richHtmlParts = useMemo(
    () => (renderRichHtml ? splitFullHtmlDocument(message.text) : null),
    [message.text, renderRichHtml]
  );
   const plainText = messageCopyText(message.text);
   const availableMediaWidth = Math.max(96, Math.min(220, width - 80));
   const mediaWidth = message.image?.stickerId
     ? Math.min(112, availableMediaWidth)
     : availableMediaWidth;
  const mediaRatio = Number(message.image?.height) > 0 && Number(message.image?.width) > 0
    ? Number(message.image.height) / Number(message.image.width)
    : 0.75;
  const mediaHeight = message.image?.stickerId
    ? 112
    : Math.min(300, Math.max(120, Math.round(mediaWidth * mediaRatio)));
  const onCopy = useCallback(async () => {
    try {
      await Clipboard.setStringAsync(plainText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (error) {}
  }, [plainText]);
  const contentWidth = fullWidth
    ? Math.max(200, width - 28)
    : Math.max(200, Math.floor((width - 28) * 0.88) - 28);
  const htmlSource = useMemo(
    () => ({ html: prepareAssistantHtml(message.text) }),
    [message.text]
  );
  const htmlRenderers = useMemo(
    () => ({
      button: ({ tnode }) => {
        const encoded = (tnode && tnode.attributes && tnode.attributes['data-command']) || '';
        let command = encoded;
        try {
          command = encoded ? decodeURIComponent(encoded) : '';
        } catch (error) {
          command = encoded;
        }
        const label = collectTNodeText(tnode).trim();
        const onPress = command && onSlashCommand
      ? () => onSlashCommand(command, '', message && message.id)
      : undefined;
        return (
          <Pressable
            onPress={onPress}
            style={({ pressed }) => [
              styles.panelButton,
              pressed && onPress ? styles.panelButtonPressed : null,
            ]}
          >
            <Text style={styles.panelButtonText}>{label}</Text>
          </Pressable>
        );
      },
    }),
    [onSlashCommand]
  );

   const messageActionItems = [
      isGreeting && onReselectGreeting
        ? { key: 'reselect', label: '重选', icon: 'refresh-outline', onPress: onReselectGreeting }
        : null,
      {
        key: 'copy',
        label: copied ? '已复制' : '复制',
        icon: copied ? 'checkmark-outline' : 'copy-outline',
        onPress: onCopy,
      },
      { key: 'quote', label: '引用', icon: 'chatbubble-ellipses-outline', onPress: () => onQuote?.(message) },
      { key: 'select', label: '选择文本', icon: 'text-outline', onPress: () => onSelectText?.(plainText) },
      !isUser && onGenerateImage
        ? { key: 'image', label: '生成配图', icon: 'image-outline', onPress: () => onGenerateImage(message.id, message.text) }
        : null,
      isUser && onEditUserMessage
        ? { key: 'edit', label: '修改重发', icon: 'create-outline', onPress: () => onEditUserMessage(message.id) }
        : (!isUser && canRegenerate
          ? { key: 'regenerate', label: '重新生成', icon: 'reload-outline', onPress: () => onRegenerate?.(message.id) }
          : null),
      onStartSelection
        ? { key: 'select-message', label: '选择消息', icon: 'checkmark-circle-outline', onPress: onStartSelection }
        : null,
    ].filter(Boolean);

const fullWidthAssistant = !isUser && fullWidth;
   const avatarElement = isUser ? (
     <View style={styles.avatarContainerRight}>
      {userAvatarUri ? (
        <Image source={{ uri: userAvatarUri }} style={styles.avatarImage} />
      ) : (
        <View style={styles.avatarPlaceholderUser}>
          <Text style={styles.avatarPlaceholderText}>
            {'我'}
          </Text>
        </View>
      )}
    </View>
  ) : (
     <View style={[styles.avatarContainer, fullWidthAssistant && styles.avatarContainerFullWidth]}>
      {characterAvatar ? (
        <Image source={{ uri: characterAvatar }} style={styles.avatarImage} />
      ) : (
        <View style={styles.avatarPlaceholder}>
          <Text style={styles.avatarPlaceholderText}>
            {(characterName || '?').charAt(0)}
          </Text>
        </View>
      )}
    </View>
  );

   const assistantHeader = fullWidthAssistant ? (
     <View style={styles.fullWidthMessageHeader}>
       {avatarElement}
       <Text style={styles.fullWidthNameLabel}>{characterName || ''}</Text>
     </View>
   ) : null;

   // 完整 HTML 文档前/后的正文可能已被展示正则插入标签（高亮 span、容器 div），
   // 这类内容必须走 HTML 渲染，否则标签会被 Markdown 当纯文本原样显示。
   const renderAssistantSegment = segment => {
     // 卡片作者常把 /** 说明 **/ 写在 HTML 之外，展示时应剔除，不当作正文。
     const value = String(segment || '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
     if (!value) return null;
     if (!containsHtml(value)) {
       return <Markdown style={markdownStyles} rules={markdownRules}>{value}</Markdown>;
     }
     const source = { html: prepareAssistantHtml(value).replace(/\n/g, '<br/>') };
     return (
       <RenderHtml
         contentWidth={contentWidth}
         source={source}
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

   return (
     <View style={[
       styles.messageRow,
       isUser ? styles.messageRowRight : styles.messageRowLeft,
       fullWidthAssistant ? styles.messageRowFullWidth : null,
     ]}>
       {!isUser && !fullWidthAssistant ? avatarElement : null}
       <View style={[
         styles.messageContent,
         fullWidthAssistant
           ? styles.messageContentFullWidthColumn
           : ((fullWidth || renderRichHtml) ? styles.messageContentFullWidth : null),
       ]}>
         {fullWidthAssistant
           ? assistantHeader
           : (!isUser ? <Text style={styles.nameLabel}>{characterName || ''}</Text> : null)}
         <View style={[
          styles.bubble,
          (fullWidth || renderRichHtml) ? styles.bubbleFullWidth : styles.bubbleBounded,
          isUser ? styles.userBubble : styles.assistantBubble,
          message.image ? styles.mediaBubble : null,
          isMatch ? styles.bubbleMatch : null,
          isActiveMatch ? styles.bubbleActiveMatch : null,
          selected ? styles.bubbleSelected : null,
        ]}>
          {message.quoted && message.quoted.text ? (
            <TouchableOpacity
              style={[styles.quoteBlock, isUser ? styles.quoteBlockUser : styles.quoteBlockAssistant]}
              onPress={() => onPressQuote?.(message.quoted)}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel={`引用 ${message.quoted.name || ''}`}
            >
              <Text
                style={[styles.quoteName, isUser ? styles.quoteNameUser : styles.quoteNameAssistant]}
                numberOfLines={1}
              >
                {message.quoted.name || '原文'}
              </Text>
              <Text
                style={[styles.quoteText, isUser ? styles.quoteTextUser : styles.quoteTextAssistant]}
                numberOfLines={2}
              >
                {message.quoted.text}
              </Text>
            </TouchableOpacity>
          ) : null}
          {!isUser && thinkingDisplay !== 'off' && typeof message.reasoning === 'string' && message.reasoning.trim() ? (
            (() => {
              const thinking = !!message.pending && !!message.waitingForResponse;
              const expanded = reasoningPinned
                ? reasoningExpanded
                : (thinkingDisplay === 'open' && thinking);
              return (
                <TouchableOpacity
                  style={[styles.reasoningBox, !expanded && styles.reasoningBoxCollapsed]}
                  onPress={() => {
                    setReasoningExpanded(!expanded);
                    setReasoningPinned(true);
                  }}
                  activeOpacity={0.8}
                >
                  <View style={[styles.reasoningHeader, !expanded && styles.reasoningHeaderCollapsed]}>
                    <Ionicons name="bulb-outline" size={12} color={theme.colors.textFaint} />
                    <Text style={styles.reasoningLabel}>思考过程</Text>
                    <Ionicons
                      name={expanded ? 'chevron-up' : 'chevron-down'}
                      size={12}
                      color={theme.colors.textFaint}
                    />
                  </View>
                  {expanded ? (
                    <Text style={styles.reasoningText} selectable>{message.reasoning}</Text>
                  ) : null}
                </TouchableOpacity>
              );
            })()
          ) : null}
          {isUser && message.image?.uri ? (
            <View style={styles.userMediaBox}>
              <View>
                <Image
                  source={{ uri: message.image.uri }}
                  style={[styles.userMessageImage, { width: mediaWidth, height: mediaHeight }]}
                  resizeMode="contain"
                />
              </View>
              {message.image.stickerName ? (
                <Text style={styles.userMediaName} numberOfLines={1}>{message.image.stickerName}</Text>
              ) : null}
            </View>
          ) : isUser ? (
            <Text style={styles.messageText}>
              {highlightKeyword ? renderHighlightedText(message.text, highlightKeyword, styles) : message.text}
            </Text>
          ) : message.pending && message.waitingForResponse ? (
            <ThinkingIndicator />
          ) : renderRichHtml ? (
             richHtmlParts ? (
               <View>
                 {renderAssistantSegment(richHtmlParts.before)}
                 {/* 视口型卡与普通富 HTML 同一条渲染路径：视口判定收敛在
                     RichHtmlMessage 内部（file:// 源、固定高度、内滚），
                     列表内直接渲染、按钮直接可交互，不再提供全屏入口。 */}
                 <RichHtmlMessage
                   html={richHtmlParts.document}
                   onCommand={(command, token) => onSlashCommand(command, token, message.id)}
                   fullWidth={fullWidth}
                   allowFullscreenVideo
                 />
                 {renderAssistantSegment(richHtmlParts.after)}
               </View>
             ) : (
               <RichHtmlMessage
                 html={message.text}
                 onCommand={(command, token) => onSlashCommand(command, token, message.id)}
                 fullWidth={fullWidth}
                 allowFullscreenVideo
               />
             )
          ) : renderHtml ? (
            <RenderHtml
              contentWidth={contentWidth}
              source={htmlSource}
              baseStyle={htmlBaseStyle}
              tagsStyles={htmlTagsStyles}
              classesStyles={regexClassesStyles}
              domVisitors={regexDomVisitors}
              customHTMLElementModels={customHTMLElementModels}
              renderers={htmlRenderers}
              defaultTextProps={{ selectable: true }}
            />
          ) : (
             <Markdown style={markdownStyles} rules={markdownRules}>{message.text}</Markdown>
          )}
        </View>

        {!isUser && message.inlineImage ? (

           <View style={[styles.inlineImageWrap, fullWidth && styles.inlineImageFullWidth]}>
            {message.inlineImage.status === 'loading' ? (
              <View style={[styles.inlineImageBox, styles.inlineImageLoading]}>
                <ActivityIndicator color={theme.colors.primary} />
                <Text style={styles.inlineImageHint}>配图生成中...</Text>
              </View>
            ) : message.inlineImage.status === 'error' ? (
              <View style={[styles.inlineImageBox, styles.inlineImageError]}>
                <Text style={styles.inlineImageHint} numberOfLines={2}>
                  {message.inlineImage.message || '配图生成失败'}
                </Text>
                <TouchableOpacity
                  style={styles.inlineImageRetry}
                  onPress={() => onGenerateImage?.(message.id, message.text)}
                  activeOpacity={0.8}
                >
                  <Text style={styles.inlineImageRetryText}>重试</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <Image
                source={{ uri: message.inlineImage.url || `data:image/png;base64,${message.inlineImage.base64}` }}
                style={styles.inlineImage}
                resizeMode="cover"
              />
            )}
          </View>
        ) : null}
        {!message.pending && !selectionMode && !message.image ? (
          <View style={[styles.messageActions, isUser ? styles.messageActionsRight : styles.messageActionsLeft]}>
            <TouchableOpacity
              style={[styles.messageActionButton, overlayActions && styles.messageActionButtonOverlay]}
              onPress={() => setActionsOpen(true)}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel="更多操作"
            >
              <Ionicons name="ellipsis-horizontal" size={15} color={theme.colors.primarySoft} />
            </TouchableOpacity>
            {!isUser && onBroadcast ? (
              <TouchableOpacity
                style={[styles.messageActionButton, overlayActions && styles.messageActionButtonOverlay]}
                onPress={() => onBroadcast(rawText != null ? rawText : message.text)}
                activeOpacity={0.8}
              >
                <Text style={styles.messageActionText}>播报</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}
      </View>
      {isUser ? avatarElement : null}
      {actionsOpen ? (
        <Modal
          visible
          transparent
          animationType="fade"
          onRequestClose={() => setActionsOpen(false)}
        >
          <TouchableOpacity
            style={styles.messageActionsBackdrop}
            activeOpacity={1}
            onPress={() => setActionsOpen(false)}
          >
            <View style={styles.messageActionsSheet}>
              <Text style={styles.modalTitle}>消息操作</Text>
              {messageActionItems.map(item => (
                <TouchableOpacity
                  key={item.key}
                  style={styles.moreRow}
                  onPress={() => {
                    if (item.key !== 'copy') setActionsOpen(false);
                    if (typeof item.onPress === 'function') item.onPress();
                  }}
                  activeOpacity={0.8}
                >
                  <Ionicons name={item.icon} size={16} color={theme.colors.primaryMuted} />
                  <Text style={styles.moreRowText}>{item.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </TouchableOpacity>
        </Modal>
      ) : null}
    </View>
  );
});


export default MessageBubble;
