/**
 * Local file preview helpers.
 *
 * These helpers keep formatted preview work inside the local service. Raw
 * bytes remain transport-only; browser panes consume structured rows or cached
 * PDF assets.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as XLSXModule from 'xlsx';
import { resolveWorkspacePath } from './file-access.mjs';
import { localServiceRoot } from './paths.mjs';

const XLSX = XLSXModule.default || XLSXModule;
const MAX_SPREADSHEET_BYTES = 50 * 1024 * 1024;
const MAX_OFFICE_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_SHEETS = 8;
const DEFAULT_MAX_ROWS = 200;
const DEFAULT_MAX_COLS = 60;

export function createSpreadsheetPreview(session, requestedPath, {
  maxSheets = DEFAULT_MAX_SHEETS,
  maxRows = DEFAULT_MAX_ROWS,
  maxCols = DEFAULT_MAX_COLS,
} = {}) {
  const target = resolveWorkspacePath(session, requestedPath);
  const stat = assertPreviewableFile(target, MAX_SPREADSHEET_BYTES);
  const workbook = XLSX.readFile(target, {
    cellFormula: true,
    cellNF: false,
    cellHTML: false,
    cellText: true,
  });

  const root = fs.realpathSync(session.root_path);
  const sheetNames = workbook.SheetNames.slice(0, maxSheets);
  const sheets = sheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const ref = sheet?.['!ref'] || 'A1:A1';
    const range = XLSX.utils.decode_range(ref);
    const rowCount = Math.max(0, range.e.r - range.s.r + 1);
    const columnCount = Math.max(0, range.e.c - range.s.c + 1);
    const rowLimit = Math.min(rowCount, maxRows);
    const columnLimit = Math.min(columnCount, maxCols);
    const columns = Array.from({ length: columnLimit }, (_, index) => (
      XLSX.utils.encode_col(range.s.c + index)
    ));
    const rows = [];

    for (let r = 0; r < rowLimit; r += 1) {
      const cells = [];
      for (let c = 0; c < columnLimit; c += 1) {
        const address = XLSX.utils.encode_cell({ r: range.s.r + r, c: range.s.c + c });
        cells.push(formatSpreadsheetCell(sheet?.[address]));
      }
      rows.push({ number: range.s.r + r + 1, cells });
    }

    return {
      name,
      ref,
      row_count: rowCount,
      column_count: columnCount,
      truncated_rows: rowCount > rowLimit,
      truncated_columns: columnCount > columnLimit,
      columns,
      rows,
    };
  });

  return {
    ok: true,
    type: 'spreadsheet',
    path: relativeToRoot(root, target),
    size: stat.size,
    sheet_count: workbook.SheetNames.length,
    truncated_sheets: workbook.SheetNames.length > sheetNames.length,
    sheets,
  };
}

export function createOfficePdfPreview(session, requestedPath) {
  const target = resolveWorkspacePath(session, requestedPath);
  const stat = assertPreviewableFile(target, MAX_OFFICE_BYTES);
  const libreOffice = findLibreOffice();
  if (!libreOffice) {
    return {
      ok: false,
      code: 'libreoffice_missing',
      message: 'LibreOffice was not found on this machine.',
      install_hint: 'Install LibreOffice or set BAHULAM_LIBREOFFICE_PATH to the soffice executable.',
    };
  }

  const root = fs.realpathSync(session.root_path);
  const cacheId = previewCacheId(target, stat);
  const cacheRoot = previewCacheRoot(session.id);
  const outDir = path.join(cacheRoot, cacheId);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });

  const expectedName = `${path.basename(target, path.extname(target))}.pdf`;
  const expectedPath = path.join(outDir, expectedName);
  if (!fs.existsSync(expectedPath)) {
    const profileDir = path.join(outDir, 'lo-profile');
    fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    const args = [
      '--headless',
      '--nologo',
      '--nodefault',
      '--nofirststartwizard',
      '--nolockcheck',
      '--norestore',
      `-env:UserInstallation=${fileUrl(profileDir)}`,
      '--convert-to',
      'pdf',
      '--outdir',
      outDir,
      target,
    ];
    const result = spawnSync(libreOffice, args, {
      encoding: 'utf-8',
      timeout: 90_000,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) {
      return {
        ok: false,
        code: 'office_conversion_failed',
        message: result.error?.message || result.stderr || result.stdout || 'LibreOffice conversion failed.',
      };
    }
  }

  const pdfPath = fs.existsSync(expectedPath) ? expectedPath : findNewestPdf(outDir);
  if (!pdfPath) {
    return {
      ok: false,
      code: 'office_conversion_missing_output',
      message: 'LibreOffice completed but no PDF output was produced.',
    };
  }

  return {
    ok: true,
    type: 'office_pdf',
    path: relativeToRoot(root, target),
    cache_id: cacheId,
    file_name: path.basename(pdfPath),
    size: fs.statSync(pdfPath).size,
  };
}

export function resolvePreviewCacheFile(session, cachePath) {
  const root = previewCacheRoot(session.id);
  const rel = String(cachePath || '').replace(/^[/\\]+/, '');
  const target = path.resolve(root, rel);
  const rootPath = path.resolve(root);
  const relative = path.relative(rootPath, target);
  if (!rel || relative.startsWith('..') || path.isAbsolute(relative)) {
    const err = new Error('Preview cache path is outside the local preview cache');
    err.code = 'OUTSIDE_WORKSPACE';
    throw err;
  }

  const stat = fs.statSync(target);
  if (!stat.isFile()) {
    const err = new Error('Preview cache path is not a file');
    err.code = 'NOT_FILE';
    throw err;
  }
  return { path: target, stat };
}

function assertPreviewableFile(target, maxBytes) {
  const stat = fs.statSync(target);
  if (!stat.isFile()) {
    const err = new Error('Requested path is not a file');
    err.code = 'NOT_FILE';
    throw err;
  }
  if (stat.size > maxBytes) {
    const err = new Error(`File is larger than ${maxBytes} bytes`);
    err.code = 'FILE_TOO_LARGE';
    throw err;
  }
  return stat;
}

function formatSpreadsheetCell(cell) {
  if (!cell) return { value: '', formula: null };
  const value = cell.w != null ? cell.w : cell.v != null ? String(cell.v) : '';
  return {
    value: String(value),
    formula: cell.f ? `=${cell.f}` : null,
  };
}

function findLibreOffice() {
  const configured = process.env.BAHULAM_LIBREOFFICE_PATH || process.env.LIBREOFFICE_PATH;
  const candidates = configured
    ? [configured]
    : [
        '/Applications/LibreOffice.app/Contents/MacOS/soffice',
        '/opt/homebrew/bin/soffice',
        '/usr/local/bin/soffice',
        '/usr/bin/libreoffice',
        'soffice',
        'libreoffice',
      ];

  for (const candidate of candidates.filter(Boolean)) {
    const result = spawnSync(candidate, ['--version'], {
      encoding: 'utf-8',
      timeout: 5_000,
      windowsHide: true,
    });
    if (!result.error && result.status === 0) return candidate;
  }
  return null;
}

function previewCacheRoot(sessionId) {
  const safeSessionId = String(sessionId || 'session').replace(/[^a-zA-Z0-9_.-]/g, '_');
  const root = path.join(localServiceRoot(), 'previews', safeSessionId);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

function previewCacheId(target, stat) {
  return crypto
    .createHash('sha256')
    .update(`${fs.realpathSync(target)}\0${stat.size}\0${stat.mtimeMs}`)
    .digest('hex')
    .slice(0, 24);
}

function findNewestPdf(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith('.pdf'))
      .map((name) => path.join(dir, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
  } catch {
    return null;
  }
}

function relativeToRoot(root, target) {
  const rel = path.relative(root, target);
  return rel ? rel.split(path.sep).join('/') : '.';
}

function fileUrl(filePath) {
  const resolved = path.resolve(filePath);
  const parts = resolved.split(path.sep).map(encodeURIComponent);
  return `file://${resolved.startsWith(path.sep) ? '' : '/'}${parts.join('/')}`;
}
