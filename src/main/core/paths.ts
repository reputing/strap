import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Every path Blossom reads or writes is declared here. Nothing else in the app
 * builds a path from environment variables, which is what makes uninstall and
 * diagnostics-redaction tractable.
 */
export interface BlossomPaths {
  /** %LOCALAPPDATA%\BlossomStrap */
  root: string;
  config: string;
  profiles: string;
  assets: string;
  assetIndex: string;
  blobs: string;
  backups: string;
  proxy: string;
  logs: string;
  updates: string;
  mods: string;
  exports: string;
  /** %LOCALAPPDATA%\Roblox */
  robloxRoot: string;
  robloxVersions: string;
  robloxLogs: string;
  /** %TEMP%\Roblox — the client's own HTTP cache lives under here. */
  robloxTemp: string;
}

function localAppData(env: NodeJS.ProcessEnv): string {
  if (env.LOCALAPPDATA) return env.LOCALAPPDATA;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support');
  return env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
}

/**
 * Builds the path set. `env` and `overrideRoot` are injectable so tests can run
 * the whole storage layer against a temporary directory on any platform.
 */
export function createPaths(
  env: NodeJS.ProcessEnv = process.env,
  overrideRoot?: string
): BlossomPaths {
  const lad = localAppData(env);
  const root = overrideRoot ?? join(lad, 'BlossomStrap');
  const robloxRoot = join(lad, 'Roblox');
  const assets = join(root, 'assets');

  return {
    root,
    config: join(root, 'config.json'),
    profiles: join(root, 'profiles'),
    assets,
    assetIndex: join(assets, 'index.db'),
    blobs: join(assets, 'blobs'),
    backups: join(root, 'backups'),
    proxy: join(root, 'proxy'),
    logs: join(root, 'logs'),
    updates: join(root, 'updates'),
    mods: join(root, 'mods'),
    exports: join(root, 'exports'),
    robloxRoot,
    robloxVersions: join(robloxRoot, 'Versions'),
    robloxLogs: join(robloxRoot, 'logs'),
    robloxTemp: join(env.TEMP ?? env.TMP ?? tmpdir(), 'Roblox')
  };
}

/**
 * Replaces the user's home/profile directory with a placeholder. Used on every
 * path that can leave the machine through a diagnostics report.
 */
export function redactPath(p: string): string {
  const home = homedir();
  let out = p;
  if (home && out.toLowerCase().startsWith(home.toLowerCase())) {
    out = '%USER%' + out.slice(home.length);
  }
  // Catch C:\Users\<name>\... even when it is not the current home.
  out = out.replace(/([A-Za-z]:\\Users\\)[^\\]+/g, '$1%USER%');
  out = out.replace(/(\/home\/)[^/]+/g, '$1%USER%');
  out = out.replace(/(\/Users\/)[^/]+/g, '$1%USER%');
  return out;
}
