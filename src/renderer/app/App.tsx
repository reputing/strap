import { lazy, Suspense, useEffect, useState } from 'react';
import { on } from '@renderer/lib/api';
import { Loading, ToastProvider, useToast } from '@renderer/components/ui';
import { Rail, StatusBar, TitleBar, useShellState } from './Shell';
import { Palette } from './Palette';
import { Home } from '@renderer/pages/Home';

/**
 * Home is bundled with the shell because it is what opens; every other page is
 * a separate chunk loaded when it is first visited. On a cold start that is the
 * difference between parsing one page and parsing eleven.
 */
const Launch = lazy(() => import('@renderer/pages/Launch').then((m) => ({ default: m.Launch })));
const Optimizer = lazy(() => import('@renderer/pages/Optimizer').then((m) => ({ default: m.Optimizer })));
const Profiles = lazy(() => import('@renderer/pages/Profiles').then((m) => ({ default: m.Profiles })));
const Modifications = lazy(() => import('@renderer/pages/Modifications').then((m) => ({ default: m.Modifications })));
const FastFlags = lazy(() => import('@renderer/pages/FastFlags').then((m) => ({ default: m.FastFlags })));
const Assets = lazy(() => import('@renderer/pages/Assets').then((m) => ({ default: m.Assets })));
const Cache = lazy(() => import('@renderer/pages/Cache').then((m) => ({ default: m.Cache })));
const Appearance = lazy(() => import('@renderer/pages/Appearance').then((m) => ({ default: m.Appearance })));
const Diagnostics = lazy(() => import('@renderer/pages/Diagnostics').then((m) => ({ default: m.Diagnostics })));
const Settings = lazy(() => import('@renderer/pages/Settings').then((m) => ({ default: m.Settings })));

export function App() {
  return (
    <ToastProvider>
      <Root />
    </ToastProvider>
  );
}

function Root() {
  const shell = useShellState();
  const toast = useToast();
  const [palette, setPalette] = useState<'command' | 'search' | null>(null);

  // Toasts raised by the main process — a failed tray launch, a Roblox update.
  useEffect(() => on('toast', (payload) => toast(payload)), [toast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement
        && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette(e.shiftKey ? 'command' : 'search');
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p' && e.shiftKey) {
        e.preventDefault();
        setPalette('command');
        return;
      }
      // A bare slash focuses search, the way every tool with a list does.
      if (e.key === '/' && !typing && !palette) {
        e.preventDefault();
        setPalette('search');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [palette]);

  const flagCount = shell.profile ? Object.keys(shell.profile.fastFlags).length : 0;

  return (
    <div className="app">
      <TitleBar onOpenPalette={() => setPalette('command')} onOpenSearch={() => setPalette('search')} />

      <Rail
        route={shell.route}
        navigate={shell.navigate}
        badges={{
          '/fastflags': flagCount ? String(flagCount) : undefined,
          '/assets': shell.interception?.status === 'running' ? '●' : undefined
        }}
      />

      <main className="main">
        <Suspense fallback={<div className="page"><Loading /></div>}>
          <Page shell={shell} />
        </Suspense>
      </main>

      <StatusBar state={shell} />

      {palette ? (
        <Palette
          mode={palette}
          onClose={() => setPalette(null)}
          onNavigate={shell.navigate}
        />
      ) : null}
    </div>
  );
}

function Page({ shell }: { shell: ReturnType<typeof useShellState> }) {
  const base = shell.route.split('?')[0];

  // A `key` per route restarts page state on navigation, which is what makes
  // the enter animation read as a page change rather than a re-render.
  switch (base) {
    case '/home': return <Home key="home" shell={shell} />;
    case '/launch': return <Launch key="launch" shell={shell} />;
    case '/optimizer': return <Optimizer key="optimizer" shell={shell} />;
    case '/profiles': return <Profiles key="profiles" shell={shell} />;
    case '/modifications': return <Modifications key="modifications" shell={shell} navigate={shell.navigate} />;
    case '/fastflags': return <FastFlags key="fastflags" shell={shell} />;
    case '/assets': return <Assets key="assets" shell={shell} />;
    case '/cache': return <Cache key="cache" />;
    case '/appearance': return <Appearance key="appearance" shell={shell} />;
    case '/diagnostics': return <Diagnostics key="diagnostics" />;
    case '/settings': return <Settings key="settings" shell={shell} />;
    default: return <Home key="home-default" shell={shell} />;
  }
}
