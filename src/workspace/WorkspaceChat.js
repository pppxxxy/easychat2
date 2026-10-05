// 工作区指令对话框：嵌在工作区面板里的迷你对话，直连 Agent 工具循环。
// - 输入一条指令 → runAgentTurn（按当前工作模式暴露工具）→ 流式回显；
// - 可附加文本文件（内容并入指令）或图片（多模态）；可录音转文字；
// - 不做表情包、不发持久化会话：对话只存在于本次打开期间。
//
// 与聊天页共用底层能力（api.js / agent loop / 附件解析 / 转写），但不走角色扮演
// 那套 Prompt 流水线：工作区助手只关心沙盒文件操作（见 workspace/chat.js）。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { SheetHeader } from '../ui/index.js';
import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';
import { getApiConfigs, getTranscriptionSettings } from '../storage.js';
import { filterRequestMedia } from '../prompt/chatPipeline.js';
import { isCanceledError } from '../network/api.js';
import { resolveTranscription, transcribeAudio } from '../transcription.js';
import { maskSecrets } from '../storage/secrets.js';
import { runAgentTurn } from '../agent/loop.js';
import { listToolsForMode } from '../agent/tools/registry.js';
import { requestToolApproval } from '../chat/toolApproval.js';
import {
  isImage,
  isTextLike,
  mergeTextAttachments,
  pickAttachment,
  readImageDataUri,
  readTextAttachment,
} from '../chat/attachments.js';
import useChatRecorder from '../chat/useChatRecorder.js';
import { registerDefaultWorkspaceTools } from './native.js';
import {
  buildWorkspaceAgentMessages,
  buildWorkspaceAgentSystemPrompt,
  projectWorkspaceChatHistory,
} from './chat.js';

const MAX_ATTACHMENTS = 3;

let messageSeq = 0;
function nextId() {
  messageSeq += 1;
  return `wsc-${Date.now().toString(36)}-${messageSeq}`;
}

export default function WorkspaceChat({ visible, onClose, characterId = 'default', mode = 'ask', settings = null, characterName = '', onFilesChanged }) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [sending, setSending] = useState(false);
  const [toolStatus, setToolStatus] = useState('');
  const [voiceBusy, setVoiceBusy] = useState(false);
  const recorder = useChatRecorder();
  const controllerRef = useRef(null);
  const mountedRef = useRef(true);
  // recorder 每次渲染都是新对象；把它放进 ref，避免关闭清理 effect 反复触发。
  const recorderRef = useRef(recorder);
  recorderRef.current = recorder;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (controllerRef.current) controllerRef.current.abort();
    };
  }, []);

  // 关闭时清空这一轮的临时对话与正在生成的请求。
  useEffect(() => {
    if (visible) return;
    if (controllerRef.current) controllerRef.current.abort();
    setMessages([]);
    setInput('');
    setAttachments([]);
    setToolStatus('');
    setSending(false);
    if (recorderRef.current.recording) recorderRef.current.cancel();
  }, [visible]);

  const updateAssistant = useCallback((id, patch) => {
    setMessages(list => list.map(item => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const removeAttachment = useCallback(id => {
    setAttachments(list => list.filter(item => item.id !== id));
  }, []);

  const onPickAttachment = useCallback(async () => {
    try {
      const asset = await pickAttachment();
      if (!asset) return;
      if (isImage(asset.name, asset.mime)) {
        const dataUri = await readImageDataUri(asset.uri, asset.mime);
        setAttachments(list => [...list, { id: nextId(), kind: 'image', name: asset.name, dataUri }].slice(0, MAX_ATTACHMENTS));
        return;
      }
      if (isTextLike(asset.name, asset.mime)) {
        const text = await readTextAttachment(asset.uri);
        setAttachments(list => [...list, { id: nextId(), kind: 'text', name: asset.name, text }].slice(0, MAX_ATTACHMENTS));
        return;
      }
      Alert.alert(t('workspace.chat.attach.err.title'), t('workspace.chat.attach.err.body'));
    } catch (error) {
      Alert.alert(
        t('workspace.chat.attach.err.title'),
        maskSecrets((error && error.message) || t('workspace.chat.attach.err.body'))
      );
    }
  }, [t]);

  const onStopVoice = useCallback(async () => {
    if (voiceBusy) return;
    setVoiceBusy(true);
    try {
      const audio = await recorder.stop();
      if (!audio || !audio.uri) return;
      const [{ configs, activeId }, transcriptionSettings] = await Promise.all([
        getApiConfigs(),
        getTranscriptionSettings().catch(() => ({ activeId: '', configs: [] })),
      ]);
      const activeChat = configs.find(item => item.id === activeId) || configs[0] || null;
      const dedicated = (transcriptionSettings.configs || []).find(item => item.id === transcriptionSettings.activeId) || null;
      const target = resolveTranscription({ chatConfig: activeChat, dedicated });
      if (target.source === 'none') {
        Alert.alert(t('workspace.chat.voice.none.title'), t('workspace.chat.voice.none.body'));
        return;
      }
      const result = await transcribeAudio({ config: target, fileUri: audio.uri, mime: audio.mime });
      const text = String(result.text || '').trim();
      if (text) setInput(prev => (prev ? `${prev} ${text}` : text));
    } catch (error) {
      Alert.alert(t('workspace.chat.voice.err.title'), maskSecrets((error && error.message) || t('workspace.chat.voice.err.body')));
    } finally {
      if (mountedRef.current) setVoiceBusy(false);
    }
  }, [recorder, t, voiceBusy]);

  const handleStop = useCallback(() => {
    if (controllerRef.current) controllerRef.current.abort();
  }, []);

  const handleSend = useCallback(async () => {
    if (sending) return;
    const text = input.trim();
    const textAttachments = attachments.filter(item => item.kind === 'text');
    const imageAttachments = attachments.filter(item => item.kind === 'image');
    const userText = mergeTextAttachments(text, textAttachments);
    const images = imageAttachments.map(item => item.dataUri);
    if (!userText && images.length === 0) return;

    const userMessage = {
      id: nextId(),
      role: 'user',
      content: userText || (images.length ? t('workspace.chat.imageTag') : ''),
    };
    const assistantId = nextId();
    const history = messages;
    setMessages(list => [...list, userMessage, { id: assistantId, role: 'assistant', content: '' }]);
    setInput('');
    setAttachments([]);
    setSending(true);
    setToolStatus('');

    const controller = new AbortController();
    controllerRef.current = controller;

    const systemPrompt = buildWorkspaceAgentSystemPrompt({ mode, characterName });
    let request = buildWorkspaceAgentMessages({
      systemPrompt,
      history: projectWorkspaceChatHistory(history),
      userText,
      images,
    });
    try {
      const { configs, activeId } = await getApiConfigs();
      const cfg = configs.find(item => item.id === activeId) || configs[0] || null;
      request = filterRequestMedia(request, { allowVision: Boolean(cfg && cfg.supportsVision), allowAudio: false });
    } catch (error) {}

    let tools = [];
    if (mode !== 'ask') {
      try {
        registerDefaultWorkspaceTools(settings);
        tools = listToolsForMode(mode);
      } catch (error) {}
    }

    try {
      await runAgentTurn(request, {
        mode,
        tools,
        signal: controller.signal,
        requestOptions: { stream: true },
        onToken: fullText => {
          if (!mountedRef.current || controller.signal.aborted) return;
          updateAssistant(assistantId, { content: fullText, isError: false });
        },
        onToolEvent: event => {
          if (!mountedRef.current || !event) return;
          setToolStatus(event.phase === 'start' ? t('workspace.chat.tool.reading', { name: event.name }) : '');
        },
        onToolApproval: call => requestToolApproval({
          name: call && call.name,
          args: call && call.args,
          t,
          signal: controller.signal,
        }),
        context: { characterId },
      });
      if (mode !== 'ask' && mountedRef.current && !controller.signal.aborted && typeof onFilesChanged === 'function') {
        onFilesChanged();
      }
    } catch (error) {
      if (controller.signal.aborted || isCanceledError(error)) {
        setMessages(list => list.map(item => (
          item.id === assistantId && !String(item.content || '').trim()
            ? { ...item, content: t('workspace.chat.stopped'), isError: true }
            : item
        )));
      } else {
        updateAssistant(assistantId, {
          content: maskSecrets((error && error.message) || t('workspace.chat.err')),
          isError: true,
        });
      }
    } finally {
      if (mountedRef.current) {
        setSending(false);
        setToolStatus('');
      }
      controllerRef.current = null;
    }
  }, [attachments, characterId, characterName, input, messages, mode, onFilesChanged, sending, settings, t, updateAssistant]);

  const canSend = !sending && (input.trim().length > 0 || attachments.length > 0);
  const lastAssistantId = messages.length && messages[messages.length - 1].role === 'assistant'
    ? messages[messages.length - 1].id
    : '';

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <SheetHeader title={t('workspace.chat.title')} onClose={onClose} />

        <ScrollView contentContainerStyle={styles.body}>
          {messages.length === 0 ? (
            <Text style={styles.intro}>{t('workspace.chat.intro')}</Text>
          ) : null}
          {messages.map(item => (
            <View
              key={item.id}
              style={[styles.bubbleRow, item.role === 'user' ? styles.bubbleRowUser : styles.bubbleRowAssistant]}
            >
              <View style={[
                styles.bubble,
                item.role === 'user' ? styles.bubbleUser : styles.bubbleAssistant,
                item.isError ? styles.bubbleError : null,
              ]}>
                {item.role === 'assistant' && !item.content && sending && item.id === lastAssistantId ? (
                  <ActivityIndicator size="small" color={theme.colors.primary} />
                ) : (
                  <Text style={styles.bubbleText}>{item.content}</Text>
                )}
              </View>
            </View>
          ))}
        </ScrollView>

        {toolStatus ? (
          <View style={styles.statusBar}>
            <ActivityIndicator size="small" color={theme.colors.primaryMuted} />
            <Text style={styles.statusText} numberOfLines={1}>{toolStatus}</Text>
          </View>
        ) : null}

        {attachments.length > 0 ? (
          <View style={styles.attachmentBar}>
            {attachments.map(item => (
              <View key={item.id} style={styles.attachmentChip}>
                <Ionicons
                  name={item.kind === 'image' ? 'image-outline' : 'document-text-outline'}
                  size={14}
                  color={theme.colors.primarySoft}
                />
                <Text style={styles.attachmentName} numberOfLines={1}>{item.name}</Text>
                <TouchableOpacity onPress={() => removeAttachment(item.id)} hitSlop={6}>
                  <Ionicons name="close" size={14} color={theme.colors.textFaint} />
                </TouchableOpacity>
              </View>
            ))}
          </View>
        ) : null}

        {recorder.recording || voiceBusy ? (
          <View style={styles.recordingBar}>
            <Ionicons name="mic" size={16} color={theme.colors.danger} />
            <Text style={styles.recordingText}>
              {voiceBusy ? t('workspace.chat.voice.busy') : t('workspace.chat.recording')}
            </Text>
            {recorder.recording ? (
              <TouchableOpacity onPress={onStopVoice} hitSlop={8}>
                <Text style={styles.recordingAction}>{t('workspace.chat.voice.stop')}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}

        <View style={styles.inputBar}>
          <TouchableOpacity
            style={styles.iconButton}
            onPress={onPickAttachment}
            disabled={sending}
            accessibilityLabel={t('workspace.chat.attach.a11y')}
          >
            <Ionicons name="add-circle-outline" size={22} color={theme.colors.primarySoft} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.iconButton}
            onPress={recorder.recording
              ? onStopVoice
              : () => recorder.start().catch(error => Alert.alert(
                t('workspace.chat.voice.err.title'),
                maskSecrets((error && error.message) || t('workspace.chat.voice.err.body'))
              ))}
            disabled={sending || voiceBusy}
            accessibilityLabel={t('workspace.chat.record.a11y')}
          >
            <Ionicons
              name={recorder.recording ? 'mic' : 'mic-outline'}
              size={22}
              color={recorder.recording ? theme.colors.danger : theme.colors.primarySoft}
            />
          </TouchableOpacity>
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={setInput}
            placeholder={t('workspace.chat.placeholder')}
            placeholderTextColor={theme.colors.textFaint}
            multiline
            editable={!sending}
          />
          {sending ? (
            <TouchableOpacity style={[styles.sendButton, styles.stopButton]} onPress={handleStop} accessibilityLabel={t('workspace.chat.stop.a11y')}>
              <Ionicons name="stop" size={18} color={theme.colors.text} />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[styles.sendButton, !canSend && styles.sendButtonDisabled]}
              onPress={handleSend}
              disabled={!canSend}
              accessibilityLabel={t('workspace.chat.send.a11y')}
            >
              <Ionicons name="arrow-up" size={20} color={theme.colors.text} />
            </TouchableOpacity>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background, paddingTop: 48 },
  body: { paddingHorizontal: 16, paddingBottom: 16 },
  intro: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(18), marginTop: 8 },
  bubbleRow: { flexDirection: 'row', marginTop: 10 },
  bubbleRowUser: { justifyContent: 'flex-end' },
  bubbleRowAssistant: { justifyContent: 'flex-start' },
  bubble: {
    maxWidth: '86%',
    borderRadius: tokens.radius.md || tokens.radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderWidth: tokens.border.thin,
  },
  bubbleUser: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  bubbleAssistant: { backgroundColor: theme.colors.surface, borderColor: theme.colors.surfaceBorder },
  bubbleError: { borderColor: theme.colors.danger || theme.colors.surfaceBorder },
  bubbleText: { color: theme.colors.text, fontSize: fonts.scaled(13), lineHeight: fonts.scaled(19) },
  statusBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 4 },
  statusText: { color: theme.colors.textMuted, fontSize: fonts.scaled(11), marginLeft: 6, flex: 1 },
  attachmentBar: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 12, paddingBottom: 4 },
  attachmentChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.radius.sm,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginRight: 8,
    marginTop: 6,
  },
  attachmentName: { color: theme.colors.text, fontSize: fonts.scaled(11), marginHorizontal: 5, maxWidth: 160 },
  recordingBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  recordingText: { color: theme.colors.text, fontSize: fonts.scaled(12), marginLeft: 6, flex: 1 },
  recordingAction: { color: theme.colors.primarySoft, fontSize: fonts.scaled(12), fontWeight: '600' },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    borderTopWidth: tokens.border.thin,
    borderTopColor: theme.colors.surfaceBorder,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  iconButton: { paddingHorizontal: 6, paddingBottom: 8 },
  input: {
    flex: 1,
    color: theme.colors.text,
    fontSize: fonts.scaled(13),
    maxHeight: 120,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  sendButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 4,
  },
  sendButtonDisabled: { opacity: 0.5 },
  stopButton: { backgroundColor: theme.colors.surfaceBorder },
});
