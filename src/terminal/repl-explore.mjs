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
  // analyze_code is the "cheap 10x-lighter than read_file" tool the system
  // prompt tells the agent to prefer for structure lookups. Burst usage is
  // as common as read bursts, so classify it as a read for collapse.
  ['analyze_code', 'read'],
  ['list_files', 'list'], ['glob', 'list'], ['ls', 'list'],
  ['search_code', 'search'], ['search_files', 'search'], ['grep', 'search'],
  // validate_* tools are read-only structure/build checks the agent chains
  // during post-write verification. They fit naturally in a search-ish bucket
  // ("checking") rather than opening a discrete card per call.
  ['validate_file', 'search'], ['validate_structure', 'search'],
  ['index_project', 'index'], ['register_project', 'index'],
  ['get_project_overview', 'index'],
]);

export function exploreCollapseEnabled() {
  return process.env.BAHULAM_EXPLORE_COLLAPSE !== '0';
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
