import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { call, on, useEventValue, useQuery } from '@renderer/lib/api';
import { Icon } from '@renderer/components/icons';
import { Dot } from '@renderer/components/ui';
import { GROUP_LABELS, ROUTES, type RouteDef } from './routes';
import type { AppSettings, InterceptionState, Profile, RobloxState } from '@shared/types';

export interface ShellState {
  route: string;
  navigate: (route: string) => void;
  roblox: RobloxState | null;
  settings: AppSettings | null;
  profile: Profile | null;
  interception: InterceptionState | null;
}

export function useShellState(): ShellState {
  const [route, setRoute] = useState('/home');

  const robloxQuery = useQuery('roblox:state', undefined, { on: ['roblox:changed'] });
  const settingsQuery = useQuery('app:settings:get', undefined, { on: ['settings:changed'] });
  const profilesQuery = useQuery('profiles:list', undefined, { on: ['profiles:changed'] });
  const interceptionQuery = useQuery('interception:state', undefined, { on: ['interception:changed'] });

  // The tray, hotkeys and the command palette all navigate through main.
  useEffect(() => on('navigate', ({ route: target }) => setRoute(target)), []);

  const profile = useMemo(() => {
    const list = profilesQuery.data;
    const activeId = settingsQuery.data?.activeProfileId;
    if (!list?.length) return null;
    return list.find((p) => p.id === activeId) ?? list[0] ?? null;
  }, [profilesQuery.data, settingsQuery.data?.activeProfileId]);

  // Appearance is applied at the document root so every surface picks it up.
  useEffect(() => {
    const appearance = profile?.appearance ?? settingsQuery.data?.appearance;
    if (!appearance) return;
    const root = document.documentElement;
    root.dataset['accent'] = appearance.accent;
    root.dataset['density'] = appearance.density;
    root.dataset['reduceMotion'] = String(appearance.reduceMotion);
  }, [profile?.appearance, settingsQuery.data?.appearance]);

  return {
    route,
    navigate: setRoute,
    roblox: robloxQuery.data,
    settings: settingsQuery.data,
    profile,
    interception: interceptionQuery.data
  };
}

export function TitleBar({
  onOpenPalette, onOpenSearch
}: { onOpenPalette: () => void; onOpenSearch: () => void }) {
  return (
    <div className="titlebar">
      <div className="wordmark">
        <span className="petal"><Icon.logo size={14} /></span>
        BLOSSOM STRAP
      </div>

      <button className="btn ghost" onClick={onOpenSearch} style={{ gap: 'var(--s3)', paddingLeft: 'var(--s3)' }}>
        <Icon.search size={13} />
        <span className="dim">Search</span>
        <kbd>Ctrl</kbd><kbd>K</kbd>
      </button>

      <button className="btn ghost" onClick={onOpenPalette} title="Command palette">
        <Icon.grid size={13} />
      </button>

      <div className="spacer" />

      <div className="window-controls">
        <button onClick={() => void call('app:window', 'minimise')} aria-label="Minimise">
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor" strokeWidth="1" /></svg>
        </button>
        <button onClick={() => void call('app:window', 'maximise')} aria-label="Maximise">
          <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth="1" fill="none" /></svg>
        </button>
        <button className="close" onClick={() => void call('app:window', 'close')} aria-label="Close">
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" /></svg>
        </button>
      </div>
    </div>
  );
}

export function Rail({
  route, navigate, badges
}: { route: string; navigate: (r: string) => void; badges: Partial<Record<string, string>> }) {
  const groups = useMemo(() => {
    const out: { group: RouteDef['group']; items: RouteDef[] }[] = [];
    for (const item of ROUTES) {
      const last = out[out.length - 1];
      if (last && last.group === item.group) last.items.push(item);
      else out.push({ group: item.group, items: [item] });
    }
    return out;
  }, []);

  const current = route.split('?')[0];

  return (
    <nav className="rail" aria-label="Sections">
      {groups.map(({ group, items }) => (
        <div key={group}>
          <div className="rail-group-label">{GROUP_LABELS[group]}</div>
          {items.map((item) => {
            const Glyph = Icon[item.icon];
            const badge = badges[item.path];
            return (
              <button
                key={item.path}
                className="rail-item"
                aria-current={current === item.path ? 'page' : undefined}
                onClick={() => navigate(item.path)}
              >
                <span className="icon"><Glyph size={15} /></span>
                {item.label}
                {badge ? <span className="count">{badge}</span> : null}
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

export function StatusBar({ state }: { state: ShellState }) {
  const { roblox, profile, interception } = state;
  const sample = useEventValue('roblox:sample', null);

  const running = (roblox?.processes.length ?? 0) > 0;
  const active = roblox?.active ?? null;

  const robloxLabel = !active
    ? 'Roblox not detected'
    : running ? 'Roblox running' : 'Roblox detected';
  const robloxTone = !active ? 'danger' : running ? 'live' : 'ok';

  const captureQuery = useQuery('capture:state', undefined, { on: ['capture:event'] });
  const cacheQuery = useQuery('cache:stats', undefined, { on: ['cache:changed'] });

  return (
    <div className="statusbar">
      <span className="item"><Dot tone={robloxTone as 'ok' | 'live' | 'danger'} /><strong>{robloxLabel}</strong></span>
      {active ? <span className="item num">{active.clientVersion ?? active.versionGuid.replace('version-', '')}</span> : null}
      <span className="item">Profile <strong>{profile?.name ?? '—'}</strong></span>
      <span className="item">Optimization <strong>{profile ? presetLabel(profile.optimizer.preset) : '—'}</strong></span>

      <span className="spacer" />

      {running && sample ? (
        <>
          {sample.cpuPercent !== null ? <span className="item num">CPU {sample.cpuPercent.toFixed(0)}%</span> : null}
          {sample.memoryBytes !== null ? <span className="item num">{(sample.memoryBytes / 1024 ** 3).toFixed(2)} GB</span> : null}
        </>
      ) : null}

      {captureQuery.data?.active ? (
        <span className="item"><Dot tone="live" />Capturing {captureQuery.data.count}</span>
      ) : null}

      <span className="item">
        <Dot tone={interceptionTone(interception?.status)} />
        Interception <strong>{interception?.status ?? 'stopped'}</strong>
      </span>

      {cacheQuery.data ? (
        <span className="item num">Cache {cacheQuery.data.assetCount.toLocaleString()}</span>
      ) : null}
    </div>
  );
}

function interceptionTone(status: string | undefined): 'idle' | 'ok' | 'warn' | 'danger' {
  switch (status) {
    case 'running': return 'ok';
    case 'degraded': return 'warn';
    case 'failed': return 'danger';
    default: return 'idle';
  }
}

export function presetLabel(preset: string): string {
  return ({
    conservative: 'Conservative',
    balanced: 'Balanced',
    performance: 'Performance',
    'low-end': 'Low End',
    custom: 'Custom'
  } as Record<string, string>)[preset] ?? preset;
}

export function PageHead({
  eyebrow, title, children, actions
}: { eyebrow?: string; title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div className="flex between">
        <div>
          {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
          <h1>{title}</h1>
        </div>
        {actions ? <div className="btn-row">{actions}</div> : null}
      </div>
      {children ? <p>{children}</p> : null}
    </header>
  );
}
