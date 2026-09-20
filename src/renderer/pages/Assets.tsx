import { useEffect, useMemo, useState } from 'react';
import { call, on, useAction, useQuery } from '@renderer/lib/api';
import { bytes, count, milliseconds, ratio, time } from '@renderer/lib/format';
import { Icon } from '@renderer/components/icons';
import {
  Async, Badge, Button, Confirm, Dot, Empty, Field, Modal, Notice, Panel,
  Row, Section, Segmented, Select, Toggle, useContextMenu, useToast
} from '@renderer/components/ui';
import { PageHead, type ShellState } from '@renderer/app/Shell';
import type { AssetRule, AssetRuleSet, AssetType, CaptureEvent, RuleAction } from '@shared/types';

const ACTION_LABEL: Record<RuleAction, string> = {
  'replace-asset': 'Replace with another asset',
  'replace-file': 'Replace with a local file',
  'replace-url': 'Replace from a URL',
  'remove': 'Remove entirely',
  'passthrough': 'Always use the original'
};

const ASSET_TYPES: AssetType[] = [
  'unknown', 'image', 'texture', 'mesh', 'audio', 'animation', 'model', 'font', 'video', 'json', 'text'
];

/**
 * The Assets page: rule sets, rules, the interception engine and live capture.
 *
 * Interception is presented the way it actually works — opt-in, scoped, and
 * explained in full before anything is installed.
 */
export function Assets({ shell }: { shell: ShellState }) {
  const [tab, setTab] = useState<'rules' | 'interception' | 'capture'>('rules');

  return (
    <div className="page">
      <PageHead eyebrow="Assets" title="Assets">
        Replace textures, sounds and meshes locally. Rules live in sets you can enable per profile, and
        any rule that cannot be served falls back to the original asset rather than breaking the client.
      </PageHead>

      <div className="mb">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'rules', label: 'Rule sets' },
            { value: 'interception', label: 'Interception' },
            { value: 'capture', label: 'Live capture' }
          ]}
        />
      </div>

      {tab === 'rules' ? <RuleSets shell={shell} /> : null}
      {tab === 'interception' ? <Interception shell={shell} /> : null}
      {tab === 'capture' ? <Capture /> : null}
    </div>
  );
}

function RuleSets({ shell }: { shell: ShellState }) {
  const toast = useToast();
  const menu = useContextMenu();
  const sets = useQuery('assets:sets', undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<AssetRuleSet | null>(null);

  const list = sets.data ?? [];
  const selected = list.find((s) => s.id === selectedId) ?? list[0] ?? null;
  const rules = useQuery('assets:rules', { setId: selected?.id ?? '' }, {
    deps: [selected?.id, selected?.ruleCount],
    enabled: Boolean(selected)
  });

  const [editing, setEditing] = useState<Partial<AssetRule> | null>(null);
  const enabledForProfile = shell.profile?.assets.assetProfileIds ?? [];

  const toggleForProfile = async (setId: string, on: boolean) => {
    if (!shell.profile) return;
    const next = on
      ? [...new Set([...enabledForProfile, setId])]
      : enabledForProfile.filter((id) => id !== setId);
    const r = await call('profiles:update', {
      id: shell.profile.id,
      patch: { assets: { ...shell.profile.assets, assetProfileIds: next } }
    });
    if (!r.ok) toast({ kind: 'error', title: 'Could not update the profile', message: r.error.message });
  };

  const remove = useAction(async (id: string) => {
    const r = await call('assets:set:delete', id);
    setDeleting(null);
    if (r.ok) { sets.refetch(); setSelectedId(null); toast({ kind: 'success', title: 'Rule set deleted' }); }
    return r;
  });

  const importSet = useAction(async () => {
    const r = await call('assets:set:import', {});
    if (r.ok) { sets.refetch(); setSelectedId(r.value.id); toast({ kind: 'success', title: `Imported “${r.value.name}”` }); }
    else if (r.error.code !== 'cancelled') toast({ kind: 'error', title: 'Import failed', message: r.error.message });
    return r;
  });

  if (!sets.data && sets.error) {
    return (
      <Notice tone="danger" title="The asset index is unavailable">
        {sets.error.message} Rule sets are stored in it, so they cannot be edited right now. Everything
        else in Blossom keeps working.
      </Notice>
    );
  }

  return (
    <>
      <Section
        title="Rule sets"
        hint="Enabled sets apply to the active profile, in order"
        actions={
          <>
            <Button icon={<Icon.upload size={13} />} onClick={() => void importSet.run()}>Import</Button>
            <Button variant="primary" icon={<Icon.plus size={13} />} onClick={() => setCreating(true)}>New set</Button>
          </>
        }
      >
        <Async query={sets} empty={(l) => l.length === 0
          ? <Empty icon={<Icon.image size={22} />} title="No rule sets yet"
            action={<Button variant="primary" onClick={() => setCreating(true)}>Create one</Button>}>
            A rule set is a named group of replacements — “Low Texture”, “Custom Sounds”, anything you like.
          </Empty>
          : null}>
          {(all) => (
            <Panel flush>
              <table className="table">
                <thead><tr><th style={{ width: 40 }}>On</th><th>Name</th><th className="num">Rules</th><th>Description</th><th /></tr></thead>
                <tbody>
                  {all.map((set) => (
                    <tr
                      key={set.id}
                      aria-selected={set.id === selected?.id}
                      onClick={() => setSelectedId(set.id)}
                      style={{ cursor: 'pointer' }}
                      onContextMenu={(e) => menu.open(e, [
                        {
                          label: 'Duplicate',
                          onSelect: async () => {
                            const r = await call('assets:set:duplicate', { id: set.id, name: `${set.name} copy` });
                            if (r.ok) sets.refetch();
                          }
                        },
                        {
                          label: 'Export…',
                          onSelect: async () => {
                            const r = await call('assets:set:export', { id: set.id });
                            if (r.ok) toast({ kind: 'success', title: 'Exported', message: r.value.path });
                          }
                        },
                        { separator: true, label: '' },
                        { label: 'Delete', danger: true, onSelect: () => setDeleting(set) }
                      ])}
                    >
                      <td onClick={(e) => e.stopPropagation()}>
                        <Toggle
                          label={`Enable ${set.name}`}
                          checked={enabledForProfile.includes(set.id)}
                          onChange={(v) => void toggleForProfile(set.id, v)}
                        />
                      </td>
                      <td>{set.name}</td>
                      <td className="num">{count(set.ruleCount)}</td>
                      <td className="dim truncate">{set.description || '—'}</td>
                      <td style={{ textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                        <Button variant="ghost" size="icon" title="Delete" onClick={() => setDeleting(set)}>
                          <Icon.trash size={12} />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          )}
        </Async>
      </Section>

      {selected ? (
        <Section
          title={`Rules in “${selected.name}”`}
          hint="Highest priority wins; ties break on creation order"
          actions={
            <Button variant="primary" icon={<Icon.plus size={13} />} onClick={() => setEditing({ setId: selected.id })}>
              Add rule
            </Button>
          }
        >
          <Async query={rules} empty={(l) => l.length === 0
            ? <Empty title="No rules in this set"
              action={<Button variant="primary" onClick={() => setEditing({ setId: selected.id })}>Add the first rule</Button>}>
              A rule maps a source — an asset id, a glob or part of a URL — onto a replacement.
            </Empty>
            : null}>
            {(all) => (
              <Panel flush>
                <table className="table">
                  <thead>
                    <tr><th style={{ width: 40 }}>On</th><th>Source</th><th>Action</th><th>Target</th><th>Type</th><th className="num">Priority</th><th className="num">Hits</th><th /></tr>
                  </thead>
                  <tbody>
                    {all.map((rule) => (
                      <tr key={rule.id}>
                        <td>
                          <Toggle
                            label={`Enable rule ${rule.source}`}
                            checked={rule.enabled}
                            onChange={async (enabled) => {
                              await call('assets:rule:upsert', { ...rule, enabled });
                              rules.refetch();
                            }}
                          />
                        </td>
                        <td className="mono">{rule.source}</td>
                        <td className="dim small">{ACTION_LABEL[rule.action]}</td>
                        <td className="mono micro truncate" title={rule.target}>{rule.target || '—'}</td>
                        <td className="dim">{rule.assetType}</td>
                        <td className="num">{rule.priority}</td>
                        <td className="num dim">{count(rule.hits)}</td>
                        <td style={{ textAlign: 'right' }}>
                          <span className="flex" style={{ justifyContent: 'flex-end', gap: 'var(--s1)' }}>
                            <Button variant="ghost" size="icon" title="Edit" onClick={() => setEditing(rule)}>
                              <Icon.sliders size={12} />
                            </Button>
                            <Button
                              variant="ghost" size="icon" title="Delete"
                              onClick={async () => { await call('assets:rule:delete', rule.id); rules.refetch(); sets.refetch(); }}
                            >
                              <Icon.trash size={12} />
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

          <div className="mt"><RuleTester /></div>
        </Section>
      ) : null}

      {menu.node}

      {creating ? (
        <CreateSetModal
          onClose={() => setCreating(false)}
          onCreated={(set) => { sets.refetch(); setSelectedId(set.id); setCreating(false); }}
        />
      ) : null}

      {editing ? (
        <RuleModal
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); rules.refetch(); sets.refetch(); }}
        />
      ) : null}

      {deleting ? (
        <Confirm
          title={`Delete “${deleting.name}”`}
          confirmLabel="Delete"
          danger
          pending={remove.pending}
          onConfirm={() => void remove.run(deleting.id)}
          onClose={() => setDeleting(null)}
          description={`This removes the set and its ${deleting.ruleCount} rule(s). Cached assets are not deleted.`}
        />
      ) : null}
    </>
  );
}

function RuleTester() {
  const [assetId, setAssetId] = useState('');
  const [result, setResult] = useState<{ reason: string; matched: boolean } | null>(null);

  const test = useAction(async () => {
    const r = await call('assets:rule:test', { assetId: assetId.trim() });
    if (r.ok) setResult({ reason: r.value.reason, matched: r.value.rule !== null });
    return r;
  });

  return (
    <Panel head={<><Icon.search size={14} /><h3>Test a rule</h3><span className="micro dim">What would happen to this asset id?</span></>}>
      <div className="flex" style={{ gap: 'var(--s3)' }}>
        <input
          className="input mono"
          style={{ width: 220 }}
          placeholder="123456789"
          value={assetId}
          onChange={(e) => { setAssetId(e.target.value); setResult(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && assetId.trim()) void test.run(); }}
        />
        <Button onClick={() => void test.run()} pending={test.pending} disabled={!assetId.trim()}>Test</Button>
        {result ? (
          <span className="flex small" style={{ gap: 'var(--s2)' }}>
            <Dot tone={result.matched ? 'ok' : 'idle'} />
            <span className={result.matched ? '' : 'dim'}>{result.reason}</span>
          </span>
        ) : null}
      </div>
    </Panel>
  );
}

function Interception({ shell }: { shell: ShellState }) {
  const toast = useToast();
  const state = shell.interception;
  const explain = useQuery('interception:explain', undefined);
  const settings = shell.settings;
  const [showExplain, setShowExplain] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const install = useAction(async () => {
    const r = await call('interception:install-certificate', { confirm: true });
    setShowExplain(false);
    if (r.ok) toast({ kind: 'success', title: 'Certificate installed', message: "Added to Roblox Player's own bundle only." });
    else toast({ kind: 'error', title: 'Could not install', message: r.error.message });
    return r;
  });

  const removeCert = useAction(async () => {
    const r = await call('interception:remove-certificate', undefined);
    setConfirmRemove(false);
    if (r.ok) toast({ kind: 'success', title: 'Certificate removed' });
    return r;
  });

  const start = useAction(async () => {
    const r = await call('interception:start', undefined);
    if (!r.ok) toast({ kind: 'error', title: 'Could not start', message: r.error.message });
    return r;
  });

  const stop = useAction(() => call('interception:stop', undefined));

  const running = state?.status === 'running';

  return (
    <>
      <Section title="Engine">
        <Panel>
          <div className="rows">
            <Row
              name={<span className="flex" style={{ gap: 'var(--s2)' }}>
                <Dot tone={running ? 'ok' : state?.status === 'degraded' ? 'warn' : state?.status === 'failed' ? 'danger' : 'idle'} />
                Status
              </span>}
              desc={state?.detail ?? 'The proxy runs on loopback and is reachable only by the client Blossom launches.'}
            >
              <span className="flex" style={{ gap: 'var(--s3)' }}>
                <Badge tone={running ? 'ok' : state?.status === 'failed' ? 'danger' : 'default'}>{state?.status ?? 'stopped'}</Badge>
                {state?.port ? <span className="mono micro dim">127.0.0.1:{state.port}</span> : null}
                {running
                  ? <Button onClick={() => void stop.run()} pending={stop.pending}>Stop</Button>
                  : <Button variant="primary" onClick={() => void start.run()} pending={start.pending} disabled={!settings?.interception.enabled}>Start</Button>}
              </span>
            </Row>

            <Row
              name="Master switch"
              desc="A profile can only enable interception when this is on."
            >
              <Toggle
                label="Enable interception"
                checked={settings?.interception.enabled ?? false}
                onChange={async (enabled) => {
                  await call('app:settings:update', { interception: { ...settings!.interception, enabled } });
                }}
              />
            </Row>

            <Row
              name="Certificate"
              desc="Added to Roblox Player's own certificate bundle, never to the Windows trust store."
            >
              <span className="flex" style={{ gap: 'var(--s3)' }}>
                <Badge tone={state?.certificateInstalled ? 'ok' : 'warn'}>
                  {state?.certificateInstalled ? 'installed' : 'not installed'}
                </Badge>
                {state?.certificateInstalled
                  ? <Button variant="danger" onClick={() => setConfirmRemove(true)}>Remove</Button>
                  : <Button onClick={() => setShowExplain(true)} icon={<Icon.shield size={13} />}>Review and install</Button>}
              </span>
            </Row>
          </div>
        </Panel>
      </Section>

      {state && state.stats.requests > 0 ? (
        <Section title="This session">
          <div className="grid-3">
            <Stat label="Requests" value={count(state.stats.requests)} />
            <Stat label="Decrypted" value={count(state.stats.intercepted)} detail="Asset hosts only" />
            <Stat label="Tunnelled" value={count(state.stats.tunnelled)} detail="Passed through unread" />
            <Stat label="Replaced" value={count(state.stats.replaced)} />
            <Stat label="Cache hits" value={ratio(state.stats.intercepted ? state.stats.cacheHits / state.stats.intercepted : null)} />
            <Stat label="Added latency" value={milliseconds(state.stats.meanOverheadMs)} detail="Mean, per intercepted request" />
          </div>
          {state.stats.errors ? (
            <div className="mt">
              <Notice tone="warn" title={`${count(state.stats.errors)} request(s) failed`}>
                Each one fell back to the original upstream response, so the client was not affected.
              </Notice>
            </div>
          ) : null}
        </Section>
      ) : null}

      <Section title="Scope" hint="Hosts Blossom is allowed to decrypt">
        <Panel>
          <p className="small muted mb">
            Everything else — sign-in, account, payment and telemetry connections — is tunnelled without
            being decrypted. Hosts outside this list cannot be added, and the list is enforced in one
            place in the engine rather than per request.
          </p>
          <div className="flex wrap" style={{ gap: 'var(--s2)' }}>
            {(settings?.interception.scope ?? []).map((host) => (
              <Badge key={host}>{host}</Badge>
            ))}
          </div>
        </Panel>
      </Section>

      {showExplain && explain.data ? (
        <Modal
          title="What starting interception changes"
          description="Read this before installing anything. Every item is reversible from this page."
          onClose={() => setShowExplain(false)}
          width={620}
          footer={
            <>
              <Button variant="ghost" onClick={() => setShowExplain(false)}>Cancel</Button>
              <Button variant="primary" pending={install.pending} onClick={() => void install.run()}>
                I understand — install the certificate
              </Button>
            </>
          }
        >
          <div className="rows">
            {explain.data.changes.map((change) => (
              <div className="row" key={change.target}>
                <div className="label">
                  <div className="name mono micro">{change.target}</div>
                  <div className="desc">{change.description}</div>
                </div>
                <div className="control">
                  <Badge tone={change.reversible ? 'ok' : 'warn'}>{change.reversible ? 'reversible' : 'permanent'}</Badge>
                </div>
              </div>
            ))}
          </div>
          <div className="mt">
            <Notice tone={explain.data.requiresElevation ? 'warn' : 'info'}>
              {explain.data.requiresElevation
                ? 'This needs administrator rights. Blossom will explain exactly why before asking.'
                : 'None of this needs administrator rights, because the change is scoped to Roblox\'s own files and a high loopback port.'}
            </Notice>
          </div>
        </Modal>
      ) : null}

      {confirmRemove ? (
        <Confirm
          title="Remove the certificate"
          confirmLabel="Remove"
          danger
          pending={removeCert.pending}
          onConfirm={() => void removeCert.run()}
          onClose={() => setConfirmRemove(false)}
          description="Blossom removes its block from Roblox's certificate bundle and deletes the local certificate authority. Interception stops working until you install it again."
        />
      ) : null}
    </>
  );
}

function Capture() {
  const toast = useToast();
  const state = useQuery('capture:state', undefined);
  const [events, setEvents] = useState<CaptureEvent[]>([]);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState<AssetType | 'all'>('all');

  useEffect(() => {
    void call('capture:recent', { limit: 300 }).then((r) => { if (r.ok) setEvents(r.value); });
  }, []);

  useEffect(() => on('capture:event', (batch) => {
    if (paused) return;
    // Newest first, bounded — the live view never holds more than it can draw.
    setEvents((current) => [...[...batch].reverse(), ...current].slice(0, 500));
  }), [paused]);

  const visible = useMemo(() => {
    const term = filter.trim().toLowerCase();
    return events.filter((e) =>
      (typeFilter === 'all' || e.assetType === typeFilter) &&
      (!term || e.assetId.includes(term) || e.url.toLowerCase().includes(term))
    );
  }, [events, filter, typeFilter]);

  const toggle = useAction(async () => {
    const active = state.data?.active;
    const r = active ? await call('capture:stop', undefined) : await call('capture:start', undefined);
    state.refetch();
    if (!r.ok) toast({ kind: 'error', title: 'Could not change capture', message: r.error.message });
    return r;
  });

  const active = state.data?.active ?? false;
  const source = state.data?.source ?? 'none';

  return (
    <>
      <Section title="Live capture" hint="Every asset the client requests, as it requests it">
        <Panel>
          <div className="flex between wrap" style={{ gap: 'var(--s4)' }}>
            <div className="flex" style={{ gap: 'var(--s3)' }}>
              <Button variant={active ? 'default' : 'primary'} onClick={() => void toggle.run()} pending={toggle.pending}
                icon={active ? <Icon.pause size={13} /> : <Icon.record size={13} />}>
                {active ? 'Stop capture' : 'Start capture'}
              </Button>
              <Button onClick={() => setPaused((p) => !p)} disabled={!active}>
                {paused ? 'Resume view' : 'Pause view'}
              </Button>
              <Button variant="ghost" onClick={() => { setEvents([]); void call('capture:clear', undefined); }}>Clear</Button>
              <Button
                variant="ghost"
                icon={<Icon.download size={13} />}
                onClick={async () => {
                  const r = await call('capture:export', {});
                  if (r.ok) toast({ kind: 'success', title: `${count(r.value.count)} events exported`, message: r.value.path });
                }}
              >
                Export
              </Button>
            </div>
            <div className="flex" style={{ gap: 'var(--s2)' }}>
              <Select
                ariaLabel="Type"
                value={typeFilter}
                options={[{ value: 'all', label: 'All types' }, ...ASSET_TYPES.map((t) => ({ value: t, label: t }))]}
                onChange={(v) => setTypeFilter(v as AssetType | 'all')}
              />
              <input
                className="input"
                style={{ width: 200 }}
                placeholder="Filter by id or URL…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
          </div>

          <div className="flex mt" style={{ gap: 'var(--s4)' }}>
            <span className="flex micro" style={{ gap: 'var(--s2)' }}>
              <Dot tone={active ? 'live' : 'idle'} />
              {active ? `capturing via ${source === 'proxy' ? 'the interception proxy' : source === 'roblox-cache' ? "Roblox's own cache" : 'nothing available'}` : 'not capturing'}
            </span>
            <span className="micro dim num">{count(state.data?.count ?? 0)} indexed</span>
            {state.data?.dropped ? <Badge tone="warn">{count(state.data.dropped)} dropped</Badge> : null}
          </div>

          {active && source === 'roblox-cache' ? (
            <div className="mt">
              <Notice tone="warn" title="Limited capture">
                Interception is not running, so Blossom is watching Roblox's own cache instead. Newer
                clients strip request details from those files, so many assets will appear without an id.
                Start interception for complete capture.
              </Notice>
            </div>
          ) : null}
        </Panel>
      </Section>

      <Section title={`Stream · ${count(visible.length)}`}>
        {visible.length === 0 ? (
          <Empty icon={<Icon.activity size={22} />} title={active ? 'Waiting for the client' : 'Capture is off'}>
            {active ? 'Launch Roblox and load an experience to see requests appear here.' : 'Start capture to watch assets as the client requests them.'}
          </Empty>
        ) : (
          <Panel flush>
            <table className="table">
              <thead><tr><th>Time</th><th>Type</th><th>Asset</th><th className="num">Size</th><th>Outcome</th><th className="num">Added</th></tr></thead>
              <tbody>
                {visible.slice(0, 200).map((event, i) => (
                  <tr key={`${event.at}-${event.assetId}-${i}`}>
                    <td className="mono micro dim">{time(event.at)}</td>
                    <td className="dim">{event.assetType}</td>
                    <td className="mono truncate" title={event.url}>{event.assetId}</td>
                    <td className="num">{event.sizeBytes !== null ? bytes(event.sizeBytes) : '—'}</td>
                    <td>
                      <Badge tone={event.outcome === 'replaced' ? 'accent' : event.outcome === 'error' ? 'danger' : event.outcome === 'removed' ? 'warn' : 'default'}>
                        {event.outcome}
                      </Badge>
                    </td>
                    <td className="num dim">{event.overheadMs !== null ? milliseconds(event.overheadMs) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}
      </Section>
    </>
  );
}

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="panel" style={{ padding: 'var(--s4) var(--s5)' }}>
      <div className="micro dim" style={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
      <div className="num" style={{ fontSize: 'var(--t-display)', fontWeight: 600, marginTop: 4 }}>{value}</div>
      {detail ? <div className="micro dim" style={{ marginTop: 2 }}>{detail}</div> : null}
    </div>
  );
}

function CreateSetModal({ onClose, onCreated }: { onClose: () => void; onCreated: (s: AssetRuleSet) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = useAction(async () => {
    const r = await call('assets:set:create', { name: name.trim(), description });
    if (r.ok) onCreated(r.value);
    else setError(r.error.message);
    return r;
  });

  return (
    <Modal
      title="New rule set"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim()} pending={create.pending} onClick={() => void create.run()}>Create</Button>
        </>
      }
    >
      <div className="col" style={{ gap: 'var(--s5)' }}>
        <Field label="Name" error={error}>
          {(id) => (
            <input id={id} className="input" autoFocus value={name} placeholder="Low Texture, Custom Sounds…"
              onChange={(e) => { setName(e.target.value); setError(null); }} />
          )}
        </Field>
        <Field label="Description" hint="Optional.">
          {(id) => <input id={id} className="input" value={description} onChange={(e) => setDescription(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  );
}

function RuleModal({
  initial, onClose, onSaved
}: { initial: Partial<AssetRule>; onClose: () => void; onSaved: () => void }) {
  const [source, setSource] = useState(initial.source ?? '');
  const [action, setAction] = useState<RuleAction>(initial.action ?? 'replace-asset');
  const [target, setTarget] = useState(initial.target ?? '');
  const [assetType, setAssetType] = useState<AssetType>(initial.assetType ?? 'unknown');
  const [priority, setPriority] = useState(String(initial.priority ?? 0));
  const [notes, setNotes] = useState(initial.notes ?? '');
  const [error, setError] = useState<string | null>(null);

  const save = useAction(async () => {
    const r = await call('assets:rule:upsert', {
      id: initial.id,
      setId: initial.setId!,
      source: source.trim(),
      action,
      target: target.trim(),
      assetType,
      enabled: initial.enabled ?? true,
      priority: Number(priority) || 0,
      notes
    });
    if (r.ok) onSaved();
    else setError(r.error.message);
    return r;
  });

  const needsTarget = action !== 'remove' && action !== 'passthrough';

  return (
    <Modal
      title={initial.id ? 'Edit rule' : 'New rule'}
      description="The source is an asset id, a glob over the request URL, or a piece of a URL."
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!source.trim()} pending={save.pending} onClick={() => void save.run()}>Save</Button>
        </>
      }
    >
      <div className="col" style={{ gap: 'var(--s5)' }}>
        <Field label="Source" error={error} hint="123456789, or *rbxcdn.com/textures/*">
          {(id) => <input id={id} className="input mono" autoFocus value={source} spellCheck={false}
            onChange={(e) => { setSource(e.target.value); setError(null); }} />}
        </Field>

        <Field label="Action">
          {() => (
            <Select
              ariaLabel="Action"
              value={action}
              options={(Object.keys(ACTION_LABEL) as RuleAction[]).map((a) => ({ value: a, label: ACTION_LABEL[a] }))}
              onChange={setAction}
            />
          )}
        </Field>

        {needsTarget ? (
          <Field
            label="Target"
            hint={
              action === 'replace-asset' ? 'A numeric asset id.'
                : action === 'replace-url' ? 'An https URL. Plain http is refused.'
                  : 'A full path to a file on this machine.'
            }
          >
            {(id) => <input id={id} className="input mono" value={target} spellCheck={false} onChange={(e) => setTarget(e.target.value)} />}
          </Field>
        ) : null}

        <div className="flex" style={{ gap: 'var(--s5)' }}>
          <Field label="Asset type" hint="Used for filtering only.">
            {() => <Select ariaLabel="Asset type" value={assetType} options={ASSET_TYPES.map((t) => ({ value: t, label: t }))} onChange={setAssetType} />}
          </Field>
          <Field label="Priority" hint="Higher wins.">
            {(id) => <input id={id} className="input num" style={{ width: 80 }} value={priority} onChange={(e) => setPriority(e.target.value)} />}
          </Field>
        </div>

        <Field label="Notes" hint="Optional — what this rule is for.">
          {(id) => <input id={id} className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />}
        </Field>

        <Notice tone="info">
          If the replacement cannot be served — a missing file, an unreachable URL — Blossom serves the
          original asset instead. A rule can never break the client.
        </Notice>
      </div>
    </Modal>
  );
}
