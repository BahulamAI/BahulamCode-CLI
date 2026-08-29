/**
 * AST Parser — Extract structured code knowledge from source files.
 *
 * Multi-language regex-based extraction (no tree-sitter dependency).
 * Returns function signatures, class definitions, imports, exports.
 *
 * This is Phase 3 of the Investigative Funnel:
 * Raw code (2000 tokens) → Structured summary (200 tokens)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Analyze a source file and return structured knowledge.
 * @param {string} filePath - absolute path
 * @param {Object} [options]
 * @param {number} [options.startLine] - optional line range
 * @param {number} [options.endLine]
 * @returns {{ success: boolean, summary: string, structure: Object }}
 */
export function analyzeCode(filePath, { startLine, endLine } = {}) {
  try {
    let content = fs.readFileSync(filePath, 'utf-8');
    const totalLines = content.split('\n').length;

    if (startLine || endLine) {
      const lines = content.split('\n');
      const start = (startLine || 1) - 1;
      const end = endLine || lines.length;
      content = lines.slice(start, end).join('\n');
    }

    const ext = path.extname(filePath).toLowerCase();
    const relPath = filePath; // caller should make relative if needed

    let structure;
    if (['.ts', '.tsx', '.js', '.jsx', '.mjs'].includes(ext)) {
      structure = parseJavaScriptTypeScript(content);
    } else if (ext === '.py') {
      structure = parsePython(content);
    } else if (ext === '.go') {
      structure = parseGo(content);
    } else if (['.rs'].includes(ext)) {
      structure = parseRust(content);
    } else {
      structure = parseGeneric(content);
    }

    structure.file = path.basename(filePath);
    structure.lines = totalLines;
    structure.language = ext.replace('.', '');

    // Build concise summary
    const summary = buildSummary(structure);

    return { success: true, summary, structure };
  } catch (err) {
    return { success: false, summary: `Error analyzing ${filePath}: ${err.message}`, structure: {} };
  }
}

// ── JavaScript / TypeScript ────────────────────────────────

function parseJavaScriptTypeScript(content) {
  const imports = [];
  const exports = [];
  const functions = [];
  const classes = [];
  const interfaces = [];
  const types = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const lineNum = i + 1;

    // Imports
    const importMatch = trimmed.match(/^import\s+(?:\{([^}]+)\}|(\w+))\s+from\s+['"]([^'"]+)['"]/);
    if (importMatch) {
      imports.push({ names: (importMatch[1] || importMatch[2] || '').trim(), from: importMatch[3] });
      continue;
    }

    // Exports
    if (trimmed.startsWith('export default')) {
      exports.push('default');
    } else if (trimmed.match(/^export\s+(const|let|var|function|class|interface|type|async)/)) {
      const nameMatch = trimmed.match(/^export\s+(?:async\s+)?(?:const|let|var|function|class|interface|type)\s+(\w+)/);
      if (nameMatch) exports.push(nameMatch[1]);
    }

    // Functions
    const fnMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/);
    if (fnMatch) {
      functions.push({ name: fnMatch[1], params: fnMatch[2].trim(), line: lineNum });
      continue;
    }

    // Arrow functions
    const arrowMatch = trimmed.match(/^(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*(?::\s*\w+)?\s*=>/);
    if (arrowMatch) {
      functions.push({ name: arrowMatch[1], params: arrowMatch[2].trim(), line: lineNum });
      continue;
    }

    // Classes
    const classMatch = trimmed.match(/^(?:export\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?/);
    if (classMatch) {
      classes.push({ name: classMatch[1], extends: classMatch[2] || null, line: lineNum });
      continue;
    }

    // Methods
    const methodMatch = trimmed.match(/^(?:async\s+)?(\w+)\s*\(([^)]*)\)\s*(?::\s*\w+)?\s*\{/);
    if (methodMatch && !['if', 'for', 'while', 'switch', 'catch'].includes(methodMatch[1])) {
      functions.push({ name: methodMatch[1], params: methodMatch[2].trim(), line: lineNum, isMethod: true });
    }

    // Interfaces
    const ifaceMatch = trimmed.match(/^(?:export\s+)?interface\s+(\w+)/);
    if (ifaceMatch) interfaces.push({ name: ifaceMatch[1], line: lineNum });

    // Types
    const typeMatch = trimmed.match(/^(?:export\s+)?type\s+(\w+)\s*=/);
    if (typeMatch) types.push({ name: typeMatch[1], line: lineNum });
  }

  return { imports, exports, functions, classes, interfaces, types };
}

// ── Python ─────────────────────────────────────────────────

function parsePython(content) {
  const imports = [];
  const functions = [];
  const classes = [];
  const decorators = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const lineNum = i + 1;

    const importMatch = trimmed.match(/^(?:from\s+(\S+)\s+)?import\s+(.+)/);
    if (importMatch) {
      imports.push({ from: importMatch[1] || '', names: importMatch[2].trim() });
      continue;
    }

    if (trimmed.startsWith('@')) {
      decorators.push(trimmed);
      continue;
    }

    const fnMatch = trimmed.match(/^(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/);
    if (fnMatch) {
      functions.push({ name: fnMatch[1], params: fnMatch[2].trim(), line: lineNum });
      continue;
    }

    const classMatch = trimmed.match(/^class\s+(\w+)(?:\(([^)]*)\))?/);
    if (classMatch) {
      classes.push({ name: classMatch[1], bases: classMatch[2] || '', line: lineNum });
    }
  }

  return { imports, functions, classes, decorators };
}

// ── Go ─────────────────────────────────────────────────────

function parseGo(content) {
  const imports = [];
  const functions = [];
  const structs = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    const importMatch = trimmed.match(/^import\s+"([^"]+)"/);
    if (importMatch) imports.push(importMatch[1]);

    const fnMatch = trimmed.match(/^func\s+(?:\((\w+)\s+\*?(\w+)\)\s+)?(\w+)\s*\(([^)]*)\)/);
    if (fnMatch) {
      functions.push({
        name: fnMatch[3],
        params: fnMatch[4]?.trim() || '',
        receiver: fnMatch[2] || null,
      });
    }

    const structMatch = trimmed.match(/^type\s+(\w+)\s+struct/);
    if (structMatch) structs.push(structMatch[1]);
  }

  return { imports, functions, structs };
}

// ── Rust ───────────────────────────────────────────────────

function parseRust(content) {
  const functions = [];
  const structs = [];
  const impls = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    const fnMatch = trimmed.match(/^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*\(([^)]*)\)/);
    if (fnMatch) functions.push({ name: fnMatch[1], params: fnMatch[2].trim() });

    const structMatch = trimmed.match(/^(?:pub\s+)?struct\s+(\w+)/);
    if (structMatch) structs.push(structMatch[1]);

    const implMatch = trimmed.match(/^impl\s+(?:<[^>]+>\s+)?(\w+)/);
    if (implMatch) impls.push(implMatch[1]);
  }

  return { functions, structs, impls };
}

// ── Generic fallback ───────────────────────────────────────

function parseGeneric(content) {
  const functions = [];
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    // Try common patterns
    const fnMatch = trimmed.match(/^(?:(?:pub|public|private|protected|static|async|export)\s+)*(?:function|def|fn|func)\s+(\w+)/);
    if (fnMatch) functions.push({ name: fnMatch[1] });
  }

  return { functions };
}

// ── Summary Builder ────────────────────────────────────────

function buildSummary(structure) {
  const parts = [];
  parts.push(`${structure.file} (${structure.lines} lines, ${structure.language})`);
  parts.push(`Use read_file with start_line/end_line to read specific sections.`);
  parts.push('');

  if (structure.classes?.length) {
    for (const cls of structure.classes) {
      const ext = cls.extends ? ` extends ${cls.extends}` : (cls.bases ? `(${cls.bases})` : '');
      const ln = cls.line ? ` [line ${cls.line}]` : '';
      parts.push(`  class ${cls.name}${ext}${ln}`);
    }
  }

  if (structure.interfaces?.length) {
    const ifaceList = structure.interfaces.map(i =>
      typeof i === 'string' ? i : `${i.name} [line ${i.line}]`
    ).join(', ');
    parts.push(`  interfaces: ${ifaceList}`);
  }

  if (structure.types?.length) {
    const typeList = structure.types.map(t =>
      typeof t === 'string' ? t : `${t.name} [line ${t.line}]`
    ).join(', ');
    parts.push(`  types: ${typeList}`);
  }

  if (structure.functions?.length) {
    for (const fn of structure.functions.slice(0, 20)) {
      const receiver = fn.receiver ? `(${fn.receiver}) ` : '';
      const method = fn.isMethod ? '  ' : '';
      const ln = fn.line ? ` [line ${fn.line}]` : '';
      parts.push(`${method}  ${receiver}${fn.name}(${fn.params || ''})${ln}`);
    }
    if (structure.functions.length > 20) {
      parts.push(`  ... and ${structure.functions.length - 20} more functions`);
    }
  }

  if (structure.structs?.length) {
    parts.push(`  structs: ${structure.structs.join(', ')}`);
  }

  if (structure.imports?.length) {
    const importSummary = structure.imports.slice(0, 5).map(i =>
      i.from ? `${i.from}` : (typeof i === 'string' ? i : i.names)
    ).join(', ');
    const more = structure.imports.length > 5 ? ` +${structure.imports.length - 5} more` : '';
    parts.push(`  imports: ${importSummary}${more}`);
  }

  if (structure.exports?.length) {
    parts.push(`  exports: ${structure.exports.join(', ')}`);
  }

  return parts.join('\n');
}
