// Keep one tab per file path; selecting an existing file only activates it.
function ensureWorkspaceFileTab(tabs, path) {
  if (!tabs.some(tab => tab.path === path)) {
    tabs.push({ path, name: path.split('/').filter(Boolean).pop() || path });
  }
}
