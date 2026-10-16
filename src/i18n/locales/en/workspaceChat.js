// Workspace "chat" domain strings (extracted from workspace.js in FEAT-AC12).
//
// Why a separate file: workspace.js sits right at the 800-line hard cap and AC12 adds
// strings to this very domain (duplicate-send notice / summary-card dismiss). Following
// the repo's existing convention ("new domain = new domain file + one ...<domain> line
// in the export object"), the whole workspace.chat.* domain moves out so both files
// return to a safe level. Keys stay flat and dotted, so consumers are unaffected.

export const workspaceChat = {
  'workspace.chat.intro': 'Describe what you need; the assistant will use workspace tools to do it. You can attach text files or images, or dictate by voice. The conversation is not saved.',
  'workspace.chat.placeholder': 'e.g. create src/app.js with a hello function',
  'workspace.chat.tool.reading': 'Calling tool: {name}',
  // P2-1: message search (filters the message list in place)
  'workspace.chat.search.placeholder': 'Search messages',
  'workspace.chat.search.clear': 'Clear search',
  'workspace.chat.search.count': '{count} matches',
  'workspace.chat.search.empty': 'No matching messages.',
  'workspace.chat.summary.title': 'Changed this turn ({count} files)',
  // git 开着时面板显示的是**最近一次提交**改了什么，未必是本轮（见 TurnSummaryPanel 的说明）。
  'workspace.chat.summary.titleCommit': 'Changed in the last commit ({count} files)',
  'workspace.chat.summary.op.write': 'Write',
  'workspace.chat.summary.op.edit': 'Edit',
  'workspace.chat.summary.op.mkdir': 'New dir',
  'workspace.chat.summary.undo': 'Undo this turn',
  // FEAT-AC12 P0-3: accessibility label for the third exit (× / dismiss).
  'workspace.chat.summary.dismiss': 'Dismiss this summary',
  'workspace.chat.summary.undoHint': 'Undo needs “Local version control” turned on (Settings → Workspace). Without it you can restore file by file from File history in the Files panel.',
  'workspace.chat.summary.noParent': 'Nothing to roll back to: this turn has no commit yet (each turn commits automatically at the end).',
  'workspace.chat.summary.commitMessage': 'Roll back this turn ({count} files)',
  'workspace.chat.summary.doneTitle': 'Turn undone',
  'workspace.chat.summary.doneBody': 'Restored {count} files to how they were before this turn ({removed} of them were new and have been deleted). The rollback itself is committed too.',
  'workspace.chat.summary.failTitle': 'Undo failed',
  'workspace.chat.tool.history': 'Commit history',
  'workspace.chat.summary.op.delete': 'Delete',
  // Q1: this panel sits outside the message ScrollView — rendering a whole-repo commit
  // (1066 files) inline used to squeeze the message area to zero height.
  'workspace.chat.summary.more': '{count} more file(s) — view all',
  'workspace.chat.summary.bulkFolded': 'Large change ({count} files) — details folded; tap to view all',
  'workspace.chat.summary.allTitle': 'All changed files ({count})',
  'workspace.chat.tool.running': 'Running…',
  'workspace.chat.tool.runningElapsed': 'Running {elapsed}',
  'workspace.chat.tool.change': 'Change',
  'workspace.chat.tool.content': 'Content written ({count} chars)',
  'workspace.chat.tool.command': 'Command',
  'workspace.chat.tool.code': 'Code',
  'workspace.chat.tool.output': 'Output',
  'workspace.chat.tool.noOutput': '(no output)',
  'workspace.chat.tool.plan': 'Plan',
  'workspace.chat.tool.subtask': 'Subtask',
  // ---- UI-side notices for tool results (TOOL_NOTICE_KEYS in toolDefs/toolNotices.js) ----
  // These mirror the Chinese text inside the tool result (model-facing, never translated).
  // The tool result also carries noticeKey; the display layer renders these entries.
  // **Wiring lives in workspace/conversation.js and screen/ToolCallRow.js.**
  'workspace.chat.tool.notice.gitNoRepo': 'Local version control is not ready yet: this workspace has no git repository. Turn on “Local version control” under Workspace → Settings (it creates the repository), then try again.',
  'workspace.chat.tool.notice.subagentWriteBlocked': 'Write subagent unavailable: the workspace is in read-only mode. Writing requires you to switch to “Editable” mode (nothing was executed).',
  'workspace.chat.tool.notice.workflowWriteBlocked': 'Workflow cannot run: step(s) {steps} require write mode, but the workspace is in read-only mode. Writing requires you to switch to “Editable” mode (nothing was executed).',
  'workspace.chat.plan.title': 'Plan ({done}/{total})',
  'workspace.chat.trace.title': 'Tool calls ({count})',
  'workspace.chat.steering.title': 'Steering',
  'workspace.chat.steering.note': 'Extra instruction received — it will be taken into account next step',
  'workspace.chat.steering.attachments': 'This turn is still running: steering only supports text; send attachments after it finishes.',
  'workspace.chat.planApproval.action': 'Approve & switch to write mode',
  'workspace.chat.err': 'Request failed, please try again.',
  'workspace.chat.stopped': '(stopped)',
  // FEAT-AC12 P0-2: duplicate send within the debounce window. Must be explicit —
  // silently dropping looks like "I tapped and nothing happened".
  'workspace.chat.duplicate.title': 'Already sent the same text',
  'workspace.chat.duplicate.body': 'An identical message submitted within 3 seconds was ignored. If the previous turn has not started yet, wait a moment and tap send again.',
  'workspace.chat.compact.title': 'Compact session',
  'workspace.chat.compact.done': 'Compacted ({applied}); older history summarized, tail kept.',
  'workspace.chat.compact.noop': 'Nothing to compact in this session.',
  'workspace.chat.compact.fail': 'Compaction failed; session unchanged.',
  'workspace.chat.imageTag': '[image]',
  'workspace.chat.attach.a11y': 'Attach file',
  'workspace.chat.attach.err.title': 'Cannot attach',
  'workspace.chat.attach.err.body': 'Only text files and images are supported.',
  'workspace.chat.record.a11y': 'Voice to text',
  'workspace.chat.recording': 'Recording… tap to finish',
  'workspace.chat.voice.busy': 'Transcribing…',
  'workspace.chat.voice.stop': 'Finish',
  'workspace.chat.voice.err.title': 'Recording failed',
  'workspace.chat.voice.err.body': 'Recording or transcription failed, please retry.',
  'workspace.chat.voice.none.title': 'No transcription configured',
  'workspace.chat.voice.none.body': 'Add a transcription config under Settings → Speech-to-text and retry.',
  'workspace.chat.send.a11y': 'Send instruction',
  'workspace.chat.stop.a11y': 'Stop generating',
  'workspace.chat.steer.a11y': 'Send as a steering instruction (does not interrupt this turn)',
};
