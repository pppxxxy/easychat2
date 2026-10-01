# 数据导入导出需求

## Introduction

EasyChat2 需要支持本机数据的完整备份与恢复，用于换机、清理数据后的恢复和误删后的回滚。

## Glossary

- **备份包**：带 `schemaVersion` 的 JSON 文件，包含应用数据、角色媒体与聊天媒体。
- **数据键**：AsyncStorage 中以 `@easychat2_` 开头的持久化键。
- **合并恢复**：按稳定 id 合并角色、会话与配置，导入项覆盖同 id 的现有项。
- **覆盖恢复**：清理备份覆盖范围内的现有数据后恢复备份内容。

## Requirements

### Requirement 1: Export

**User Story:** AS a user, I want to export my local data, so that I can restore it on another device.

1. WHEN the user starts an export, the system SHALL create a versioned backup package containing character, session, message, setting and media data.
2. WHEN the system serializes API configurations, the system SHALL omit API keys, secret keys and secure-store references from the package.
3. WHEN the backup exceeds the configured package limit, the system SHALL stop export and show the package size and limit.
4. WHEN export succeeds, the system SHALL provide the package through the existing document sharing flow.

### Requirement 2: Validation and Import

**User Story:** AS a user, I want invalid backups rejected before writing, so that existing data stays safe.

1. WHEN the user selects a backup, the system SHALL validate JSON shape, `schemaVersion` and record types before any write.
2. WHEN validation fails, the system SHALL show the failure and preserve existing local data.
3. WHEN import uses merge mode, the system SHALL merge stable-id records and let imported records win conflicts.
4. WHEN import uses replace mode, the system SHALL replace only the backup-managed data domains.
5. WHEN import completes, the system SHALL refresh the active application state.

### Requirement 3: Integrity and Safety

**User Story:** AS a user, I want import and export to respect existing storage constraints, so that large chats and protected data remain safe.

1. WHEN the system reads a data key, the system SHALL use the existing large-value fallback path.
2. WHEN the system restores collections, the system SHALL write existing index and item keys rather than storing a growing collection in one key.
3. WHEN the system restores messages, the system SHALL exclude `pending` messages.
4. WHEN the system restores media, the system SHALL write files under the existing application media directories and preserve referenced URIs.
5. WHEN import fails during a write, the system SHALL report the failure and preserve a diagnostic record for investigation.

### Requirement 4: User Experience

**User Story:** AS a user, I want to understand what a backup contains, so that I can choose a safe recovery mode.

1. WHEN the user opens Settings > About, the system SHALL show a Backup and Restore entry.
2. WHEN the user starts export, the system SHALL state that secrets are excluded and media are included.
3. WHEN the user starts import, the system SHALL offer merge and replace modes with explicit confirmation for replace.
4. WHEN import or export finishes, the system SHALL show a success or failure message with the affected record count.
