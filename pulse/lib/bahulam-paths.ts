import fs from 'fs'
import path from 'path'
import os from 'os'

export function resolveBahulamDir(): string {
  if (process.env.BAHULAM_CONFIG_DIR) return process.env.BAHULAM_CONFIG_DIR
  if (process.env.BAHULAM_HOME) return process.env.BAHULAM_HOME
  if (process.env.KEPLER_CONFIG_DIR) return process.env.KEPLER_CONFIG_DIR
  if (process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR
  if (process.env.KEPLER_HOME) return process.env.KEPLER_HOME

  const next = path.join(os.homedir(), '.bahulam')
  const legacy = path.join(os.homedir(), '.kepler')
  if (fs.existsSync(next)) return next
  if (fs.existsSync(legacy)) return legacy
  return next
}

export const BAHULAM_DIR = resolveBahulamDir()

export function bahulamPath(...segments: string[]): string {
  return path.join(BAHULAM_DIR, ...segments)
}
