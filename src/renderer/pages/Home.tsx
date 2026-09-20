import { useState } from 'react';
import { call, useAction, useEventValue, useQuery } from '@renderer/lib/api';
import { bytes, count, duration, percent, relative } from '@renderer/lib/format';
import { Icon } from '@renderer/components/icons';
import {
  Badge, Button, Confirm, Dot, Meter, Notice, Panel, Section, useToast
} from '@renderer/components/ui';
import { LaunchConfirm } from '@renderer/components/LaunchConfirm';
import { PageHead, presetLabel, type ShellState } from '@renderer/app/Shell';
import type { LaunchProgress } from '@shared/types';

/**
 * Home answers one question: what is Blossom doing right now, and what is the
 * next thing I want to press. Everything on it is live state — there are no
 * statistics here that Blossom cannot actually measure.
 */
export function Home({ shell }: { shell: ShellState }) {
  const { roblox, profile, interception } = shell;
  const toast = useToast();
  const [confirmRepair, setConfirmRepair] = useState(false);
  const [confirmLaunch, setConfirmLaunch] = useState(false);

  const progress = useEventValue<'launch:progress'>('launch:progress', null);
  const sample = useEventValue('roblox:sample', null);
  const cache = useQuery('cache:stats', undefined, { on: ['cache:changed'] });

  const running = (roblox?.processes.length ?? 0) > 0;
  const active = roblox?.active ?? null;
  const client = roblox?.processes[0] ?? null;

  const launch = useAction(async () => {
    setConfirmLaunch(false);
    const result = await call('launch:start', {});
    if (result.ok) toast({ kind: 'success', title: 'Roblox is starting' });
    else toast({ kind: 'error', title: 'Could not launch Roblox', message: result.error.message });
    return result;
  });

  // "Confirm before launching" shows what is about to be applied rather than
  // asking a bare yes/no question.
  const startLaunch = () => {
    if (shell.settings?.confirmBeforeLaunch) setConfirmLaunch(true);
    else void launch.run();
  };

  const rescan = useAction(async () => {
    const r = await call('roblox:rescan', undefined);
    if (r.ok) {
      toast({
        kind: r.value.active ? 'success' : 'warning',
        title: r.value.active ? 'Roblox found' : 'Roblox was not found',
        message: r.value.active
          ? `${r.value.active.clientVersion ?? r.value.active.versionGuid}`
          : 'Install or run Roblox once, then rescan.'
      });
    }
    return r;
  });

  const clearCache = useAction(async () => {
    const r = await call('roblox:clear-temp-cache', undefined);
    if (r.ok) {
      toast({
        kind: 'success',
        title: 'Roblox temporary cache cleared',
        message: `${count(r.value.filesRemoved)} entries, ${bytes(r.value.bytesFreed)} freed.`
      });
    } else {
      toast({ kind: 'warning', title: 'Cache not cleared', message: r.error.message });
    }
    return r;
  });

  const repair = useAction(async () => {
    const r = await call('roblox:repair', undefined);
    setConfirmRepair(false);
    if (r.ok) {
      toast({
        kind: 'success',
        title: 'Roblox repaired',
        message: `Removed ${count(r.value.removed.length)} Blossom-written file(s). Roblox's own files were not touched.`
      });
    }
    return r;
  });

  return (
    <div className="page">
      <PageHead eyebrow="Roblox" title={statusHeadline(active, running)}>
        {active
          ? 'Blossom is watching your installation and will re-apply your profile the next time you launch.'
          : 'Blossom could not find Roblox on this machine. Install it, or run it once so it finishes unpacking.'}
      </PageHead>

      {roblox?.updateAvailable ? (
        <div className="mb">
          <Notice tone="info" title="Roblox has published a newer client">
            You are on {active?.clientVersion ?? 'an older build'}; {roblox.latest?.clientVersion} is current.
            Roblox updates itself the next time it starts. Your profiles are unaffected.
          </Notice>
        </div>
      ) : null}

      <Section title="Ready to play">
        <div className="flex" style={{ gap: 'var(--s5)', alignItems: 'stretch' }}>
          <Panel>
            <div className="col" style={{ gap: 'var(--s5)', minWidth: 300 }}>
              <dl className="kv">
                <dt>Client version</dt>
                <dd className="mono">{active?.clientVersion ?? active?.versionGuid ?? 'not detected'}</dd>
                <dt>Active profile</dt>
                <dd>{profile?.name ?? '—'}</dd>
                <dt>Optimization</dt>
                <dd>{profile ? presetLabel(profile.optimizer.preset) : '—'}</dd>
                <dt>FastFlags</dt>
                <dd className="num">{profile ? count(Object.keys(profile.fastFlags).length) : '—'}</dd>
                <dt>Interception</dt>
                <dd className="flex" style={{ gap: 'var(--s2)' }}>
                  <Dot tone={interception?.status === 'running' ? 'ok' : interception?.status === 'degraded' ? 'warn' : 'idle'} />
                  {interception?.status ?? 'stopped'}
                </dd>
                <dt>Cache</dt>
                <dd className="num">
                  {cache.data ? `${count(cache.data.assetCount)} assets · ${bytes(cache.data.totalBytes)}` : '—'}
                </dd>
              </dl>

              <div className="btn-row">
                <Button
                  variant="primary"
                  size="lg"
                  onClick={startLaunch}
                  pending={launch.pending || isLaunching(progress)}
                  disabled={!active || (running && !profile?.launcher.multiInstance)}
                  icon={<Icon.play size={14} />}
                >
                  {running ? 'Roblox is running' : 'Launch Roblox'}
                </Button>
                {running ? (
                  <Button
                    variant="danger"
                    onClick={() => void call('launch:close-roblox', {})}
                    icon={<Icon.power size={13} />}
                  >
                    Close
                  </Button>
                ) : null}
              </div>

              {progress && isLaunching(progress) ? (
                <div className="col" style={{ gap: 'var(--s2)' }}>
                  <div className="flex between micro dim">
                    <span>{progress.message}</span>
                    <span className="num">{progress.fraction !== null ? percent(progress.fraction * 100) : ''}</span>
                  </div>
                  <Meter value={progress.fraction ?? 0} />
                </div>
              ) : null}
            </div>
          </Panel>

          <div style={{ flex: 1, minWidth: 0 }}>
            {running && client ? (
              <Panel head={<><Icon.activity size={14} /><h3>Live</h3><Badge tone="accent">pid {client.pid}</Badge></>}>
                <dl className="kv">
                  <dt>CPU</dt>
                  <dd className="num">{sample?.cpuPercent !== null && sample?.cpuPercent !== undefined ? percent(sample.cpuPercent, 1) : 'measuring…'}</dd>
                  <dt>Memory</dt>
                  <dd className="num">{bytes(sample?.memoryBytes ?? null)}</dd>
                  <dt>Uptime</dt>
                  <dd className="num">{duration(sample?.uptimeMs ?? Date.now() - client.startedAt)}</dd>
                  <dt>Started by</dt>
                  <dd>{client.ownedByBlossom ? 'Blossom Strap' : 'something else'}</dd>
                  <dt>Client</dt>
                  <dd>{client.kind === 'studio' ? 'Roblox Studio' : 'Roblox Player'}</dd>
                </dl>
                <div className="notice mt micro" style={{ padding: 'var(--s3)' }}>
                  <span className="glyph"><Icon.info size={13} /></span>
                  <span>
                    Frame rate is not shown because reading it would mean reaching inside the Roblox
                    process, which Blossom does not do. CPU, memory and uptime are measured from outside.
                  </span>
                </div>
              </Panel>
            ) : (
              <Panel head={<><Icon.clock size={14} /><h3>Installation</h3></>}>
                {active ? (
                  <dl className="kv">
                    <dt>Folder</dt>
                    <dd className="mono micro truncate" title={active.directory}>{active.versionGuid}</dd>
                    <dt>Installed</dt>
                    <dd>{relative(active.installedAt)}</dd>
                    <dt>Installs found</dt>
                    <dd className="num">{count(roblox?.installations.length ?? 0)}</dd>
                    <dt>Last scan</dt>
                    <dd>{relative(roblox?.scannedAt)}</dd>
                  </dl>
                ) : (
                  <p className="small dim">Nothing to show until Roblox is installed.</p>
                )}
              </Panel>
            )}
          </div>
        </div>
      </Section>

      <Section title="Quick actions" hint="Everything here also lives in the command palette">
        <div className="grid-3">
          <QuickAction
            icon={<Icon.refresh size={15} />}
            title="Rescan for Roblox"
            desc="Re-read the installation folder now."
            onClick={() => void rescan.run()}
            pending={rescan.pending}
          />
          <QuickAction
            icon={<Icon.folder size={15} />}
            title="Open the Roblox folder"
            desc="Jump to the version directory in Explorer."
            onClick={() => void call('app:open-path', { target: 'roblox' })}
            disabled={!active}
          />
          <QuickAction
            icon={<Icon.trash size={15} />}
            title="Clear temporary cache"
            desc="Empty Roblox's own temp cache. Close Roblox first."
            onClick={() => void clearCache.run()}
            pending={clearCache.pending}
            disabled={running}
          />
          <QuickAction
            icon={<Icon.shield size={15} />}
            title="Repair Roblox"
            desc="Remove everything Blossom wrote into the client."
            onClick={() => setConfirmRepair(true)}
            disabled={!active}
          />
          <QuickAction
            icon={<Icon.stethoscope size={15} />}
            title="Diagnostics"
            desc="Build a report you can paste when asking for help."
            onClick={() => void call('commands:run', { id: 'diagnostics.report' })}
          />
          <QuickAction
            icon={<Icon.gauge size={15} />}
            title="Apply the recommended preset"
            desc="Let Blossom pick based on this machine."
            onClick={() => void call('commands:run', { id: 'optimizer.apply-recommended' })}
          />
        </div>
      </Section>

      {confirmLaunch ? (
        <LaunchConfirm
          request={{}}
          pending={launch.pending}
          onConfirm={() => void launch.run()}
          onClose={() => setConfirmLaunch(false)}
        />
      ) : null}

      {confirmRepair ? (
        <Confirm
          title="Repair Roblox"
          confirmLabel="Repair"
          pending={repair.pending}
          onConfirm={() => void repair.run()}
          onClose={() => setConfirmRepair(false)}
          description={
            <>
              This deletes the FastFlag override file Blossom wrote into every installed Roblox
              version, returning the client to Roblox's own defaults. Roblox's own files are not
              touched, and your profiles are not changed.
            </>
          }
        />
      ) : null}
    </div>
  );
}

function QuickAction({
  icon, title, desc, onClick, disabled, pending
}: {
  icon: React.ReactNode; title: string; desc: string;
  onClick: () => void; disabled?: boolean; pending?: boolean;
}) {
  return (
    <button
      className="panel"
      onClick={onClick}
      disabled={disabled || pending}
      style={{
        textAlign: 'left', cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1, padding: 'var(--s4)', display: 'flex',
        gap: 'var(--s3)', alignItems: 'flex-start', border: '1px solid var(--line)'
      }}
    >
      <span style={{ color: 'var(--accent)', marginTop: 1 }}>{pending ? <span className="spinner" /> : icon}</span>
      <span>
        <span style={{ display: 'block', fontWeight: 500 }}>{title}</span>
        <span className="micro dim" style={{ display: 'block', marginTop: 2 }}>{desc}</span>
      </span>
    </button>
  );
}

function statusHeadline(active: { clientVersion: string | null } | null, running: boolean): string {
  if (!active) return 'Roblox not detected';
  return running ? 'Roblox is running' : 'Ready to play';
}

function isLaunching(progress: LaunchProgress | null): boolean {
  if (!progress) return false;
  return progress.stage !== 'idle' && progress.stage !== 'running'
    && progress.stage !== 'exited' && progress.stage !== 'failed';
}
