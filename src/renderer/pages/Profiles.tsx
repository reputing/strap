import { useState } from 'react';
import { call, useAction, useQuery } from '@renderer/lib/api';
import { count, dateTime, relative } from '@renderer/lib/format';
import { Icon } from '@renderer/components/icons';
import {
  Async, Badge, Button, Confirm, Empty, Field, Modal, Notice, Panel, Row,
  Section, Select, Toggle, useContextMenu, useToast
} from '@renderer/components/ui';
import { PageHead, presetLabel, type ShellState } from '@renderer/app/Shell';
import type { Profile, ValidationReport } from '@shared/types';

/**
 * Profiles are the unit Blossom applies. This page is the one place a profile
 * is created, forked, validated, exported and switched.
 */
export function Profiles({ shell }: { shell: ShellState }) {
  const toast = useToast();
  const profiles = useQuery('profiles:list', undefined, { on: ['profiles:changed'] });
  const menu = useContextMenu();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Profile | null>(null);
  const [importing, setImporting] = useState(false);

  const list = profiles.data ?? [];
  const selected = list.find((p) => p.id === selectedId) ?? list.find((p) => p.id === shell.profile?.id) ?? list[0] ?? null;

  const validation = useQuery('profiles:validate', selected?.id ?? '', {
    deps: [selected?.id, selected?.updatedAt],
    enabled: Boolean(selected)
  });

  const activate = useAction(async (id: string) => {
    const r = await call('profiles:activate', id);
    if (r.ok) toast({ kind: 'success', title: `Switched to “${r.value.name}”` });
    else toast({ kind: 'error', title: 'Could not switch profile', message: r.error.message });
    return r;
  });

  const remove = useAction(async (id: string) => {
    const r = await call('profiles:delete', id);
    setDeleting(null);
    if (r.ok) { toast({ kind: 'success', title: 'Profile deleted' }); setSelectedId(null); }
    else toast({ kind: 'error', title: 'Could not delete', message: r.error.message });
    return r;
  });

  const exportProfile = useAction(async (id: string) => {
    const r = await call('profiles:export', { id });
    if (r.ok) toast({ kind: 'success', title: 'Profile exported', message: r.value.path });
    else if (r.error.code !== 'cancelled') toast({ kind: 'error', title: 'Export failed', message: r.error.message });
    return r;
  });

  const duplicate = useAction(async (profile: Profile) => {
    const r = await call('profiles:duplicate', { id: profile.id, name: `${profile.name} copy` });
    if (r.ok) { setSelectedId(r.value.id); toast({ kind: 'success', title: `Created “${r.value.name}”` }); }
    return r;
  });

  return (
    <div className="page">
      <PageHead
        eyebrow="Configuration"
        title="Profiles"
        actions={
          <>
            <Button icon={<Icon.upload size={13} />} onClick={() => setImporting(true)}>Import</Button>
            <Button variant="primary" icon={<Icon.plus size={13} />} onClick={() => setCreating(true)}>New profile</Button>
          </>
        }
      >
        A profile bundles launcher settings, FastFlags, optimizer choices, asset rule sets and overlays.
        Built-in profiles cannot be changed in place — editing one creates a copy, so there is always a
        known-good starting point.
      </PageHead>

      <Async query={profiles} empty={(l) => l.length === 0 ? <Empty title="No profiles" /> : null}>
        {(all) => (
          <div className="flex" style={{ alignItems: 'flex-start', gap: 'var(--s5)' }}>
            <Panel flush>
              <div style={{ width: 260 }}>
                {all.map((profile) => {
                  const isActive = profile.id === shell.profile?.id;
                  return (
                    <button
                      key={profile.id}
                      className="rail-item"
                      aria-current={profile.id === selected?.id ? 'page' : undefined}
                      style={{ height: 'auto', padding: 'var(--s3) var(--s4)', borderRadius: 0, alignItems: 'flex-start' }}
                      onClick={() => setSelectedId(profile.id)}
                      onContextMenu={(e) => menu.open(e, [
                        { label: 'Activate', onSelect: () => void activate.run(profile.id), disabled: isActive },
                        { label: 'Duplicate', onSelect: () => void duplicate.run(profile) },
                        { label: 'Export…', onSelect: () => void exportProfile.run(profile.id) },
                        { separator: true, label: '' },
                        {
                          label: 'Delete', danger: true, disabled: profile.builtIn,
                          onSelect: () => setDeleting(profile)
                        }
                      ])}
                    >
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span className="flex" style={{ gap: 'var(--s2)' }}>
                          <span className="truncate" style={{ fontWeight: isActive ? 600 : 400 }}>{profile.name}</span>
                          {isActive ? <Badge tone="accent">active</Badge> : null}
                          {profile.builtIn ? <Badge>built in</Badge> : null}
                        </span>
                        <span className="micro dim truncate" style={{ display: 'block', marginTop: 2 }}>
                          {presetLabel(profile.optimizer.preset)} · {count(Object.keys(profile.fastFlags).length)} flags
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </Panel>

            <div style={{ flex: 1, minWidth: 0 }}>
              {selected ? (
                <ProfileDetail
                  profile={selected}
                  isActive={selected.id === shell.profile?.id}
                  validation={validation.data ?? null}
                  onActivate={() => void activate.run(selected.id)}
                  onExport={() => void exportProfile.run(selected.id)}
                  onDuplicate={() => void duplicate.run(selected)}
                  onDelete={() => setDeleting(selected)}
                  onForked={(id) => setSelectedId(id)}
                />
              ) : (
                <Empty title="Select a profile" />
              )}
            </div>
          </div>
        )}
      </Async>

      {menu.node}

      {creating ? (
        <CreateProfileModal
          profiles={list}
          onClose={() => setCreating(false)}
          onCreated={(profile) => { setSelectedId(profile.id); setCreating(false); }}
        />
      ) : null}

      {importing ? (
        <ImportProfileModal onClose={() => setImporting(false)} onImported={(id) => { setSelectedId(id); setImporting(false); }} />
      ) : null}

      {deleting ? (
        <Confirm
          title={`Delete “${deleting.name}”`}
          confirmLabel="Delete"
          danger
          pending={remove.pending}
          onConfirm={() => void remove.run(deleting.id)}
          onClose={() => setDeleting(null)}
          description="The profile file is removed from disk. Roblox itself is not changed, and any restore points stay available."
        />
      ) : null}
    </div>
  );
}

function ProfileDetail({
  profile, isActive, validation, onActivate, onExport, onDuplicate, onDelete, onForked
}: {
  profile: Profile;
  isActive: boolean;
  validation: ValidationReport | null;
  onActivate: () => void;
  onExport: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onForked: (id: string) => void;
}) {
  const toast = useToast();

  const patch = async (changes: Partial<Profile>) => {
    const r = await call('profiles:update', { id: profile.id, patch: changes });
    if (!r.ok) toast({ kind: 'error', title: 'Could not save', message: r.error.message });
    else if (r.value.id !== profile.id) {
      // Editing a built-in forks it. Follow the fork, or the next edit would
      // fork the built-in all over again and leave a pile of near-identical
      // copies behind.
      onForked(r.value.id);
      toast({ kind: 'info', title: `Copied to “${r.value.name}”`, message: 'Built-in profiles are never edited in place.' });
    }
  };

  const errors = validation?.issues.filter((i) => i.severity === 'error') ?? [];
  const warnings = validation?.issues.filter((i) => i.severity === 'warning') ?? [];

  return (
    <>
      <div className="flex between mb">
        <div>
          <h2>{profile.name}</h2>
          <p className="small dim">{profile.description || 'No description.'}</p>
        </div>
        <div className="btn-row">
          {!isActive ? <Button variant="primary" onClick={onActivate}>Activate</Button> : <Badge tone="accent">active</Badge>}
          <Button icon={<Icon.copy size={13} />} onClick={onDuplicate}>Duplicate</Button>
          <Button icon={<Icon.download size={13} />} onClick={onExport}>Export</Button>
          <Button variant="danger" icon={<Icon.trash size={13} />} onClick={onDelete} disabled={profile.builtIn}>Delete</Button>
        </div>
      </div>

      {errors.length ? (
        <div className="mb">
          <Notice tone="danger" title={`${errors.length} problem${errors.length === 1 ? '' : 's'} prevent launching`}>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {errors.slice(0, 6).map((issue) => (
                <li key={issue.path}><code className="mono micro">{issue.path}</code> — {issue.message}</li>
              ))}
            </ul>
          </Notice>
        </div>
      ) : null}

      {warnings.length ? (
        <div className="mb">
          <Notice tone="warn" title={`${warnings.length} warning${warnings.length === 1 ? '' : 's'}`}>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {warnings.slice(0, 4).map((issue) => (
                <li key={issue.path}><code className="mono micro">{issue.path}</code> — {issue.message}</li>
              ))}
            </ul>
          </Notice>
        </div>
      ) : null}

      <Section title="Identity">
        <Panel>
          <div className="rows">
            <Row name="Name">
              <input
                className="input"
                style={{ width: 220 }}
                defaultValue={profile.name}
                key={`${profile.id}-name`}
                onBlur={(e) => { if (e.target.value.trim() !== profile.name) void patch({ name: e.target.value.trim() }); }}
              />
            </Row>
            <Row name="Description" desc="Shown in the profile list and the launcher.">
              <input
                className="input"
                style={{ width: 320 }}
                defaultValue={profile.description}
                key={`${profile.id}-desc`}
                placeholder="What is this profile for?"
                onBlur={(e) => { if (e.target.value !== profile.description) void patch({ description: e.target.value }); }}
              />
            </Row>
            <Row name="Identifier" desc="Used in exports and the profile file name.">
              <code className="mono micro dim">{profile.id}</code>
            </Row>
            <Row name="Last changed"><span className="small dim" title={dateTime(profile.updatedAt)}>{relative(profile.updatedAt)}</span></Row>
          </div>
        </Panel>
      </Section>

      <Section title="What this profile contains">
        <Panel>
          <div className="rows">
            <Row name="Client" desc="Studio launches are never modified by asset features.">
              <Select
                ariaLabel="Client"
                value={profile.launcher.kind}
                options={[{ value: 'player', label: 'Roblox Player' }, { value: 'studio', label: 'Roblox Studio' }]}
                onChange={(kind) => void patch({ launcher: { ...profile.launcher, kind } })}
              />
            </Row>
            <Row name="FastFlag overrides" desc="Edit them on the FastFlags page.">
              <Badge>{count(Object.keys(profile.fastFlags).length)}</Badge>
            </Row>
            <Row name="Optimization preset">
              <Badge tone="accent">{presetLabel(profile.optimizer.preset)}</Badge>
            </Row>
            <Row name="Asset interception" desc="Replaces assets locally while this profile is running.">
              <Toggle
                label="Asset interception"
                checked={profile.assets.interception}
                onChange={(interception) => void patch({ assets: { ...profile.assets, interception } })}
              />
            </Row>
            <Row name="Record assets" desc="Index every asset the client requests while playing.">
              <Toggle
                label="Record assets"
                checked={profile.assets.capture}
                onChange={(capture) => void patch({ assets: { ...profile.assets, capture } })}
              />
            </Row>
            <Row name="Asset rule sets" desc="Selected on the Assets page.">
              <Badge>{count(profile.assets.assetProfileIds.length)}</Badge>
            </Row>
            <Row name="Crosshair overlay">
              <Toggle
                label="Crosshair"
                checked={profile.overlay.crosshair.enabled}
                onChange={(enabled) => void patch({ overlay: { ...profile.overlay, crosshair: { ...profile.overlay.crosshair, enabled } } })}
              />
            </Row>
            <Row name="Performance HUD">
              <Toggle
                label="Performance HUD"
                checked={profile.overlay.hud.enabled}
                onChange={(enabled) => void patch({ overlay: { ...profile.overlay, hud: { ...profile.overlay.hud, enabled } } })}
              />
            </Row>
          </div>
        </Panel>
      </Section>
    </>
  );
}

function CreateProfileModal({
  profiles, onClose, onCreated
}: { profiles: Profile[]; onClose: () => void; onCreated: (p: Profile) => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [from, setFrom] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = useAction(async () => {
    const r = await call('profiles:create', { name: name.trim(), from: from || undefined });
    if (r.ok) { onCreated(r.value); toast({ kind: 'success', title: `Created “${r.value.name}”` }); }
    else setError(r.error.message);
    return r;
  });

  return (
    <Modal
      title="New profile"
      description="Start blank, or copy an existing profile's configuration."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim()} pending={create.pending} onClick={() => void create.run()}>
            Create
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 'var(--s5)' }}>
        <Field label="Name" error={error}>
          {(id) => (
            <input
              id={id}
              className="input"
              autoFocus
              value={name}
              placeholder="Competitive, Recording, Testing…"
              onChange={(e) => { setName(e.target.value); setError(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) void create.run(); }}
            />
          )}
        </Field>
        <Field label="Copy from" hint="Blank starts from Blossom's defaults.">
          {(id) => (
            <select id={id} className="select" value={from} onChange={(e) => setFrom(e.target.value)}>
              <option value="">Nothing — start blank</option>
              {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
        </Field>
      </div>
    </Modal>
  );
}

function ImportProfileModal({ onClose, onImported }: { onClose: () => void; onImported: (id: string) => void }) {
  const toast = useToast();
  const [json, setJson] = useState('');

  const importFile = useAction(async () => {
    const r = await call('profiles:import', {});
    if (r.ok) { report(r.value); }
    else if (r.error.code !== 'cancelled') toast({ kind: 'error', title: 'Import failed', message: r.error.message });
    return r;
  });

  const importText = useAction(async () => {
    const r = await call('profiles:import', { json });
    if (r.ok) report(r.value);
    else toast({ kind: 'error', title: 'Import failed', message: r.error.message });
    return r;
  });

  const report = (value: { profile: Profile; report: ValidationReport }) => {
    onImported(value.profile.id);
    toast({
      kind: value.report.valid ? 'success' : 'warning',
      title: `Imported “${value.profile.name}”`,
      message: value.report.issues.length
        ? `${value.report.issues.length} issue(s) were found and are listed on the profile.`
        : undefined
    });
  };

  return (
    <Modal
      title="Import a profile"
      description="Blossom validates an imported profile and repairs what it can rather than rejecting the file."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void importFile.run()} pending={importFile.pending} icon={<Icon.folder size={13} />}>
            Choose a file…
          </Button>
          <Button variant="primary" disabled={!json.trim()} pending={importText.pending} onClick={() => void importText.run()}>
            Import pasted
          </Button>
        </>
      }
    >
      <Field label="Paste a profile" hint="Or use “Choose a file”.">
        {(id) => (
          <textarea
            id={id}
            className="input"
            rows={10}
            value={json}
            spellCheck={false}
            placeholder={'{\n  "schemaVersion": 1,\n  "name": "Competitive",\n  "fastFlags": {}\n}'}
            onChange={(e) => setJson(e.target.value)}
          />
        )}
      </Field>
    </Modal>
  );
}
