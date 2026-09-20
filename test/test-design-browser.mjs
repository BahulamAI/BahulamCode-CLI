/**
 * Optional visual regression smoke test. Uses an isolated workspace and never
 * sends a prompt or uses real credentials. Install Playwright separately, or
 * set PLAYWRIGHT_MODULE to an existing installation.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-design-fixture-'));
const artifacts = process.env.BROWSER_ARTIFACT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-design-'));
const originalHome = process.env.BAHULAM_HOME;
process.env.BAHULAM_HOME = path.join(fixture, 'home');
const workspace = path.join(fixture, 'project');
fs.mkdirSync(workspace);
fs.writeFileSync(path.join(workspace, 'README.md'), '# A workspace for your next idea\n\nPlan, build, and review with Bahulam Code.\n\n## Start with context\n\nOpen a file to inspect your project. Ask the agent to explain it, plan a change, or review your work.\n\n## Stay in control\n\nReview tool approvals before changes run.\n\n```sh\nbahulam-code\n```\n');
fs.writeFileSync(path.join(workspace, 'app.mjs'), 'export const message = "Hello, Bahulam.";\n');
fs.writeFileSync(path.join(workspace, 'package.json'), '{"name":"local-project","private":true}\n');
const { createLocalWorkspaceSession } = await import('../src/local-service/session-store.mjs');
const { startLocalWorkspaceService } = await import('../src/local-service/server.mjs');
const { getLoginSuccessHTML } = await import('../src/ui/banner.mjs');
const grant = createLocalWorkspaceSession({ targetPath: path.join(workspace, 'README.md') });
let service;
let browser;
try {
  service = await startLocalWorkspaceService(grant);
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/plugin-views**', route => route.fulfill({ json: { ok: true, views: [] } }));
  await page.goto(service.url);
  await page.locator('.markdown-preview h1').waitFor();
  await page.locator('.session-dialog').waitFor();
  await page.keyboard.press('Escape');
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: path.join(artifacts, 'workspace-' + width + '.png'), fullPage: true });
    if (process.argv.includes('--capture-only')) continue;
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'page overflow at ' + width);
    assert.equal(await page.locator('#approvalAuto').isChecked(), false);
    await page.locator('#prompt').focus();
    assert.equal(await page.locator('#prompt').evaluate(el => el === document.activeElement), true);
    await page.locator('#traceTab').click();
    assert.equal(await page.locator('#traceTab').getAttribute('aria-selected'), 'true');
    await page.locator('#chatTab').click();
    await page.locator('#toggleExplorer').click();
    assert.equal(await page.locator('#filesPanel').isVisible(), false);
    await page.locator('#toggleAgent').click();
    assert.equal(await page.locator('#agentPanel').isVisible(), false);
    assert.equal(await page.locator('.work').isVisible(), true);
    if (width > 900) {
      assert.ok((await page.locator('.work').boundingBox()).width >= width - 2, 'hidden panes should reclaim their space');
    }
    await page.locator('#toggleExplorer').click();
    await page.locator('#toggleAgent').click();
    await page.locator('#sessionMenuButton').click();
    assert.equal(await page.locator('.session-dialog').isVisible(), true);
    await page.keyboard.press('Escape');
    await page.locator('#fileSearch').fill('app.mjs');
    await page.getByRole('button', { name: /app.mjs/ }).waitFor();
    await page.locator('#fileSearch').fill('');
  }
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  const mobilePage = await mobile.newPage();
  mobilePage.on('pageerror', error => errors.push(error.message));
  await mobilePage.route('**/api/plugin-views**', route => route.fulfill({ json: { ok: true, views: [] } }));
  await mobilePage.goto(service.url);
  await mobilePage.locator('.session-dialog').waitFor();
  await mobilePage.getByRole('button', { name: 'Close chat sessions' }).tap();
  for (const selector of ['#toggleExplorer', '#toggleAgent', '#chatTab', '#traceTab', '.filter-chip', 'button.primary', '.auto-toggle']) {
    assert.ok((await mobilePage.locator(selector).first().boundingBox()).height >= 44, selector + ' touch target');
  }
  assert.equal(await mobilePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mobilePage.screenshot({ path: path.join(artifacts, 'workspace-touch.png'), fullPage: true });
  await mobile.close();
  await page.setContent(getLoginSuccessHTML());
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(artifacts, 'login-mobile.png') });
  const pluginCSS = await fetch(new URL('/vendor/bahulam-plugin/bahulam-plugin.css', service.url)).then(r => {
    assert.equal(r.status, 200);
    return r.text();
  });
  await page.setContent('<style>' + pluginCSS + '</style><div class="plugin-page"><header class="plugin-bar"><span class="brand-mark">B</span><h1>Project insights</h1><span class="live-badge live">Local plugin</span></header><main class="plugin-body"><section class="card"><div class="section-head"><h2>Workspace overview</h2><span class="badge primary">Ready</span></div><p class="muted">Tools that work alongside your code.</p><button class="btn primary">Open project</button></section><div class="empty">Your plugin results appear here.<small>Run a task from Bahulam Code to begin.</small></div></main></div>');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(artifacts, 'plugin-mobile.png') });
  assert.deepEqual(errors, []);
  console.log('Browser checks passed. Screenshots: ' + artifacts);
} finally {
  await browser?.close();
  await service?.close();
  fs.rmSync(fixture, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.BAHULAM_HOME;
  else process.env.BAHULAM_HOME = originalHome;
}
