import { useState } from 'react';
import { call, useAction, useQuery } from '@renderer/lib/api';
import { count, relative } from '@renderer/lib/format';
import { Icon } from '@renderer/components/icons';
import {
  Badge, Button, Confirm, Notice, Panel, Row, Section, Select, Toggle, useToast
} from '@renderer/components/ui';
import { PageHead, type ShellState } from '@renderer/app/Shell';
import type { AppSettings, HotkeyAction, LogLevel } from '@shared/types';

const HOTKEY_LABELS: Record<HotkeyAction, string> = {
  'show-window': 'Open Blossom',
  'quick-launch': 'Quick launch Roblox',
  'toggle-interception': 'Pause or resume interception',
  'toggle-capture': 'Start or stop asset capture',
  'toggle-crosshair': 'Toggle the crosshair',
  'toggle-hud': 'Toggle the performance HUD'
};

const CACHE_BUDGETS = [
  { value: String(1024 ** 3), label: '1 GB' },
  { value: String(2 * 1024 ** 3), label: '2 GB' },
  { value: String(4 * 1024 ** 3), label: '4 GB' },
  { value: String(8 * 1024 ** 3), label: '8 GB' },
  { value: String(16 * 1024 ** 3), label: '16 GB' }
];

export function Settings({ shell }: { shell: ShellState }) {
  const toast = useToast();
  const settings = shell.settings;
  const info = useQuery('app:info', undefined);
  const updates = useQuery('updates:state', undefined, { on: ['updates:changed'] });
  const [confirmReset, setConfirmReset] = useState(false);

  const patch = async (changes: Partial<AppSettings>) => {
    const r = await call('app:settings:update', changes);
    if (!r.ok) toast({ kind: 'error', title: 'Could not save', message: r.error.message });
  };

  const checkUpdates = useAction(async () => {
    const r = await call('updates:check', { force: true });
    if (r.ok) {
      toast(r.value.available
        ? { kind: 'success', title: `Version ${r.value.version} is available`, message: r.value.notes ?? undefined }
        : { kind: 'info', title: 'Blossom is up to date' });
    } else {
      toast({ kind: 'warning', title: 'Could not check for updates', message: r.error.message });
    }
    return r;
  });

  const download = useAction(async () => {
    const r = await call('updates:download', undefined);
    if (r.ok) toast({ kind: 'success', title: 'Update downloaded and verified', message: 'Install it to restart into the new version.' });
    else toast({ kind: 'error', title: 'Update failed', message: r.error.message });
    return r;
  });

  const reset = useAction(async () => {
    const r = await call('app:settings:reset', undefined);
    setConfirmReset(false);
    if (r.ok) toast({ kind: 'success', title: 'Settings reset', message: 'Your profiles and cache were not changed.' });
    return r;
  });

  if (!settings) return <div className="page"><PageHead title="Settings" /></div>;

  return (
    <div className="page">
      <PageHead
        eyebrow="Application"
        title="Settings"
        actions={<Button variant="danger" onClick={() => setConfirmReset(true)}>Reset settings</Button>}
      >
        How Blossom itself behaves. Anything that changes Roblox lives in profiles.
      </PageHead>

      <Section title="Window behaviour" >
        <Panel>
          <div className="rows">
            <Row
              name="Close to the tray"
              desc="Closing the window keeps Blossom running so it can watch for Roblox, hold the interception engine and serve hotkeys."
            >
              <Toggle label="Close to tray" checked={settings.closeToTray} onChange={(closeToTray) => void patch({ closeToTray })} />
            </Row>
            <Row name="Start minimised" desc="Open straight to the tray with no window.">
              <Toggle label="Start minimised" checked={settings.startMinimised} onChange={(startMinimised) => void patch({ startMinimised })} />
            </Row>
            <Row name="Start with Windows" desc="Blossom is added to your account's startup items. Removed again when turned off.">
              <Toggle label="Start with Windows" checked={settings.startWithWindows} onChange={(startWithWindows) => void patch({ startWithWindows })} />
            </Row>
            <Row name="Confirm before launching" desc="Show a summary of what will be applied before Roblox starts.">
              <Toggle label="Confirm before launching" checked={settings.confirmBeforeLaunch} onChange={(confirmBeforeLaunch) => void patch({ confirmBeforeLaunch })} />
            </Row>
          </div>
        </Panel>
      </Section>

      <Section title="Integration" >
        <Panel>
          <div className="rows">
            <Row
              name="Handle Blossom links"
              desc="Registers blossom-strap:// for this user account only. Blossom does not take over Roblox's own protocol — that would route every launch from the website through Blossom, which is a large change to make on someone's machine."
            >
              <Toggle
                label="Handle Blossom links"
                checked={settings.registerProtocolHandler}
                onChange={(registerProtocolHandler) => void patch({ registerProtocolHandler })}
              />
            </Row>
          </div>
        </Panel>
      </Section>

      <Section title="Asset interception" >
        <Panel>
          <div className="rows">
            <Row
              name="Enable the interception engine"
              desc="A master switch. A profile can only turn interception on while this is enabled."
            >
              <Toggle
                label="Enable interception"
                checked={settings.interception.enabled}
                onChange={(enabled) => void patch({ interception: { ...settings.interception, enabled } })}
              />
            </Row>
            <Row
              name="Proxy port"
              desc="0 lets Windows pick a free loopback port, which is what most people want."
            >
              <input
                className="input num"
                style={{ width: 90 }}
                type="number"
                min={0}
                max={65535}
                aria-label="Proxy port"
                defaultValue={settings.interception.port}
                onBlur={(e) => void patch({ interception: { ...settings.interception, port: Number(e.target.value) || 0 } })}
              />
            </Row>
            <Row name="Keep captured assets" desc="Store response bodies so replacements and the cache browser have something to work with.">
              <Toggle
                label="Keep captured assets"
                checked={settings.interception.cacheResponses}
                onChange={(cacheResponses) => void patch({ interception: { ...settings.interception, cacheResponses } })}
              />
            </Row>
            <Row name="Cache size limit" desc="Least-recently-used assets are evicted once the cache passes this.">
              <Select
                ariaLabel="Cache size limit"
                value={String(settings.interception.cacheBudgetBytes)}
                options={CACHE_BUDGETS}
                onChange={(v) => void patch({ interception: { ...settings.interception, cacheBudgetBytes: Number(v) } })}
              />
            </Row>
            <Row name="Decrypted hosts" desc="Asset delivery only. Sign-in, account and payment hosts cannot be added.">
              <Badge>{count(settings.interception.scope.length)} hosts</Badge>
            </Row>
          </div>
        </Panel>
      </Section>

      <Section title="Hotkeys" hint="Off until you turn them on">
        <Panel>
          <div className="rows">
            <Row
              name="Global hotkeys"
              desc="Registered system-wide while Blossom is running. A combination another program already owns is reported rather than silently taken."
            >
              <Toggle
                label="Global hotkeys"
                checked={settings.hotkeys.enabled}
                onChange={(enabled) => void patch({ hotkeys: { ...settings.hotkeys, enabled } })}
              />
            </Row>
            {(Object.keys(HOTKEY_LABELS) as HotkeyAction[]).map((action) => (
              <Row key={action} name={HOTKEY_LABELS[action]}>
                <input
                  className="input mono"
                  style={{ width: 160 }}
                  disabled={!settings.hotkeys.enabled}
                  aria-label={HOTKEY_LABELS[action]}
                  defaultValue={settings.hotkeys.bindings[action]}
                  onBlur={(e) => void patch({
                    hotkeys: {
                      ...settings.hotkeys,
                      bindings: { ...settings.hotkeys.bindings, [action]: e.target.value.trim() }
                    }
                  })}
                />
              </Row>
            ))}
          </div>
        </Panel>
      </Section>

      <Section title="Updates">
        <Panel>
          <div className="rows">
            <Row name="Channel" desc="Preview builds get changes earlier and break more often.">
              <Select
                ariaLabel="Update channel"
                value={settings.updates.channel}
                options={[{ value: 'stable', label: 'Stable' }, { value: 'preview', label: 'Preview' }]}
                onChange={(channel) => void patch({ updates: { ...settings.updates, channel } })}
              />
            </Row>
            <Row name="Check automatically" desc="On start, and once a day after that.">
              <Toggle
                label="Check automatically"
                checked={settings.updates.checkAutomatically}
                onChange={(checkAutomatically) => void patch({ updates: { ...settings.updates, checkAutomatically } })}
              />
            </Row>
            <Row
              name="Status"
              desc={
                updates.data?.phase === 'failed'
                  ? updates.data.error ?? 'The last check failed.'
                  : `Last checked ${relative(settings.updates.lastCheckedAt)}.`
              }
            >
              <span className="flex" style={{ gap: 'var(--s3)' }}>
                <Badge tone={updates.data?.phase === 'staged' ? 'ok' : updates.data?.phase === 'failed' ? 'danger' : 'default'}>
                  {updates.data?.phase ?? 'idle'}
                </Badge>
                <Button onClick={() => void checkUpdates.run()} pending={checkUpdates.pending}>Check now</Button>
                {updates.data?.version ? (
                  <Button variant="primary" onClick={() => void download.run()} pending={download.pending}>
                    Download {updates.data.version}
                  </Button>
                ) : null}
              </span>
            </Row>
          </div>
        </Panel>
        <div className="mt">
          <Notice tone="info">
            Updates are verified against a published checksum before they are staged, and installed by a
            separate process after Blossom exits. The running program is never overwritten in place, and a
            build that fails to start rolls back.
          </Notice>
        </div>
      </Section>

      <Section title="Diagnostics">
        <Panel>
          <div className="rows">
            <Row name="Log level" desc="Trace and debug are verbose. Information is the right default.">
              <Select
                ariaLabel="Log level"
                value={settings.logLevel}
                options={(['trace', 'debug', 'info', 'warn', 'error'] as LogLevel[]).map((l) => ({ value: l, label: l }))}
                onChange={(logLevel) => void patch({ logLevel })}
              />
            </Row>
            <Row
              name="Include hardware in reports"
              desc="CPU, GPU and memory details. Useful when asking for help; excluded if you would rather not share them."
            >
              <Toggle
                label="Include hardware"
                checked={settings.diagnostics.includeHardware}
                onChange={(includeHardware) => void patch({ diagnostics: { ...settings.diagnostics, includeHardware } })}
              />
            </Row>
          </div>
        </Panel>
      </Section>

      <Section title="Storage">
        <Panel>
          <div className="rows">
            <Row name="Blossom folder" desc="Settings, profiles, backups, logs and the asset cache.">
              <Button icon={<Icon.folder size={13} />} onClick={() => void call('app:open-path', { target: 'blossom' })}>Open</Button>
            </Row>
            <Row name="Logs"><Button variant="ghost" onClick={() => void call('app:open-path', { target: 'logs' })}>Open</Button></Row>
            <Row name="Backups"><Button variant="ghost" onClick={() => void call('app:open-path', { target: 'backups' })}>Open</Button></Row>
            <Row name="Profiles"><Button variant="ghost" onClick={() => void call('app:open-path', { target: 'profiles' })}>Open</Button></Row>
            <Row
              name="Prune old restore points"
              desc="Keeps the newest twenty and removes the rest."
            >
              <Button
                onClick={async () => {
                  const r = await call('backups:prune', { keep: 20 });
                  if (r.ok) toast({ kind: 'success', title: `${count(r.value.deleted)} restore points removed` });
                }}
              >
                Prune
              </Button>
            </Row>
          </div>
        </Panel>
      </Section>

      <Section title="About">
        <Panel>
          <div className="flex between">
            <div className="flex" style={{ gap: 'var(--s4)' }}>
              <span style={{ color: 'var(--accent)' }}><Icon.logo size={28} /></span>
              <div>
                <h3>Blossom Strap</h3>
                <p className="small dim">
                  Version {info.data?.version ?? '—'} · {info.data?.channel ?? 'stable'}
                  {info.data?.portable ? ' · development build' : ''}
                </p>
                <p className="micro dim mt">
                  A Roblox launcher, optimization engine and asset laboratory. Local customization only —
                  no code injection, no memory manipulation, no anti-cheat interaction.
                </p>
              </div>
            </div>
            <dl className="kv micro">
              <dt>Electron</dt><dd className="mono">{info.data?.electron ?? '—'}</dd>
              <dt>Node</dt><dd className="mono">{info.data?.node ?? '—'}</dd>
              <dt>Chromium</dt><dd className="mono">{info.data?.chrome ?? '—'}</dd>
            </dl>
          </div>
        </Panel>
      </Section>

      {confirmReset ? (
        <Confirm
          title="Reset settings"
          confirmLabel="Reset"
          danger
          pending={reset.pending}
          onConfirm={() => void reset.run()}
          onClose={() => setConfirmReset(false)}
          description="Returns every application setting to its default. Your profiles, asset rules, cache and backups are not touched."
        />
      ) : null}
    </div>
  );
}
