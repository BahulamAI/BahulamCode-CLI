// Embedded in the local workspace's browser script. Raw HTML stays plain text.
function inlineMd(source, depth = 0) {
  const text = String(source ?? '');
  if (depth > 6) return esc(text);
  const pattern = /(`+)([\s\S]*?)\1|\[([^\]\n]+)\]\(([^\s)]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|\*([^*\n]+)\*/g;
  let html = '', offset = 0;
  for (const match of text.matchAll(pattern)) {
    html += esc(text.slice(offset, match.index));
    if (match[1]) html += '<code>' + esc(match[2]) + '</code>';
    else if (match[3]) {
      const href = match[4];
      const allowed = /^(?:https?:\/\/|mailto:|#|\/(?!\/)|\.\.?\/)/i.test(href);
      html += allowed ? '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + inlineMd(match[3], depth + 1) + '</a>' : esc(match[3]);
    } else if (match[5] || match[6]) html += '<strong>' + inlineMd(match[5] || match[6], depth + 1) + '</strong>';
    else if (match[7]) html += '<del>' + inlineMd(match[7], depth + 1) + '</del>';
    else html += '<em>' + inlineMd(match[8], depth + 1) + '</em>';
    offset = match.index + match[0].length;
  }
  return html + esc(text.slice(offset));
}

function markdownTableCells(line) {
  const text = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  const cells = []; let cell = '', codeFence = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && text[i + 1] === '|') { cell += '|'; i++; continue; }
    if (text[i] === '`') {
      let count = 1;
      while (text[i + count] === '`') count++;
      codeFence = codeFence === count ? 0 : codeFence || count;
      cell += '`'.repeat(count); i += count - 1; continue;
    }
    if (text[i] === '|' && !codeFence) { cells.push(cell.trim()); cell = ''; }
    else cell += text[i];
  }
  cells.push(cell.trim());
  return cells;
}

function markdown(text, depth = 0) {
  if (depth > 8) return '<p>' + esc(text) + '</p>';
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const listPattern = /^( *)([-+*]|\d+[.)])\s+(.*)$/;
  const fencePattern = /^ {0,3}(`{3,}|~{3,})(.*)$/;
  const tableDivider = line => markdownTableCells(line || '').every(cell => /^:?-{3,}:?$/.test(cell));
  let out = '', index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    const fence = line.match(fencePattern);
    if (fence) {
      const language = fence[2].trim().split(/\s+/)[0], code = [];
      index++;
      while (index < lines.length) {
        const closing = lines[index].trim();
        if (closing.length >= fence[1].length && [...closing].every(char => char === fence[1][0])) { index++; break; }
        code.push(lines[index++]);
      }
      out += language === 'mermaid' ? mermaidCard(code.join('\n')) : '<pre><code>' + esc(code.join('\n')) + '</code></pre>';
      continue;
    }
    const heading = line.match(/^ {0,3}(#{1,6})\s+(.*)$/);
    if (heading) { out += '<h' + heading[1].length + '>' + inlineMd(heading[2]) + '</h' + heading[1].length + '>'; index++; continue; }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out += '<hr>'; index++; continue; }
    if (line.includes('|') && index + 1 < lines.length && tableDivider(lines[index + 1])) {
      const headers = markdownTableCells(line), align = markdownTableCells(lines[index + 1]);
      const cls = i => /^:.*:$/.test(align[i]) ? 'md-center' : /:$/.test(align[i]) ? 'md-right' : 'md-left';
      index += 2;
      out += '<div class="message-table"><table><thead><tr>' + headers.map((h, i) => '<th class="' + cls(i) + '">' + inlineMd(h) + '</th>').join('') + '</tr></thead><tbody>';
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        const row = markdownTableCells(lines[index++]);
        out += '<tr>' + headers.map((_, i) => '<td class="' + cls(i) + '">' + inlineMd(row[i] || '') + '</td>').join('') + '</tr>';
      }
      out += '</tbody></table></div>'; continue;
    }
    if (/^\s*>/.test(line)) {
      const quote = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) quote.push(lines[index++].replace(/^\s*> ?/, ''));
      out += '<blockquote>' + markdown(quote.join('\n'), depth + 1) + '</blockquote>'; continue;
    }
    const list = line.match(listPattern);
    if (list) {
      const ordered = /^\d/.test(list[2]), tag = ordered ? 'ol' : 'ul', indent = list[1].length;
      out += '<' + tag + (ordered ? ' start="' + parseInt(list[2], 10) + '"' : '') + '>';
      while (index < lines.length) {
        const item = lines[index].match(listPattern);
        if (!item || item[1].length !== indent || /^\d/.test(item[2]) !== ordered) break;
        const content = [item[3]], padding = item[0].length - item[3].length;
        index++;
        while (index < lines.length && (lines[index].trim() === '' || /^\s/.test(lines[index]) && lines[index].search(/\S/) > indent)) {
          content.push(lines[index++].slice(padding));
        }
        out += '<li>' + markdown(content.join('\n'), depth + 1) + '</li>';
      }
      out += '</' + tag + '>'; continue;
    }
    const paragraph = [line]; index++;
    while (index < lines.length && lines[index].trim() && !fencePattern.test(lines[index]) && !listPattern.test(lines[index]) && !/^\s*(?:#{1,6}\s|>|-{3,}\s*$|\*{3,}\s*$|_{3,}\s*$)/.test(lines[index]) && !(lines[index].includes('|') && tableDivider(lines[index + 1]))) paragraph.push(lines[index++]);
    out += '<p>' + inlineMd(paragraph.join('\n')).replace(/ {2}\n/g, '<br>').replace(/\n/g, ' ') + '</p>';
  }
  return out;
}
