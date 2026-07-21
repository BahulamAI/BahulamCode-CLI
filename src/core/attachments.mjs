import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_TURN_BYTES = 20 * 1024 * 1024;

function envInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function expandHome(filePath) {
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/')) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

export function resolveAttachmentPath(filePath, cwd = process.cwd()) {
  const expanded = expandHome(String(filePath || '').trim());
  return path.resolve(cwd, expanded);
}

function trimTrailingPunctuation(value) {
  return String(value || '').replace(/[),.;:!?]+$/g, '');
}

function readQuoted(input, start) {
  const quote = input[start];
  let out = '';
  let i = start + 1;
  for (; i < input.length; i++) {
    const ch = input[i];
    if (ch === '\\' && i + 1 < input.length) {
      out += input[i + 1];
      i++;
      continue;
    }
    if (ch === quote) return { value: out, end: i + 1 };
    out += ch;
  }
  return null;
}

function readBare(input, start) {
  let i = start;
  while (i < input.length && !/\s/.test(input[i])) i++;
  return { value: trimTrailingPunctuation(input.slice(start, i)), end: i };
}

function looksLikeImagePath(value) {
  const ext = path.extname(String(value || '').toLowerCase());
  return IMAGE_EXTENSIONS.has(ext);
}

export function parseImageReferences(input, { cwd = process.cwd() } = {}) {
  const text = String(input || '');
  const attachments = [];
  let cleaned = '';
  let i = 0;

  while (i < text.length) {
    if (text[i] !== '@') {
      cleaned += text[i++];
      continue;
    }

    const next = text[i + 1];
    let parsed = null;
    if (next === '"' || next === "'") {
      parsed = readQuoted(text, i + 1);
    } else if (next && !/\s/.test(next)) {
      parsed = readBare(text, i + 1);
    }

    if (!parsed || !looksLikeImagePath(parsed.value)) {
      cleaned += text[i++];
      continue;
    }

    attachments.push({
      raw: parsed.value,
      path: resolveAttachmentPath(parsed.value, cwd),
    });
    i = parsed.end;
  }

  return {
    instruction: cleaned.replace(/\s+/g, ' ').trim(),
    references: attachments,
  };
}

function sniffImage(buffer) {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime_type: 'image/png', ext: '.png' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime_type: 'image/jpeg', ext: '.jpg' };
  }
  if (buffer.length >= 10 && (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a')) {
    return { mime_type: 'image/gif', ext: '.gif' };
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mime_type: 'image/webp', ext: '.webp' };
  }
  return null;
}

function pngDimensions(buffer) {
  if (buffer.length < 24) return {};
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function gifDimensions(buffer) {
  if (buffer.length < 10) return {};
  return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
}

function jpegDimensions(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) break;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  return {};
}

function webpDimensions(buffer) {
  if (buffer.length < 30) return {};
  const chunk = buffer.subarray(12, 16).toString('ascii');
  if (chunk === 'VP8X' && buffer.length >= 30) {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    };
  }
  return {};
}

function imageDimensions(buffer, mimeType) {
  if (mimeType === 'image/png') return pngDimensions(buffer);
  if (mimeType === 'image/jpeg') return jpegDimensions(buffer);
  if (mimeType === 'image/gif') return gifDimensions(buffer);
  if (mimeType === 'image/webp') return webpDimensions(buffer);
  return {};
}

export function publicAttachmentMetadata(attachment) {
  if (!attachment) return null;
  return {
    id: attachment.id,
    kind: 'image',
    source: attachment.source || 'local_file',
    name: attachment.name,
    path: attachment.path,
    mime_type: attachment.mime_type,
    bytes: attachment.bytes,
    width: attachment.width || null,
    height: attachment.height || null,
    sha256: attachment.sha256,
    optimized: Boolean(attachment.optimized),
  };
}

function appleScriptString(value) {
  return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function powershellString(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

function ensureClipboardDir(baseDir = os.tmpdir()) {
  const dir = path.join(baseDir, 'kepler-clipboard-images');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function hasUsableFile(filePath) {
  try {
    return fs.statSync(filePath).isFile() && fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

export function writeClipboardImageToTemp({
  baseDir = os.tmpdir(),
  runner = execFileSync,
  platform = process.platform,
} = {}) {
  const dir = ensureClipboardDir(baseDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const pngPath = path.join(dir, `clipboard-${stamp}.png`);

  if (platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      '$image = [System.Windows.Forms.Clipboard]::GetImage()',
      "if ($null -eq $image) { throw 'Clipboard does not contain an image.' }",
      `$out = ${powershellString(pngPath)}`,
      '$image.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)',
      'Write-Output $out',
    ].join('; ');

    try {
      const savedPath = String(runner('powershell.exe', ['-NoProfile', '-Sta', '-Command', script], {
        encoding: 'utf-8',
        stdio: 'pipe',
        windowsHide: true,
      }) || '').trim().split(/\r?\n/).pop().trim();
      if (hasUsableFile(savedPath)) return savedPath;
      if (hasUsableFile(pngPath)) return pngPath;
    } catch (err) {
      throw new Error(`Clipboard does not contain a readable image. Copy an image, or save it and use /attach <path>. ${err.message || err}`);
    }
    throw new Error('Clipboard image import did not produce an image file.');
  }

  if (platform !== 'darwin') {
    throw new Error('Clipboard image import is currently supported on macOS and Windows. Save the image to a file and use /attach <path>.');
  }

  const tiffPath = path.join(dir, `clipboard-${stamp}.tiff`);

  try {
    runner('pngpaste', [pngPath], { stdio: 'pipe' });
    if (hasUsableFile(pngPath)) return pngPath;
  } catch {
    // pngpaste is optional. Fall through to built-in macOS tools.
  }

  const script = [
    'try',
    '  set imageData to the clipboard as «class PNGf»',
    `  set outPath to ${appleScriptString(pngPath)}`,
    '  set outFile to open for access POSIX file outPath with write permission',
    '  set eof outFile to 0',
    '  write imageData to outFile',
    '  close access outFile',
    '  return outPath',
    'on error',
    '  try',
    '    set imageData to the clipboard as «class TIFF»',
    `    set outPath to ${appleScriptString(tiffPath)}`,
    '    set outFile to open for access POSIX file outPath with write permission',
    '    set eof outFile to 0',
    '    write imageData to outFile',
    '    close access outFile',
    '    return outPath',
    '  on error errMsg number errNum',
    '    error "Clipboard does not contain a supported image." number errNum',
    '  end try',
    'end try',
  ];

  let savedPath = '';
  try {
    savedPath = String(runner('osascript', script.flatMap(line => ['-e', line]), { encoding: 'utf-8', stdio: 'pipe' }) || '').trim();
  } catch (err) {
    throw new Error(`Clipboard does not contain a readable image. Copy an image, or save it and use /attach <path>. ${err.message || err}`);
  }

  if (savedPath.endsWith('.tiff')) {
    try {
      runner('sips', ['-s', 'format', 'png', savedPath, '--out', pngPath], { stdio: 'pipe' });
      if (hasUsableFile(pngPath)) return pngPath;
    } catch (err) {
      throw new Error(`Clipboard image was TIFF but could not be converted to PNG: ${err.message || err}`);
    }
  }

  if (hasUsableFile(savedPath)) return savedPath;
  if (hasUsableFile(pngPath)) return pngPath;
  throw new Error('Clipboard image import did not produce an image file.');
}

export function loadClipboardImageAttachment(options = {}) {
  const filePath = writeClipboardImageToTemp(options);
  const attachment = loadImageAttachment(filePath, options);
  return { ...attachment, source: 'clipboard' };
}

export function attachmentSummaryLine(attachment) {
  const dims = attachment.width && attachment.height ? `${attachment.width}x${attachment.height}` : 'unknown size';
  const kb = Math.max(1, Math.round((attachment.bytes || 0) / 1024));
  return `${attachment.name} ${dims} · ${kb} KB`;
}

export function loadImageAttachment(filePath, { cwd = process.cwd(), maxBytes = DEFAULT_MAX_IMAGE_BYTES } = {}) {
  const resolved = resolveAttachmentPath(filePath, cwd);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error(`Not a file: ${resolved}`);
  if (stat.size > maxBytes) {
    throw new Error(`Image exceeds ${Math.round(maxBytes / 1024 / 1024)} MB: ${resolved}`);
  }

  const buffer = fs.readFileSync(resolved);
  const sniffed = sniffImage(buffer);
  if (!sniffed) throw new Error(`Unsupported or invalid image file: ${resolved}`);

  const ext = path.extname(resolved).toLowerCase();
  if (ext && IMAGE_EXTENSIONS.has(ext) && ext !== sniffed.ext && !(ext === '.jpeg' && sniffed.ext === '.jpg')) {
    throw new Error(`Image extension does not match file contents: ${resolved}`);
  }

  const dims = imageDimensions(buffer, sniffed.mime_type);
  return {
    id: `att_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    kind: 'image',
    source: 'local_file',
    name: path.basename(resolved),
    path: resolved,
    mime_type: sniffed.mime_type,
    bytes: stat.size,
    width: dims.width || null,
    height: dims.height || null,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    data_base64: buffer.toString('base64'),
    optimized: false,
  };
}

export function prepareImageAttachments(input, {
  cwd = process.cwd(),
  extraPaths = [],
  maxImageBytes = envInt('KEPLER_VISION_MAX_IMAGE_BYTES', DEFAULT_MAX_IMAGE_BYTES),
  maxTurnBytes = envInt('KEPLER_VISION_MAX_TURN_BYTES', DEFAULT_MAX_TURN_BYTES),
} = {}) {
  const parsed = parseImageReferences(input, { cwd });
  const paths = [
    ...parsed.references.map(ref => ref.path),
    ...extraPaths.map(p => resolveAttachmentPath(p, cwd)),
  ];
  const uniquePaths = [...new Set(paths)];
  const attachments = uniquePaths.map(p => loadImageAttachment(p, { cwd, maxBytes: maxImageBytes }));
  const totalBytes = attachments.reduce((sum, att) => sum + (att.bytes || 0), 0);
  if (totalBytes > maxTurnBytes) {
    throw new Error(`Attached images exceed ${Math.round(maxTurnBytes / 1024 / 1024)} MB per turn`);
  }
  return {
    instruction: parsed.instruction || String(input || '').trim(),
    attachments,
    metadata: attachments.map(publicAttachmentMetadata),
  };
}

export function appendVisionAnalysisToInstruction(instruction, analysis) {
  const summary = String(analysis?.summary || '').trim();
  if (!summary) return String(instruction || '');
  const attachments = Array.isArray(analysis.attachments) ? analysis.attachments : [];
  const lines = attachments.map((att, index) => {
    const dims = att.width && att.height ? `${att.width}x${att.height}` : 'unknown dimensions';
    return `${index + 1}. ${att.name || att.id || 'image'} (${att.mime_type || 'image'}, ${dims}, sha256=${String(att.sha256 || '').slice(0, 12)})`;
  });
  return [
    String(instruction || '').trim(),
    '',
    '[Vision analysis]',
    'The primary coding agent does not receive raw image pixels. It receives this technical image analysis:',
    lines.length ? `Images:\n${lines.join('\n')}` : '',
    summary,
  ].filter(Boolean).join('\n');
}
