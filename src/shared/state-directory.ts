import os from 'node:os';
import path from 'node:path';

export function resolveCliStateDirectory(options: {
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
}): string {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const xdg = options.env.XDG_STATE_HOME?.trim();
  if (xdg) return path.resolve(xdg, 'tiangong-lca-cli');
  if (platform === 'win32') {
    const localAppData = options.env.LOCALAPPDATA?.trim();
    if (localAppData) return path.resolve(localAppData, 'tiangong-lca-cli');
  }
  if (homeDir.trim()) {
    return path.resolve(homeDir, '.local', 'state', 'tiangong-lca-cli');
  }
  if (platform === 'darwin') {
    return path.resolve(os.homedir(), 'Library', 'Application Support', 'tiangong-lca-cli');
  }
  return path.resolve('.tiangong-lca-cli-state');
}
