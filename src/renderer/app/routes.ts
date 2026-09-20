import type { IconName } from '@renderer/components/icons';

export interface RouteDef {
  path: string;
  label: string;
  icon: IconName;
  group: 'play' | 'tune' | 'assets' | 'system';
}

/** The navigation rail, in the order it appears. */
export const ROUTES: RouteDef[] = [
  { path: '/home',          label: 'Home',          icon: 'home',        group: 'play' },
  { path: '/launch',        label: 'Launch',        icon: 'play',        group: 'play' },
  { path: '/optimizer',     label: 'Optimizer',     icon: 'gauge',       group: 'tune' },
  { path: '/profiles',      label: 'Profiles',      icon: 'layers',      group: 'tune' },
  { path: '/modifications', label: 'Modifications', icon: 'sliders',     group: 'tune' },
  { path: '/fastflags',     label: 'FastFlags',     icon: 'flag',        group: 'tune' },
  { path: '/assets',        label: 'Assets',        icon: 'image',       group: 'assets' },
  { path: '/cache',         label: 'Cache',         icon: 'database',    group: 'assets' },
  { path: '/appearance',    label: 'Appearance',    icon: 'palette',     group: 'system' },
  { path: '/diagnostics',   label: 'Diagnostics',   icon: 'stethoscope', group: 'system' },
  { path: '/settings',      label: 'Settings',      icon: 'settings',    group: 'system' }
];

export const GROUP_LABELS: Record<RouteDef['group'], string> = {
  play: 'Play',
  tune: 'Configure',
  assets: 'Assets',
  system: 'System'
};

export function routeExists(path: string): boolean {
  const base = path.split('?')[0] ?? path;
  return ROUTES.some((r) => r.path === base);
}
