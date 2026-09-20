import type { CommandDescriptor, SearchHit } from '@shared/types';
import { FLAG_CATALOG } from '@main/fastflags/catalog';
import { OPTIMIZATION_CATALOG } from '@main/optimizer/catalog';

/** Pages and settings the search knows about, independent of runtime state. */
interface StaticEntry {
  kind: SearchHit['kind'];
  id: string;
  title: string;
  subtitle: string;
  route: string;
  keywords: string[];
}

const STATIC_ENTRIES: StaticEntry[] = [
  { kind: 'page', id: 'home', title: 'Home', subtitle: 'Status and quick actions', route: '/home', keywords: ['dashboard', 'status', 'launch'] },
  { kind: 'page', id: 'launch', title: 'Launch', subtitle: 'Start Roblox with a profile', route: '/launch', keywords: ['play', 'start', 'run', 'open'] },
  { kind: 'page', id: 'optimizer', title: 'Optimizer', subtitle: 'Presets and individual optimizations', route: '/optimizer', keywords: ['performance', 'fps', 'speed', 'preset', 'tune'] },
  { kind: 'page', id: 'profiles', title: 'Profiles', subtitle: 'Create, edit and switch profiles', route: '/profiles', keywords: ['config', 'preset', 'setup'] },
  { kind: 'page', id: 'modifications', title: 'Modifications', subtitle: 'Everything Blossom is changing', route: '/modifications', keywords: ['mods', 'changes', 'diff', 'overview'] },
  { kind: 'page', id: 'assets', title: 'Assets', subtitle: 'Replacement rules and live capture', route: '/assets', keywords: ['texture', 'sound', 'mesh', 'replace', 'capture', 'intercept'] },
  { kind: 'page', id: 'cache', title: 'Cache', subtitle: 'Browse captured assets', route: '/cache', keywords: ['texture', 'image', 'audio', 'storage', 'disk', 'duplicates'] },
  { kind: 'page', id: 'fastflags', title: 'FastFlags', subtitle: 'Engine flag overrides', route: '/fastflags', keywords: ['flags', 'fflag', 'dfint', 'engine'] },
  { kind: 'page', id: 'overlay', title: 'Overlay', subtitle: 'Crosshair and performance HUD', route: '/appearance', keywords: ['crosshair', 'hud', 'fps counter', 'aim', 'dot'] },
  { kind: 'page', id: 'appearance', title: 'Appearance', subtitle: 'Theme, accent and overlays', route: '/appearance', keywords: ['theme', 'colour', 'color', 'accent', 'dark'] },
  { kind: 'page', id: 'diagnostics', title: 'Diagnostics', subtitle: 'Reports, logs and benchmarks', route: '/diagnostics', keywords: ['logs', 'report', 'benchmark', 'support', 'problem'] },
  { kind: 'page', id: 'settings', title: 'Settings', subtitle: 'Application settings', route: '/settings', keywords: ['options', 'preferences', 'config'] },

  { kind: 'setting', id: 'setting.interception', title: 'Asset interception', subtitle: 'Settings → Asset interception', route: '/settings#interception', keywords: ['proxy', 'certificate', 'replace', 'capture', 'texture'] },
  { kind: 'setting', id: 'setting.updates', title: 'Update channel', subtitle: 'Settings → Updates', route: '/settings#updates', keywords: ['stable', 'preview', 'version', 'upgrade'] },
  { kind: 'setting', id: 'setting.hotkeys', title: 'Hotkeys', subtitle: 'Settings → Hotkeys', route: '/settings#hotkeys', keywords: ['shortcut', 'keyboard', 'global', 'bind'] },
  { kind: 'setting', id: 'setting.tray', title: 'Close to tray', subtitle: 'Settings → Window behaviour', route: '/settings#window', keywords: ['tray', 'background', 'minimise', 'minimize'] },
  { kind: 'setting', id: 'setting.protocol', title: 'Handle Roblox links', subtitle: 'Settings → Integration', route: '/settings#integration', keywords: ['protocol', 'deeplink', 'browser', 'join'] },
  { kind: 'setting', id: 'setting.cache-budget', title: 'Cache size limit', subtitle: 'Settings → Asset interception', route: '/settings#interception', keywords: ['disk', 'storage', 'budget', 'space'] },
  { kind: 'setting', id: 'setting.logs', title: 'Log level', subtitle: 'Settings → Diagnostics', route: '/settings#diagnostics', keywords: ['trace', 'debug', 'verbose', 'logging'] }
];

export const COMMANDS: CommandDescriptor[] = [
  { id: 'launch.roblox', title: 'Launch Roblox', group: 'Roblox', keywords: ['play', 'start', 'run'], shortcut: 'Ctrl+L' },
  { id: 'launch.close', title: 'Close Roblox', group: 'Roblox', keywords: ['quit', 'kill', 'stop'] },
  { id: 'roblox.rescan', title: 'Rescan for Roblox', group: 'Roblox', keywords: ['detect', 'find', 'refresh'] },
  { id: 'roblox.open-folder', title: 'Open the Roblox folder', group: 'Roblox', keywords: ['explorer', 'files', 'version'] },
  { id: 'roblox.repair', title: 'Repair Roblox', group: 'Roblox', keywords: ['fix', 'reset', 'clean'] },
  { id: 'roblox.clear-cache', title: 'Clear Roblox temporary cache', group: 'Roblox', keywords: ['temp', 'clean', 'reset'] },

  { id: 'nav.optimizer', title: 'Open the Optimizer', group: 'Navigate', keywords: ['performance', 'fps'] },
  { id: 'nav.profiles', title: 'Open Profiles', group: 'Navigate', keywords: ['config'] },
  { id: 'nav.assets', title: 'Open Assets', group: 'Navigate', keywords: ['replace', 'texture'] },
  { id: 'nav.cache', title: 'Open the Cache browser', group: 'Navigate', keywords: ['assets', 'storage'] },
  { id: 'nav.fastflags', title: 'Open FastFlags', group: 'Navigate', keywords: ['flags'] },
  { id: 'nav.diagnostics', title: 'Open Diagnostics', group: 'Navigate', keywords: ['logs', 'report'] },
  { id: 'nav.settings', title: 'Open Settings', group: 'Navigate', keywords: ['preferences'] },

  { id: 'profile.create', title: 'Create a profile', group: 'Profiles', keywords: ['new', 'add'] },
  { id: 'optimizer.apply-recommended', title: 'Apply the recommended preset', group: 'Optimizer', keywords: ['auto', 'recommend', 'tune'] },
  { id: 'optimizer.undo', title: 'Undo the last optimization', group: 'Optimizer', keywords: ['revert', 'rollback'] },
  { id: 'optimizer.reset', title: 'Reset modifications to Roblox defaults', group: 'Optimizer', keywords: ['default', 'clean', 'revert'] },

  { id: 'capture.start', title: 'Start asset capture', group: 'Assets', keywords: ['record', 'watch', 'live'] },
  { id: 'capture.stop', title: 'Stop asset capture', group: 'Assets', keywords: ['record', 'halt'] },
  { id: 'interception.toggle', title: 'Pause or resume interception', group: 'Assets', keywords: ['proxy', 'pause', 'resume'] },
  { id: 'cache.clear', title: 'Clear the asset cache', group: 'Assets', keywords: ['delete', 'empty', 'space'] },

  { id: 'overlay.toggle-crosshair', title: 'Toggle the crosshair', group: 'Overlay', keywords: ['aim', 'dot', 'cross'] },
  { id: 'overlay.toggle-hud', title: 'Toggle the performance HUD', group: 'Overlay', keywords: ['fps', 'stats', 'cpu'] },

  { id: 'diagnostics.report', title: 'Copy a diagnostics report', group: 'Diagnostics', keywords: ['support', 'bug', 'help'] },
  { id: 'diagnostics.benchmark', title: 'Run all benchmarks', group: 'Diagnostics', keywords: ['measure', 'test', 'speed'] },
  { id: 'app.check-updates', title: 'Check for updates', group: 'Application', keywords: ['version', 'upgrade'] },
  { id: 'app.open-logs', title: 'Open the log folder', group: 'Application', keywords: ['files', 'explorer', 'debug'] }
];

export interface SearchSources {
  profiles: () => { id: string; name: string; description: string }[];
  ruleSets: () => { id: string; name: string; description: string }[];
  activeFlags: () => Record<string, string>;
}

/**
 * One search box over everything.
 *
 * Scoring is deliberately simple and predictable: an exact match beats a prefix
 * match beats a word-boundary match beats a substring. Users learn a ranking
 * that behaves the same way every time far faster than they learn a clever one.
 */
export class SearchService {
  constructor(private readonly sources: SearchSources) {}

  query(raw: string): SearchHit[] {
    const term = raw.trim().toLowerCase();
    if (term.length < 1) return [];

    const hits: SearchHit[] = [];
    const add = (hit: Omit<SearchHit, 'score'>, haystacks: string[]) => {
      const score = bestScore(term, haystacks);
      if (score > 0) hits.push({ ...hit, score });
    };

    for (const entry of STATIC_ENTRIES) {
      add(
        { kind: entry.kind, id: entry.id, title: entry.title, subtitle: entry.subtitle, route: entry.route },
        [entry.title, entry.subtitle, ...entry.keywords]
      );
    }

    for (const profile of this.sources.profiles()) {
      add(
        { kind: 'profile', id: profile.id, title: profile.name, subtitle: profile.description || 'Profile', route: `/profiles?id=${profile.id}` },
        [profile.name, profile.description, 'profile']
      );
    }

    for (const set of this.sources.ruleSets()) {
      add(
        { kind: 'asset', id: set.id, title: set.name, subtitle: set.description || 'Asset rule set', route: `/assets?set=${set.id}` },
        [set.name, set.description, 'asset', 'replacement', 'rules']
      );
    }

    const active = this.sources.activeFlags();
    for (const flag of FLAG_CATALOG) {
      const isSet = active[flag.name] !== undefined;
      add(
        {
          kind: 'flag',
          id: flag.name,
          title: flag.name,
          subtitle: isSet ? `Set to ${active[flag.name]} — ${flag.category}` : flag.description.slice(0, 90),
          route: `/fastflags?flag=${encodeURIComponent(flag.name)}`
        },
        [flag.name, flag.description, flag.category]
      );
    }

    for (const action of OPTIMIZATION_CATALOG) {
      add(
        { kind: 'action', id: action.id, title: action.title, subtitle: `Optimizer — ${action.category}`, route: `/optimizer?action=${action.id}` },
        [action.title, action.description, action.category, action.mechanism]
      );
    }

    for (const command of COMMANDS) {
      add(
        { kind: 'command', id: command.id, title: command.title, subtitle: command.group, route: `command:${command.id}` },
        [command.title, command.group, ...command.keywords]
      );
    }

    return hits
      .sort((a, b) => (b.score - a.score) || a.title.localeCompare(b.title))
      .slice(0, 40);
  }
}

/** Highest score any haystack produces for the term. */
export function bestScore(term: string, haystacks: string[]): number {
  let best = 0;
  for (const raw of haystacks) {
    if (!raw) continue;
    const hay = raw.toLowerCase();
    let score = 0;

    if (hay === term) score = 100;
    else if (hay.startsWith(term)) score = 80;
    else if (new RegExp(`\\b${escapeRegExp(term)}`).test(hay)) score = 60;
    else if (hay.includes(term)) score = 35;

    // A hit in a short field is more likely to be what the user meant than the
    // same hit buried in a long description.
    if (score > 0) score += Math.max(0, 20 - Math.floor(hay.length / 10));
    if (score > best) best = score;
  }
  return best;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
