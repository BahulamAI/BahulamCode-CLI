/**
 * Explore-run classifier — pure category lookup for the read/list/search/index
 * tool bursts that get collapsed into one animated summary line during a
 * sub-agent run.
 *
 * These functions are stateless. The mutable run state (counts, recent
 * paths, lineActive flag) still lives in repl.mjs during the split.
 */

const EXPLORE_TOOL_CATEGORY = new Map([
  ['read_file', 'read'], ['read', 'read'], ['read_files', 'read'],
  ['read_batch', 'read'], ['get_file_info', 'read'],
  ['list_files', 'list'], ['glob', 'list'], ['ls', 'list'],
  ['search_code', 'search'], ['search_files', 'search'], ['grep', 'search'],
  ['index_project', 'index'], ['register_project', 'index'],
]);

export function exploreCollapseEnabled() {
  return process.env.KEPLER_EXPLORE_COLLAPSE !== '0';
}

export function isExploreTool(tool) {
  if (!exploreCollapseEnabled()) return false;
  return EXPLORE_TOOL_CATEGORY.has(String(tool || '').toLowerCase());
}

export function exploreCategory(tool) {
  return EXPLORE_TOOL_CATEGORY.get(String(tool || '').toLowerCase()) || 'explore';
}

// Test-only accessor so unit tests can enumerate the recognized tools
// without importing the private Map.
export function _knownExploreTools() {
  return [...EXPLORE_TOOL_CATEGORY.keys()];
}
