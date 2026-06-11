#!/usr/bin/env node
/**
 * Kepler Pulse — local analytics dashboard launcher.
 * Launches a Next.js dev server from ~/.kepler-pulse/ cache directory.
 */

const { spawn, exec } = require('child_process')
const net  = require('net')
const os   = require('os')
const path = require('path')
const fs   = require('fs')

const PKG_DIR   = __dirname
const CACHE_DIR = path.join(os.homedir(), '.kepler-pulse')

// ANSI helpers — Kepler cyan palette
const C   = '\x1b[36m'     // cyan
const C2  = '\x1b[96m'     // bright cyan
const DIM = '\x1b[2m'
const B   = '\x1b[1m'
const R   = '\x1b[0m'
const G   = '\x1b[32m'

function printBanner() {
  console.log()
  const configDir = process.env.KEPLER_CONFIG_DIR ?? path.join(os.homedir(), '.kepler')
  console.log(`  ${B}${C}K · E · P · L · E · R${R}`)
  console.log(`  ${B}${C2}Kepler Pulse${R}   ${DIM}real-time agent analytics${R}`)
  console.log()
  console.log(`  ${DIM}Data dir:${R}    ${C2}${configDir}${R}`)
  console.log()
}

function findFreePort(port = 3000) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.on('error', () => resolve(findFreePort(port + 1)))
    server.listen(port, () => server.close(() => resolve(port)))
  })
}

function openBrowser(url) {
  const cmd =
    process.platform === 'darwin' ? `open "${url}"` :
    process.platform === 'win32'  ? `start "" "${url}"` :
                                    `xdg-open "${url}"`
  exec(cmd)
}

// Source dirs/files to mirror into ~/.kepler-pulse/
const SRC_DIRS  = ['app', 'components', 'lib', 'types', 'public']
const SRC_FILES = ['next.config.ts', 'tsconfig.json', 'postcss.config.mjs', 'components.json']

function syncSource(pkg) {
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  for (const dir of SRC_DIRS) {
    const src = path.join(PKG_DIR, dir)
    if (fs.existsSync(src)) {
      fs.cpSync(src, path.join(CACHE_DIR, dir), { recursive: true, force: true })
    }
  }
  for (const file of SRC_FILES) {
    const src = path.join(PKG_DIR, file)
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(CACHE_DIR, file))
    }
  }
  // Write a minimal package.json with only runtime dependencies
  fs.writeFileSync(path.join(CACHE_DIR, 'package.json'), JSON.stringify({
    name: 'kepler-pulse-runtime',
    version: pkg.version,
    dependencies: pkg.dependencies,
  }, null, 2))
}

async function main() {
  printBanner()

  const pkg = require(path.join(PKG_DIR, 'package.json'))

  // Check whether ~/.kepler-pulse/ is up-to-date for this version
  const versionFile = path.join(CACHE_DIR, '.kepler-pulse-version')
  const cachedVersion = fs.existsSync(versionFile)
    ? fs.readFileSync(versionFile, 'utf8').trim()
    : null

  const nextCli = path.join(CACHE_DIR, 'node_modules', 'next', 'dist', 'bin', 'next')
  const needsSetup = cachedVersion !== pkg.version || !fs.existsSync(nextCli)

  if (needsSetup) {
    console.log(`  ${DIM}Setting up (first run, may take a minute)...${R}\n`)

    syncSource(pkg)

    await new Promise((resolve, reject) => {
      const install = spawn('npm', ['install', '--prefer-offline', '--no-package-lock'], {
        cwd: CACHE_DIR,
        stdio: 'inherit',
        shell: true,
      })
      install.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`npm install failed (exit ${code})`))
      )
    })

    fs.writeFileSync(versionFile, pkg.version)
  }

  const port = await findFreePort(3000)
  const url  = `http://localhost:${port}`

  // Pass KEPLER_CONFIG_DIR to the Next.js process so it reads from ~/.kepler/
  const keplerDir = process.env.KEPLER_CONFIG_DIR ?? path.join(os.homedir(), '.kepler')
  const env = {
    ...process.env,
    PORT: String(port),
    KEPLER_CONFIG_DIR: keplerDir,
    CLAUDE_CONFIG_DIR: keplerDir,
  }

  console.log(`  ${DIM}Starting server on${R} ${C2}${B}${url}${R}\n`)

  const child = spawn(process.execPath, [nextCli, 'dev', '--port', String(port)], {
    cwd: CACHE_DIR,
    stdio: [process.platform === 'win32' ? 'ignore' : 'inherit', 'pipe', 'pipe'],
    env,
  })

  let opened = false

  function checkReady(text) {
    if (!opened && /Local:|ready|started server/i.test(text)) {
      opened = true
      console.log(`\n  ${G}${B}Ready${R}  ${C}${url}${R}\n`)
      openBrowser(url)
    }
  }

  child.stdout.on('data', (d) => { process.stdout.write(d); checkReady(d.toString()) })
  child.stderr.on('data', (d) => { process.stderr.write(d); checkReady(d.toString()) })

  child.on('exit', (code) => process.exit(code ?? 0))

  process.on('SIGINT',  () => { child.kill(); process.exit(0) })
  process.on('SIGTERM', () => { child.kill(); process.exit(0) })
}

main().catch((err) => { console.error(err); process.exit(1) })
