// SW1: entries for the workspace "watch screen" panel (split domain file —
// workspace.js is at the line ratchet).
export const workspaceWatch = {
  'workspace.screen.rail.watch': 'Watch',
  'workspace.watch.title': 'Watch screen (workspace)',
  'workspace.watch.subtitle': 'With the floating window on, the workspace assistant can watch your screen across apps and reply to you.',
  'workspace.watch.statusOn': 'Floating window is on',
  'workspace.watch.statusOff': 'Floating window is off',
  'workspace.watch.open': 'Turn on floating window',
  'workspace.watch.close': 'Turn off floating window',
  'workspace.watch.unsupported': 'This build has no floating-window screen watch (rebuild the APK).',
  'workspace.watch.permissionDenied': 'Overlay permission is required: allow this app to display over other apps in system settings.',
  // FIX-3: a missing screen-capture grant is a different problem from a missing overlay
  // permission; lumping them together sends the user to fix the wrong setting.
  'workspace.watch.capturePermissionRequired': 'Screen recording must be allowed in the system dialog: tap "Turn on floating window" again and confirm the prompt.',
  'workspace.watch.startFailed': 'Failed to start the floating window. Try again.',
  'workspace.watch.threads': 'Workspace watch conversations',
  'workspace.watch.empty': 'No workspace watch conversations yet. Turn on the floating window and talk to your screen — records show up here.',
  'workspace.watch.emptyPreview': '(no content yet)',
  'workspace.watch.readFailed': 'Could not read watch conversations (data may be corrupt); the stored value was left untouched.',
  'workspace.watch.sw2Note': 'Note: conversations now run on the workspace agent pipeline (tools and permission gates); the in-overlay mini chat lands in a later version.',
  // SW2: give the workspace assistant commands (agent pipeline with tools + confirmation).
  'workspace.watch.assistantName': 'Workspace assistant',
  'workspace.watch.command': 'Command the workspace assistant',
  'workspace.watch.commandPlaceholder': 'e.g. what is this error / update the README',
  'workspace.watch.send': 'Send',
  'workspace.watch.running': 'Running…',
  'workspace.watch.stop': 'Stop',
  'workspace.watch.toolRunning': 'Calling {name}…',
  'workspace.watch.modeRead': 'Read-only',
  'workspace.watch.modeWrite': 'Writable',
  'workspace.watch.writeHint': 'In "Writable" mode every destructive step (write file / run command / commit) asks for confirmation first, so you can allow or deny each one.',
  // FEAT-AC5 P0-A: expanding a thread row (tap to read the full conversation / long-press to delete).
  // The speaker is called the workspace assistant, not "Character" — in this context the
  // Memory page's role label would name the wrong party.
  'workspace.watch.roleUser': 'You',
  'workspace.watch.roleAssistant': 'Workspace assistant',
  'workspace.watch.expandA11y': 'Expand this conversation',
  'workspace.watch.collapseA11y': 'Collapse this conversation',
  'workspace.watch.deleteThread': 'Delete this conversation',
  'workspace.watch.deleteThread.a11y': 'Delete the watch conversation with {name}',
  'workspace.watch.deleteThread.title': 'Delete watch conversation',
  'workspace.watch.deleteThread.body': 'Delete the watch conversation with “{name}”? Captured files are kept.',
  'workspace.watch.entryImage': '(with screenshot)',
  'workspace.watch.noEntries': 'This conversation has no content yet.',
  // FEAT-AC7: turn endings and the overlay busy indicator.
  // "Stopped" and "timed out" must stay distinct: the first is the user's intent
  // (they pressed stop), the second is a failure — merging them misleads the user.
  'screenWatch.overlay.turnBusy': 'Working…',
  'screenWatch.overlay.turnStopped': 'Stopped.',
  'screenWatch.overlay.turnTimeout': 'No response before the time limit ({seconds}s). Try a faster model, or split the task into smaller steps.',
  // Honest fallback when the page is not mounted (app-level listener, no more silent drops).
  'screenWatch.overlay.chatNeedsPage': '(Chat mode needs the Screen peek page open: open Extension → Screen peek, then send again)',
  'screenWatch.overlay.captureNeedsPage': '(Capturing needs the Screen peek page open)',
};

export default workspaceWatch;
