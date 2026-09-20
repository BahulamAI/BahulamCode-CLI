/** Small display lexer: calm accents, not a language parser or validator. */
import { paint } from './palette.mjs';

const languages = new Set(['js', 'javascript', 'jsx', 'ts', 'typescript', 'tsx', 'json', 'jsonc', 'py', 'python', 'yaml', 'yml', 'toml', 'sh', 'bash', 'shell']);
const keywords = new Set('async await break case catch class const continue def do else elif except export finally for from function if import in interface let new of pass raise return switch throw try type var while with yield'.split(' '));
const literals = new Set(['true', 'false', 'null', 'undefined', 'True', 'False', 'None']);

export function codeRuns(line, language = '') {
  const text = String(line ?? '');
  const lang = String(language).toLowerCase();
  if (!languages.has(lang)) return [{ text, paint: paint.text.primary }];
  const hashComments = ['py', 'python', 'yaml', 'yml', 'toml', 'sh', 'bash', 'shell'].includes(lang);
  const slashComments = ['js', 'javascript', 'jsx', 'ts', 'typescript', 'tsx', 'jsonc'].includes(lang);
  const structured = ['json', 'jsonc', 'yaml', 'yml', 'toml'].includes(lang);
  const comment = hashComments ? '#[^\\n]*|' : slashComments ? '//[^\\n]*|/\\*.*?\\*/|' : '';
  const tokens = new RegExp(comment + '"(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'|`(?:\\\\.|[^`\\\\])*`|\\b(?:0x[\\da-fA-F]+|\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b|[\\p{L}_$][\\p{L}\\p{N}_$]*|\\s+|.', 'gu');
  return Array.from(text.matchAll(tokens), match => {
    const value = match[0];
    const rest = text.slice(match.index + value.length);
    let painter = paint.text.primary;
    if ((hashComments && value.startsWith('#')) || (slashComments && /^\/[/\*]/.test(value))) painter = paint.text.muted;
    else if (structured && /^(?:["']|[\p{L}_$])/u.test(value) && /^\s*[:=]/.test(rest)) painter = s => paint.bold(paint.syntax.keyword(s));
    else if (/^["'`]/.test(value)) painter = paint.syntax.string;
    else if (/^\d/.test(value) || literals.has(value)) painter = paint.syntax.literal;
    else if (!structured && keywords.has(value)) painter = paint.syntax.keyword;
    return { text: value, paint: painter };
  });
}
