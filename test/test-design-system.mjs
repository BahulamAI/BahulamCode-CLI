import assert from 'node:assert/strict';
import fs from 'node:fs';
import { paint, TOKENS, LIGHT_TOKENS, strip } from '../src/ui/palette.mjs';
import { _setForTesting, refresh } from '../src/ui/term.mjs';
import { renderBanner, printProjectInfo, printAuthStatus, getLoginSuccessHTML } from '../src/ui/banner.mjs';

const vars = ['BAHULAM_THEME', 'COLORFGBG', 'NO_COLOR', 'BAHULAM_PLAIN', 'FORCE_COLOR'];
const saved = Object.fromEntries(vars.map(key => [key, process.env[key]]));
const luminance = rgb => rgb.map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
try {
  for (const key of vars) delete process.env[key];
  for (const [preference, advertised, expected] of [
    ['auto', '0;15', 'light'], ['auto', '0;7', 'light'],
    ['auto', '15;0', 'dark'], ['auto', '', 'dark'],
    ['light', '15;0', 'light'], ['dark', '0;15', 'dark'],
    ['invalid', '0;15', 'light'],
  ]) {
    process.env.BAHULAM_THEME = preference;
    process.env.COLORFGBG = advertised;
    assert.equal(refresh().appearance, expected);
  }
  for (const [appearance, tokens, background] of [
    ['light', LIGHT_TOKENS, [250, 249, 246]],
    ['dark', TOKENS, [28, 31, 41]],
  ]) {
    for (const [key, token] of Object.entries(tokens)) {
      assert.ok(contrast(token.rgb, background) >= 4.5, appearance + ' ' + key + ' contrast');
      for (const colorLevel of ['truecolor', 'ansi256', 'ansi16']) {
        _setForTesting({ appearance, color: true, colorLevel });
        const [namespace, name] = key.split('.');
        const result = paint[namespace][name]('sample');
        assert.equal(strip(result), 'sample');
        const prefix = colorLevel === 'truecolor' ? '\x1b[38;2;' + token.rgb.join(';') + 'm'
          : colorLevel === 'ansi256' ? '\x1b[38;5;' + token.ansi256 + 'm' : '\x1b[';
        assert.ok(result.startsWith(prefix));
        assert.equal(paint.token(key).open, result.slice(0, result.indexOf('sample')));
      }
    }
  }
  process.env.FORCE_COLOR = '3';
  process.env.NO_COLOR = '1';
  refresh();
  assert.equal(paint.brand.primary('plain'), 'plain');
  assert.equal(paint.bold('plain'), 'plain');
  assert.ok(!renderBanner('1.0').includes('\x1b'));
  delete process.env.NO_COLOR;
  process.env.BAHULAM_PLAIN = '1';
  refresh();
  assert.match(renderBanner('1.0'), /^[\x00-\x7F]*$/);

  // Narrow project summaries and restored auth icons must not throw.
  const originalWrite = process.stderr.write;
  let output = '';
  try {
    process.stderr.write = chunk => { output += String(chunk); return true; };
    _setForTesting({ columns: 24, color: false, unicode: false });
    printProjectInfo('0.1.26');
    assert.ok(output.trimEnd().split('\n').every(line => line.length <= 24), output);
    printAuthStatus({ token: null });
    assert.match(output, /not logged in/);
  } finally {
    process.stderr.write = originalWrite;
  }

  const workspace = fs.readFileSync(new URL('../src/local-service/workspace.css', import.meta.url), 'utf8');
  const plugin = fs.readFileSync(new URL('../assets/bahulam-plugin/bahulam-plugin.css', import.meta.url), 'utf8');
  for (const css of [workspace, plugin]) {
    for (const token of ['#FAF9F6', '#202331', '#303BA0', '#606472', '#DEDFE5']) assert.ok(css.includes(token));
    assert.match(css, /focus-visible/);
    assert.match(css, /prefers-reduced-motion/);
    assert.match(css, /pointer: coarse/);
  }
  const html = getLoginSuccessHTML();
  assert.match(html, /<html lang="en">/);
  assert.match(html, /name="viewport"/);
  assert.match(html, /Login successful/);
  assert.ok(!/<script|@import/.test(html));
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
  assert.ok(pkg.files.includes('assets/bahulam-plugin/'));
  console.log('Design system checks passed: themes, contrast, ANSI tiers, plain mode, narrow layouts, browser tokens, and package assets.');
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  _setForTesting(null);
}
