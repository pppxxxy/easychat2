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
};

export default workspaceWatch;
