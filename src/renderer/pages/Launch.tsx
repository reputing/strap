import { useState } from 'react';
import { call, useAction, useEventValue, useQuery } from '@renderer/lib/api';
import { count, relative } from '@renderer/lib/format';
import { Icon } from '@renderer/components/icons';
import {
  Async, Badge, Button, Meter, Notice, Panel, Row, Section, Select, Toggle, useToast
} from '@renderer/components/ui';
import { LaunchConfirm } from '@renderer/components/LaunchConfirm';
import { PageHead, type ShellState } from '@renderer/app/Shell';
import type { LaunchProgress, Profile } from '@shared/types';

const STAGE_ORDER: LaunchProgress['stage'][] = [
  'resolving-profile', 'locating-roblox', 'validating', 'creating-restore-point',
  'applying-fastflags', 'applying-mods', 'starting-interception', 'spawning',
  'waiting-for-process', 'starting-overlays', 'running'
];

const STAGE_LABEL: Record<string, string> = {
  'resolving-profile': 'Resolve profile',
  'locating-roblox': 'Locate Roblox',
  'validating': 'Pre-flight checks',
  'creating-restore-point': 'Back up what changes',
  'applying-fastflags': 'Apply FastFlags',
  'applying-mods': 'Apply client mods',
  'starting-interception': 'Start the asset engine',
  'spawning': 'Start the client',
  'waiting-for-process': 'Wait for the client',
  'starting-overlays': 'Start overlays',
  'running': 'Running'
};

/**
 * The launcher page makes the launch sequence visible. Every step here is a
 * real step in LauncherService, shown in the order it runs, so a failure
 * points at exactly where it happened.
 */
export function Launch({ shell }: { shell: ShellState }) {
  const toast = useToast();
  const profiles = useQuery('profiles:list', undefined, { on: ['profiles:changed'] });
  const progress = useEventValue<'launch:progress'>('launch:progress', null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const active = shell.profile;
  const chosenId = selectedId ?? active?.id ?? null;
  const chosen = profiles.data?.find((p) => p.id === chosenId) ?? active ?? null;
  const running = (shell.roblox?.processes.length ?? 0) > 0;
  const installed = shell.roblox?.active ?? null;

  const validation = useQuery(
    'profiles:validate',
    chosenId ?? '',
    { deps: [chosenId], enabled: Boolean(chosenId) }
  );

  const launch = useAction(async (profileId: string) => {
    setConfirming(false);
    const result = await call('launch:start', { profileId });
    if (result.ok) {
      toast({
        kind: 'success',
        title: 'Roblox is starting',
        message: result.value.interception === 'active'
          ? 'Asset interception is active for this session.'
          : undefined
      });
    } else {
      toast({ kind: 'error', title: 'Could not launch Roblox', message: result.error.message });
    }
    return result;
  });

  const currentStage = progress?.stage ?? 'idle';
  const stageIndex = STAGE_ORDER.indexOf(currentStage);
  const busy = stageIndex >= 0 && currentStage !== 'running';

  return (
    <div className="page">
      <PageHead eyebrow="Launcher" title="Launch">
        Blossom owns the whole launch: it validates the profile, backs up every file it is about to
        touch, applies your configuration, starts the client and tracks it until it exits.
      </PageHead>

      {!installed ? (
        <div className="mb">
          <Notice tone="warn" title="Roblox is not installed">
            Install Roblox, or run it once so it finishes unpacking, then rescan from Home.
          </Notice>
        </div>
      ) : null}

      <Section title="Profile">
        <Async query={profiles}>
          {(list) => (
            <Panel flush>
              <div style={{ padding: 'var(--s5)' }}>
                <div className="rows">
                  <Row name="Launch with" desc="The profile applied to this launch.">
                    <Select
                      ariaLabel="Profile"
                      value={chosenId ?? ''}
                      options={list.map((p) => ({ value: p.id, label: p.builtIn ? `${p.name} · built in` : p.name }))}
                      onChange={setSelectedId}
                    />
                  </Row>
                  {chosen ? <ProfileSummary profile={chosen} /> : null}
                </div>
              </div>
            </Panel>
          )}
        </Async>

        {validation.data && !validation.data.valid ? (
          <div className="mt">
            <Notice tone="danger" title="This profile cannot be launched with">
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {validation.data.issues.filter((i) => i.severity === 'error').slice(0, 5).map((issue) => (
                  <li key={issue.path}><code className="mono micro">{issue.path}</code> — {issue.message}</li>
                ))}
              </ul>
            </Notice>
          </div>
        ) : null}

        {validation.data?.valid && validation.data.issues.length ? (
          <div className="mt">
            <Notice tone="warn" title={`${validation.data.issues.length} warning${validation.data.issues.length === 1 ? '' : 's'}`}>
              The profile will launch. {validation.data.issues[0]?.message}
            </Notice>
          </div>
        ) : null}
      </Section>

      <Section title="Sequence" hint="Each step registers how to undo itself; a failure rolls back in reverse">
        <Panel flush>
          <div className="rows" style={{ padding: '0 var(--s5)' }}>
            {STAGE_ORDER.map((stage, index) => {
              const state = !busy && currentStage !== 'running'
                ? 'idle'
                : index < stageIndex ? 'done' : index === stageIndex ? 'active' : 'pending';
              return (
                <div className="row" key={stage} style={{ padding: 'var(--s3) 0' }}>
                  <div className="label">
                    <div className="name" style={{ color: state === 'pending' || state === 'idle' ? 'var(--text-3)' : 'var(--text)' }}>
                      <StageGlyph state={state} />
                      {STAGE_LABEL[stage]}
                    </div>
                  </div>
                  <div className="control">
                    {state === 'active' ? <span className="micro dim">{progress?.message}</span> : null}
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>

        {progress && progress.fraction !== null ? (
          <div className="mt"><Meter value={progress.fraction} /></div>
        ) : null}

        <div className="btn-row mt">
          <Button
            variant="primary"
            size="lg"
            icon={<Icon.play size={14} />}
            pending={launch.pending || busy}
            disabled={!installed || !chosenId || (running && !chosen?.launcher.multiInstance) || validation.data?.valid === false}
            onClick={() => {
              if (!chosenId) return;
              if (shell.settings?.confirmBeforeLaunch) setConfirming(true);
              else void launch.run(chosenId);
            }}
          >
            Launch Roblox
          </Button>
          {busy ? <Button variant="ghost" onClick={() => void call('launch:cancel', undefined)}>Cancel</Button> : null}
          {running ? (
            <Button variant="danger" icon={<Icon.power size={13} />} onClick={() => void call('launch:close-roblox', {})}>
              Close Roblox
            </Button>
          ) : null}
        </div>
      </Section>

      {confirming && chosenId ? (
        <LaunchConfirm
          request={{ profileId: chosenId }}
          pending={launch.pending}
          onConfirm={() => void launch.run(chosenId)}
          onClose={() => setConfirming(false)}
        />
      ) : null}

      {chosen ? <LauncherOptions profile={chosen} /> : null}

      <Section title="Installed versions" hint="Blossom acts on the one marked active">
        {!shell.roblox || shell.roblox.installations.length === 0 ? (
          <p className="small dim">No installations found.</p>
        ) : (
          <Panel flush>
            <table className="table">
              <thead>
                <tr>
                  <th>Client</th><th>Version</th><th>Folder</th><th>Installed</th><th />
                </tr>
              </thead>
              <tbody>
                {shell.roblox.installations.map((install) => (
                  <tr key={`${install.kind}-${install.versionGuid}`}>
                    <td>{install.kind === 'studio' ? 'Studio' : 'Player'}</td>
                    <td className="mono">{install.clientVersion ?? '—'}</td>
                    <td className="mono micro dim truncate" title={install.directory}>{install.versionGuid}</td>
                    <td className="dim">{relative(install.installedAt)}</td>
                    <td style={{ textAlign: 'right' }}>
                      {shell.roblox?.active?.versionGuid === install.versionGuid && shell.roblox.active.kind === install.kind
                        ? <Badge tone="accent">active</Badge>
                        : (
                          <Button variant="ghost" onClick={() => void call('roblox:set-active', install.versionGuid)}>
                            Use this
                          </Button>
                        )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}
      </Section>
    </div>
  );
}

function ProfileSummary({ profile }: { profile: Profile }) {
  return (
    <>
      <Row name="Client" desc="Studio is never modified unless a feature explicitly supports it.">
        <Badge>{profile.launcher.kind === 'studio' ? 'Roblox Studio' : 'Roblox Player'}</Badge>
      </Row>
      <Row name="Contains">
        <div className="flex" style={{ gap: 'var(--s2)' }}>
          <Badge>{count(Object.keys(profile.fastFlags).length)} flags</Badge>
          <Badge>{profile.optimizer.preset}</Badge>
          {profile.assets.interception ? <Badge tone="accent">interception</Badge> : null}
          {profile.overlay.crosshair.enabled ? <Badge tone="accent">crosshair</Badge> : null}
          {profile.overlay.hud.enabled ? <Badge tone="accent">HUD</Badge> : null}
        </div>
      </Row>
    </>
  );
}

function LauncherOptions({ profile }: { profile: Profile }) {
  const toast = useToast();

  const update = async (patch: Partial<Profile['launcher']>) => {
    const result = await call('profiles:update', {
      id: profile.id,
      patch: { launcher: { ...profile.launcher, ...patch } }
    });
    if (!result.ok) toast({ kind: 'error', title: 'Could not save', message: result.error.message });
    else if (result.value.id !== profile.id) {
      toast({
        kind: 'info',
        title: `Copied to “${result.value.name}”`,
        message: 'Built-in profiles are not edited in place, so your change created a copy.'
      });
    }
  };

  return (
    <Section title="Launcher options" hint={profile.builtIn ? 'Editing a built-in profile creates a copy' : undefined}>
      <Panel>
        <div className="rows">
          <Row
            name="Allow multiple instances"
            desc="Lets more than one client run at a time. Some experiences and anti-cheat systems dislike this."
          >
            <Toggle
              label="Allow multiple instances"
              checked={profile.launcher.multiInstance}
              onChange={(v) => void update({ multiInstance: v })}
            />
          </Row>

          <Row
            name="Process priority"
            desc="Applied after the client starts. High priority can make the rest of Windows feel sluggish."
          >
            <Select
              ariaLabel="Process priority"
              value={profile.launcher.priority}
              options={[
                { value: 'normal', label: 'Normal' },
                { value: 'above-normal', label: 'Above normal' },
                { value: 'high', label: 'High' }
              ]}
              onChange={(v) => void update({ priority: v })}
            />
          </Row>

          <Row
            name="Hide Blossom when Roblox starts"
            desc="The window closes to the tray; Blossom keeps running and keeps tracking the client."
          >
            <Toggle
              label="Hide on launch"
              checked={profile.launcher.hideOnLaunch}
              onChange={(v) => void update({ hideOnLaunch: v })}
            />
          </Row>

          <Row
            name="When Roblox exits"
            desc="Restore puts every file Blossom changed back the way it was."
          >
            <Select
              ariaLabel="On exit"
              value={profile.launcher.onExit}
              options={[
                { value: 'restore', label: 'Restore the client' },
                { value: 'keep', label: 'Leave changes applied' },
                { value: 'quit-blossom', label: 'Quit Blossom' }
              ]}
              onChange={(v) => void update({ onExit: v })}
            />
          </Row>
        </div>
      </Panel>
    </Section>
  );
}

function StageGlyph({ state }: { state: 'idle' | 'pending' | 'active' | 'done' }) {
  if (state === 'done') return <span style={{ color: 'var(--ok)' }}><Icon.check size={13} /></span>;
  if (state === 'active') return <span className="spinner" />;
  return <span style={{ color: 'var(--text-3)', opacity: 0.6 }}><Icon.minus size={13} /></span>;
}
