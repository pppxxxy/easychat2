// 当前仓库树（含树内搜索、逐层下钻、快速检出、分支 chip、拉取、跳过清单、新建条目表单）。
// 纯展示组件：状态与 handler 全部由 GithubPanel 注入（styles/theme/t 一并透传）。
import React from 'react';
import {
  ActivityIndicator,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { FieldHint, FieldLabel, GhostButton, PrimaryButton } from '../../../ui/index.js';
import { formatSkippedList } from '../../repoImport.js';

export default function RepoTreeSection({
  styles,
  theme,
  t,
  current,
  search,
  setSearch,
  searchResults,
  openFile,
  crumbs,
  setSubdir,
  children,
  virtualPaths,
  checkoutBusy,
  quickCheckout,
  manifestTruncated,
  pullBranch,
  setPullBranch,
  pullBusy,
  pullProgress,
  pullSnapshot,
  pullCancelRef,
  branchBusy,
  branchError,
  branchOptions,
  branchOverLimit,
  pullEta,
  pullNotice,
  skippedPayload,
  skippedOpen,
  setSkippedOpen,
  layer,
  entryForm,
  setEntryForm,
  submitEntry,
  setLayer,
}) {
  return (
    <>
      <FieldLabel>{t('workspace.github.tree.title', { name: `${current.owner}/${current.repo}` })}</FieldLabel>
      <TextInput
        style={styles.searchInput}
        value={search}
        onChangeText={setSearch}
        placeholder={t('workspace.github.search.placeholder')}
        placeholderTextColor={theme.colors.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
      />
      {search.trim() ? (
        searchResults.length === 0 ? (
          <FieldHint>{t('workspace.github.search.empty')}</FieldHint>
        ) : (
          searchResults.map(path => (
            <TouchableOpacity key={path} style={styles.fileRow} onPress={() => openFile(path)} activeOpacity={0.8}>
              <Ionicons name="search-outline" size={15} color={theme.colors.primaryMuted} />
              <Text style={styles.fileName} numberOfLines={1} ellipsizeMode="middle">{path}</Text>
            </TouchableOpacity>
          ))
        )
      ) : (
        <>
          <View style={styles.crumbRow}>
            {crumbs.map((crumb, index) => (
              <View key={crumb.path || 'root'} style={styles.crumbItem}>
                {index > 0 ? <Ionicons name="chevron-forward" size={12} color={theme.colors.textFaint} /> : null}
                <TouchableOpacity onPress={() => setSubdir(crumb.path)} activeOpacity={0.7}>
                  <Text style={[styles.crumbText, index === crumbs.length - 1 && styles.crumbTextActive]} numberOfLines={1} ellipsizeMode="middle">
                    {crumb.name}
                  </Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>
          {children.length === 0 ? <FieldHint>{t('workspace.github.tree.empty')}</FieldHint> : null}
          {children.map(child => (
            <View key={child.path} style={styles.fileRow}>
              <TouchableOpacity
                style={styles.fileMain}
                onPress={() => (child.isDirectory ? setSubdir(child.path) : openFile(child.path))}
                activeOpacity={0.8}
              >
                <Ionicons
                  name={child.isDirectory ? 'folder-outline' : 'document-text-outline'}
                  size={16}
                  color={theme.colors.primaryMuted}
                />
                <Text style={styles.fileName} numberOfLines={1} ellipsizeMode="middle">{child.name}</Text>
                {/* C1：只在清单里（未物化）的条目带云朵角标——点开时按需下载。 */}
                {virtualPaths.has(child.path) ? (
                  <Ionicons
                    name="cloud-outline"
                    size={13}
                    color={theme.colors.textFaint}
                    style={styles.virtualBadge}
                  />
                ) : null}
              </TouchableOpacity>
            </View>
          ))}
        </>
      )}

      {current ? (
        <TouchableOpacity
          style={styles.checkoutRow}
          onPress={quickCheckout}
          activeOpacity={0.85}
          disabled={checkoutBusy}
        >
          <Ionicons name="flash-outline" size={15} color={theme.colors.primary} />
          <Text style={styles.checkoutText}>
            {checkoutBusy
              ? t('workspace.github.checkout.busy')
              : t('workspace.github.checkout.action')}
          </Text>
        </TouchableOpacity>
      ) : null}
      {manifestTruncated ? (
        <FieldHint>{t('workspace.github.checkout.truncatedHint')}</FieldHint>
      ) : null}

      <View style={styles.pullRow}>
        <TextInput
          style={[styles.input, styles.branchInput]}
          value={pullBranch}
          onChangeText={setPullBranch}
          placeholder={t('workspace.github.pull.branchPlaceholder')}
          placeholderTextColor={theme.colors.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <PrimaryButton
          title={pullBusy
            ? (pullProgress.total > 0
              ? t('workspace.github.pull.progress', { done: pullProgress.done, total: pullProgress.total })
              : t('workspace.github.pull.busy'))
            : t('workspace.github.pull.action')}
          small
          onPress={pullSnapshot}
        />
        {pullBusy ? (
          <GhostButton
            title={t('workspace.github.pull.cancel')}
            small
            onPress={() => { pullCancelRef.current = true; }}
          />
        ) : null}
      </View>
      {/* B1：分支 chip（点选即填输入框）。加载中 / 失败都有对应状态——
          失败不阻塞：手动输入始终可用（特殊分支名与 >200 个分支的兜底）。 */}
      {branchBusy ? (
        <ActivityIndicator size="small" color={theme.colors.primary} style={styles.branchChipsBusy} />
      ) : branchError ? (
        <FieldHint>{t('workspace.github.branch.loadError')}</FieldHint>
      ) : branchOptions.length > 0 ? (
        <>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.branchChips}
            contentContainerStyle={styles.branchChipsContent}
          >
            {branchOptions.map(item => (
              <TouchableOpacity
                key={item.name}
                style={[styles.branchChip, item.name === pullBranch && styles.branchChipActive]}
                onPress={() => setPullBranch(item.name)}
                activeOpacity={0.8}
              >
                <Text style={[styles.branchChipText, item.name === pullBranch && styles.branchChipTextActive]}>
                  {item.name}
                </Text>
                {current && item.name === current.defaultBranch ? (
                  <View style={styles.branchChipBadge}>
                    <Text style={styles.branchChipBadgeText}>{t('workspace.github.branch.defaultTag')}</Text>
                  </View>
                ) : null}
              </TouchableOpacity>
            ))}
          </ScrollView>
          {branchOverLimit ? <FieldHint>{t('workspace.github.branch.overLimit')}</FieldHint> : null}
        </>
      ) : null}
      {pullBusy ? (
        <FieldHint>
          {pullProgress.total > 0
            ? t('workspace.github.pull.foreground', { eta: pullEta })
            : t('workspace.github.pull.foregroundPreparing')}
        </FieldHint>
      ) : null}
      {pullNotice ? <FieldHint>{pullNotice}</FieldHint> : null}
      {/* G2：跳过清单入口——「少了哪些文件」可见（以前只有计数）。 */}
      {skippedPayload && skippedPayload.total > 0 ? (
        <>
          <View style={styles.actions}>
            <GhostButton
              title={skippedOpen
                ? t('workspace.github.skipped.hide')
                : t('workspace.github.skipped.view', { count: skippedPayload.total })}
              small
              onPress={() => setSkippedOpen(value => !value)}
            />
          </View>
          {skippedOpen ? (
            <Text style={styles.skippedList} selectable numberOfLines={80}>
              {formatSkippedList(skippedPayload)}
            </Text>
          ) : null}
        </>
      ) : null}
      <FieldHint>{t('workspace.github.pull.hint')}</FieldHint>

      {layer === 'newEntry' ? (
        <View style={styles.formCard}>
          <FieldLabel>
            {entryForm.kind === 'folder' ? t('workspace.panel.form.newFolder') : t('workspace.panel.form.newText')}
          </FieldLabel>
          <TextInput
            style={styles.input}
            value={entryForm.name}
            onChangeText={value => setEntryForm(current2 => ({ ...current2, name: value }))}
            placeholder={entryForm.kind === 'folder' ? t('workspace.panel.form.nameFolder') : t('workspace.panel.form.nameText')}
            placeholderTextColor={theme.colors.textFaint}
          />
          {entryForm.kind === 'text' ? (
            <TextInput
              style={[styles.input, styles.contentInput]}
              value={entryForm.content}
              onChangeText={value => setEntryForm(current2 => ({ ...current2, content: value }))}
              placeholder={t('workspace.panel.form.content')}
              placeholderTextColor={theme.colors.textFaint}
              multiline
            />
          ) : null}
          <View style={styles.actions}>
            <GhostButton title={t('common.cancel')} small onPress={() => setLayer('')} />
            <PrimaryButton title={t('common.save')} small onPress={submitEntry} />
          </View>
        </View>
      ) : null}
    </>
  );
}
