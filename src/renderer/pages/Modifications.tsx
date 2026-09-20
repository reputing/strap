import { call, useAction, useQuery } from '@renderer/lib/api';
import { bytes, count, relative } from '@renderer/lib/format';
import { Icon } from '@renderer/components/icons';
import {
  Async, Badge, Button, Dot, Empty, Notice, Panel, Section, useToast
} from '@renderer/components/ui';
import { PageHead, presetLabel, type ShellState } from '@renderer/app/Shell';

/**
 * The Modification Center: one page that answers "what is Blossom changing".
 *
 * It reads live state from every subsystem rather than from a stored summary,
 * so it cannot drift out of date with what is actually applied.
 */
export function Modifications({
  shell, navigate
}: { shell: ShellState; navigate: (route: string) => void }) {
  const toast = useToast();
  const profile = shell.profile;

  const mods = useQuery('mods:list', undefined);
  const sets = useQuery('assets:sets', undefined);
  const optimizer = useQuery('optimizer:state', undefined, { on: ['optimizer:changed'] });
  const backups = useQuery('backups:list', undefined);
  const diff = useQuery('flags:diff', {}, { on: ['profiles:changed'] });

  const applyMods = useAction(async () => {
    const r = await call('mods:apply', undefined);
    if (r.ok) toast({ kind: 'success', title: `${count(r.value.applied)} mod files applied` });
    else toast({ kind: 'error', title: 'Could not apply mods', message: r.error.message });
    return r;
  });

  const restoreMods = useAction(async () => {
    const r = await call('mods:restore', undefined);
    if (r.ok) toast({ kind: 'success', title: `${count(r.value.restored)} files restored` });
    else toast({ kind: 'warning', title: 'Nothing to restore', message: r.error.message });
    return r;
  });

  const activeSets = (sets.data ?? []).filter((s) => profile?.assets.assetProfileIds.includes(s.id));
  const ruleCount = activeSets.reduce((n, s) => n + s.ruleCount, 0);
  const flagCount = Object.keys(profile?.fastFlags ?? {}).length;
  const overlayOn = Boolean(profile?.overlay.crosshair.enabled || profile?.overlay.hud.enabled);

  return (
    <div className="page">
      <PageHead eyebrow="Overview" title="Modifications">
        Everything Blossom changes, in one place. Nothing here is hidden behind a toggle somewhere else,
        and every change is backed up before it is written.
      </PageHead>

      <Section title="Summary" hint={profile ? `Profile: ${profile.name}` : undefined}>
        <div className="grid-3">
          <Summary
            title="FastFlags"
            value={count(flagCount)}
            detail={flagCount ? 'Written into Roblox at launch' : 'Nothing overridden'}
            active={flagCount > 0}
            onOpen={() => navigate('/fastflags')}
          />
          <Summary
            title="Optimizer"
            value={presetLabel(profile?.optimizer.preset ?? 'balanced')}
            detail={optimizer.data?.appliedAt ? `Applied ${relative(optimizer.data.appliedAt)}` : 'Not applied yet'}
            active={Boolean(optimizer.data?.appliedActionIds.length)}
            onOpen={() => navigate('/optimizer')}
          />
          <Summary
            title="Asset rules"
            value={count(ruleCount)}
            detail={profile?.assets.interception ? `${activeSets.length} rule set(s) active` : 'Interception is off'}
            active={Boolean(profile?.assets.interception && ruleCount)}
            onOpen={() => navigate('/assets')}
          />
          <Summary
            title="Client mods"
            value={count(mods.data?.length ?? 0)}
            detail={mods.data?.length ? 'Files overlaid onto the client' : 'No mod files'}
            active={Boolean(mods.data?.length)}
            onOpen={() => void call('mods:open-folder', undefined)}
          />
          <Summary
            title="Overlays"
            value={overlayOn ? 'On' : 'Off'}
            detail={[
              profile?.overlay.crosshair.enabled ? 'crosshair' : null,
              profile?.overlay.hud.enabled ? 'HUD' : null
            ].filter(Boolean).join(' · ') || 'Nothing drawn over the client'}
            active={overlayOn}
            onOpen={() => navigate('/appearance')}
          />
          <Summary
            title="Interception"
            value={shell.interception?.status ?? 'stopped'}
            detail={shell.interception?.certificateInstalled ? 'Certificate installed in Roblox' : 'Certificate not installed'}
            active={shell.interception?.status === 'running'}
            onOpen={() => navigate('/assets')}
          />
        </div>
      </Section>

      <Section
        title="Configuration diff"
        hint="What Roblox would do, and what it will do"
        actions={<Button variant="ghost" onClick={() => navigate('/fastflags')}>Open the editor</Button>}
      >
        <Async query={diff} empty={(rows) => rows.length === 0
          ? <Empty icon={<Icon.check size={22} />} title="Blossom is not changing any engine flags">
            The client will run exactly as Roblox ships it.
          </Empty>
          : null}>
          {(rows) => (
            <Panel flush>
              <div className="diff">
                <div className="diff-row" style={{ color: 'var(--text-3)', fontFamily: 'var(--font)' }}>
                  <span className="name">ROBLOX DEFAULT</span>
                  <span />
                  <span>BLOSSOM</span>
                </div>
                {rows.map((row) => (
                  <div className={`diff-row ${row.kind}`} key={row.name}>
                    <span className="name">{row.name}</span>
                    <span className="from">{row.robloxDefault ?? 'not published'}</span>
                    <span className="to">{row.blossomValue ?? 'removed'}</span>
                  </div>
                ))}
              </div>
            </Panel>
          )}
        </Async>
      </Section>

      <Section
        title="Client mods"
        hint="Files overlaid onto the Roblox content folders"
        actions={
          <>
            <Button icon={<Icon.folder size={13} />} onClick={() => void call('mods:open-folder', undefined)}>Open folder</Button>
            <Button onClick={() => void restoreMods.run()} pending={restoreMods.pending}>Restore</Button>
            <Button variant="primary" onClick={() => void applyMods.run()} pending={applyMods.pending} disabled={!mods.data?.length}>
              Apply now
            </Button>
          </>
        }
      >
        <Async query={mods} empty={(list) => list.length === 0
          ? <Empty icon={<Icon.folder size={22} />} title="No mod files">
            Put files under <code className="mono">mods\content</code> mirroring the layout inside a Roblox
            version folder. Only the content folders are accepted, and every file Blossom replaces is
            backed up first.
          </Empty>
          : null}>
          {(list) => (
            <Panel flush>
              <table className="table">
                <thead><tr><th>File</th><th className="num">Size</th><th>State</th></tr></thead>
                <tbody>
                  {list.map((file) => (
                    <tr key={file.relativePath}>
                      <td className="mono micro">{file.relativePath}</td>
                      <td className="num">{bytes(file.sizeBytes)}</td>
                      <td>{file.applied ? <Badge tone="ok">applied</Badge> : <Badge>pending</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          )}
        </Async>
      </Section>

      <Section title="Restore points" hint="Taken before anything is written">
        <Async query={backups} empty={(list) => list.length === 0
          ? <Empty title="No restore points yet">One is taken every time Blossom changes a Roblox file.</Empty>
          : null}>
          {(list) => (
            <Panel flush>
              <table className="table">
                <thead><tr><th>Reason</th><th>Files</th><th>Taken</th><th /></tr></thead>
                <tbody>
                  {list.slice(0, 12).map((point) => (
                    <tr key={point.id}>
                      <td>{point.reason}</td>
                      <td className="num">{count(point.entries.length)}</td>
                      <td className="dim">{relative(point.createdAt)}</td>
                      <td style={{ textAlign: 'right' }}>
                        <span className="flex" style={{ justifyContent: 'flex-end', gap: 'var(--s2)' }}>
                          {point.restored ? <Badge>restored</Badge> : null}
                          <Button
                            variant="ghost"
                            onClick={async () => {
                              const r = await call('backups:restore', point.id);
                              toast(r.ok
                                ? { kind: 'success', title: `${count(r.value.restored)} files restored` }
                                : { kind: 'error', title: 'Restore failed', message: r.error.message });
                              backups.refetch();
                            }}
                          >
                            Restore
                          </Button>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          )}
        </Async>
      </Section>

      {!shell.roblox?.active ? (
        <Notice tone="warn" title="Roblox is not installed">
          Modifications are stored in your profile and will be applied when a client is available.
        </Notice>
      ) : null}
    </div>
  );
}

function Summary({
  title, value, detail, active, onOpen
}: { title: string; value: string; detail: string; active: boolean; onOpen: () => void }) {
  return (
    <button
      className="panel"
      onClick={onOpen}
      style={{ textAlign: 'left', padding: 'var(--s4) var(--s5)', cursor: 'pointer' }}
    >
      <span className="flex between">
        <span className="micro dim" style={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}>{title}</span>
        <Dot tone={active ? 'ok' : 'idle'} />
      </span>
      <span style={{ display: 'block', fontSize: 'var(--t-display)', fontWeight: 600, marginTop: 6, letterSpacing: '-0.015em' }}>
        {value}
      </span>
      <span className="micro dim" style={{ display: 'block', marginTop: 2 }}>{detail}</span>
    </button>
  );
}
