import { spawn } from 'node:child_process';

export function browserLaunchCommand(url, platform = process.platform) {
  const target = String(url);
  if (platform === 'win32') {
    // `start "URL"` treats the URL as a window title in cmd.exe. Use the
    // Windows URL handler directly so query strings never pass through a shell.
    return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', target] };
  }
  return { command: platform === 'darwin' ? 'open' : 'xdg-open', args: [target] };
}

export function openBrowser(url, { platform = process.platform, spawnProcess = spawn } = {}) {
  const { command, args } = browserLaunchCommand(url, platform);
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, { stdio: 'ignore', shell: false, windowsHide: true });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Browser launcher exited with code ${code}`)));
  });
}
