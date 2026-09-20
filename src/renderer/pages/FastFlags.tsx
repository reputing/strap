import { useMemo, useState } from 'react';
import { call, useAction, useDebounced, useQuery } from '@renderer/lib/api';
import { count } from '@renderer/lib/format';
import { Icon } from '@renderer/components/icons';
import {
  Async, Badge, Button, Confirm, Empty, Field, Modal, Notice, Panel,
  Section, Segmented, Select, Tip, useContextMenu, useToast
} from '@renderer/components/ui';
import { PageHead, type ShellState } from '@renderer/app/Shell';
import type { FlagDefinition, FlagValidationIssue } from '@shared/types';

const CONFIDENCE_TONE = { documented: 'ok', community: 'default', unverified: 'warn' } as const;

/**
 * The FastFlag editor.
 *
 * Two views on the same data: the overrides this profile sets, and the catalog
 * of flags Blossom can describe. The diff view is the point — it answers "what
 * is Blossom changing" with a literal list rather than a promise.
 */
export function FastFlags({ shell }: { shell: ShellState }) {
  const toast = useToast();
  const menu = useContextMenu();
  const profile = shell.profile;

  const catalog = useQuery('flags:catalog', undefined);
  const diff = useQuery('flags:diff', {}, { on: ['profiles:changed'], deps: [profile?.id] });

  const [view, setView] = useState<'overrides' | 'catalog' | 'diff'>('overrides');
  const [term, setTerm] = useState('');
  const debounced = useDebounced(term);
  const [editing, setEditing] = useState<{ name: string; value: string; isNew: boolean } | null>(null);
  const [importing, setImporting] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const flags = profile?.fastFlags ?? {};
  const issues = useQuery('flags:validate', flags, { deps: [JSON.stringify(flags)] });
  const issuesByName = useMemo(() => {
    const map = new Map<string, FlagValidationIssue>();
    for (const issue of issues.data ?? []) if (!map.has(issue.name)) map.set(issue.name, issue);
    return map;
  }, [issues.data]);

  const catalogByName = useMemo(
    () => new Map((catalog.data ?? []).map((f) => [f.name, f])),
    [catalog.data]
  );

  const setFlag = useAction(async (name: string, value: string) => {
    const r = await call('flags:set', { flags: { [name]: value } });
    if (r.ok) { setEditing(null); }
    else toast({ kind: 'error', title: 'Could not set that flag', message: r.error.message });
    return r;
  });

  const removeFlags = useAction(async (names: string[]) => {
    const r = await call('flags:remove', { names });
    if (!r.ok) toast({ kind: 'error', title: 'Could not remove', message: r.error.message });
    return r;
  });

  const applyNow = useAction(async () => {
    const r = await call('flags:apply-now', undefined);
    if (r.ok) {
      toast({
        kind: 'success',
        title: 'Written to Roblox',
        message: `${count(r.value.flagCount)} flags written. Roblox clears this file when it updates; Blossom re-applies at launch.`
      });
    } else {
      toast({ kind: 'error', title: 'Could not write', message: r.error.message });
    }
    return r;
  });

  const clearApplied = useAction(async () => {
    const r = await call('flags:clear-applied', undefined);
    setConfirmClear(false);
    if (r.ok) toast({ kind: 'success', title: 'Overrides removed from Roblox' });
    return r;
  });

  const exportFlags = useAction(async () => {
    const r = await call('flags:export', {});
    if (r.ok) {
      await navigator.clipboard.writeText(r.value);
      toast({ kind: 'success', title: 'Copied to the clipboard' });
    }
    return r;
  });

  const overrideRows = useMemo(() => {
    const search = debounced.trim().toLowerCase();
    return Object.entries(flags)
      .filter(([name, value]) => !search || name.toLowerCase().includes(search) || value.toLowerCase().includes(search))
      .sort(([a], [b]) => a.localeCompare(b));
  }, [flags, debounced]);

  const catalogRows = useMemo(() => {
    const search = debounced.trim().toLowerCase();
    return (catalog.data ?? []).filter((f) =>
      !search || f.name.toLowerCase().includes(search) || f.description.toLowerCase().includes(search) || f.category.includes(search)
    );
  }, [catalog.data, debounced]);

  const errorCount = (issues.data ?? []).filter((i) => i.severity === 'error').length;

  return (
    <div className="page">
      <PageHead
        eyebrow="Engine"
        title="FastFlags"
        actions={
          <>
            <Button icon={<Icon.copy size={13} />} onClick={() => void exportFlags.run()}>Copy JSON</Button>
            <Button icon={<Icon.upload size={13} />} onClick={() => setImporting(true)}>Import</Button>
            <Button variant="primary" icon={<Icon.plus size={13} />} onClick={() => setEditing({ name: '', value: '', isNew: true })}>
              Add flag
            </Button>
          </>
        }
      >
        Flags are stored in your profile and written into Roblox's <code className="mono micro">ClientAppSettings.json</code> at
        launch. Blossom validates every value against the type its prefix implies, and marks flags it
        cannot describe rather than guessing at what they do.
      </PageHead>

      {errorCount ? (
        <div className="mb">
          <Notice tone="danger" title={`${errorCount} flag value${errorCount === 1 ? '' : 's'} are not valid`}>
            The profile will not launch until these are fixed. Invalid values are highlighted below.
          </Notice>
        </div>
      ) : null}

      <div className="flex between mb" style={{ gap: 'var(--s4)' }}>
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: 'overrides', label: `Overrides · ${Object.keys(flags).length}` },
            { value: 'catalog', label: `Catalog · ${catalog.data?.length ?? 0}` },
            { value: 'diff', label: 'Diff' }
          ]}
        />
        <div className="flex" style={{ gap: 'var(--s2)' }}>
          <input
            className="input"
            style={{ width: 260 }}
            placeholder="Search flags…"
            value={term}
            spellCheck={false}
            onChange={(e) => setTerm(e.target.value)}
          />
          <Button onClick={() => void applyNow.run()} pending={applyNow.pending} icon={<Icon.download size={13} />}>
            Write to Roblox now
          </Button>
          <Button variant="ghost" onClick={() => setConfirmClear(true)}>Clear from Roblox</Button>
        </div>
      </div>

      {view === 'overrides' ? (
        overrideRows.length === 0 ? (
          <Empty
            icon={<Icon.flag size={22} />}
            title={term ? 'No overrides match that search' : 'No flag overrides'}
            action={<Button variant="primary" onClick={() => setEditing({ name: '', value: '', isNew: true })}>Add a flag</Button>}
          >
            {term ? undefined : 'Applying an optimizer preset is the usual way to fill this in.'}
          </Empty>
        ) : (
          <Panel flush>
            <table className="table">
              <thead>
                <tr><th>Flag</th><th>Value</th><th>Roblox default</th><th>Source</th><th /></tr>
              </thead>
              <tbody>
                {overrideRows.map(([name, value]) => {
                  const definition = catalogByName.get(name) ?? null;
                  const issue = issuesByName.get(name);
                  return (
                    <tr
                      key={name}
                      onContextMenu={(e) => menu.open(e, [
                        { label: 'Edit…', onSelect: () => setEditing({ name, value, isNew: false }) },
                        { label: 'Copy name', onSelect: () => void navigator.clipboard.writeText(name) },
                        { separator: true, label: '' },
                        { label: 'Remove', danger: true, onSelect: () => void removeFlags.run([name]) }
                      ])}
                    >
                      <td className="mono">
                        <span className="flex" style={{ gap: 'var(--s2)' }}>
                          {name}
                          {issue ? (
                            <Tip text={issue.message}>
                              <span style={{ color: issue.severity === 'error' ? 'var(--danger)' : 'var(--warn)', display: 'flex' }}>
                                <Icon.warning size={12} />
                              </span>
                            </Tip>
                          ) : null}
                        </span>
                      </td>
                      <td className="mono" style={{ color: issue?.severity === 'error' ? 'var(--danger)' : 'var(--accent)' }}>{value}</td>
                      <td className="mono dim">{definition?.robloxDefault ?? 'not published'}</td>
                      <td>
                        <Badge tone={definition ? CONFIDENCE_TONE[definition.confidence] : 'warn'}>
                          {definition?.confidence ?? 'unverified'}
                        </Badge>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <span className="flex" style={{ justifyContent: 'flex-end', gap: 'var(--s1)' }}>
                          <Button variant="ghost" size="icon" title="Edit" onClick={() => setEditing({ name, value, isNew: false })}>
                            <Icon.sliders size={12} />
                          </Button>
                          <Button variant="ghost" size="icon" title="Remove" onClick={() => void removeFlags.run([name])}>
                            <Icon.trash size={12} />
                          </Button>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Panel>
        )
      ) : null}

      {view === 'catalog' ? (
        <Async query={catalog}>
          {() => (
            <Panel flush>
              <table className="table">
                <thead>
                  <tr><th>Flag</th><th>Type</th><th>Category</th><th>Risk</th><th>Confidence</th><th /></tr>
                </thead>
                <tbody>
                  {catalogRows.map((flag) => (
                    <CatalogRow
                      key={flag.name}
                      flag={flag}
                      set={flags[flag.name]}
                      onSet={() => setEditing({
                        name: flag.name,
                        value: flags[flag.name] ?? flag.robloxDefault ?? (flag.valueType === 'bool' ? 'True' : ''),
                        isNew: flags[flag.name] === undefined
                      })}
                    />
                  ))}
                </tbody>
              </table>
            </Panel>
          )}
        </Async>
      ) : null}

      {view === 'diff' ? (
        <Section title="Roblox default vs Blossom override" hint="What the client would do, and what it will do">
          <Async query={diff} empty={(rows) => rows.length === 0 ? <Empty title="No differences" >Blossom is not overriding anything.</Empty> : null}>
            {(rows) => (
              <Panel flush>
                <div className="diff">
                  <div className="diff-row" style={{ color: 'var(--text-3)', fontFamily: 'var(--font)' }}>
                    <span className="name">Flag</span>
                    <span>Roblox default</span>
                    <span>Blossom</span>
                  </div>
                  {rows.map((row) => (
                    <div className={`diff-row ${row.kind}`} key={row.name}>
                      <span className="name" title={row.definition?.description}>{row.name}</span>
                      <span className="from">{row.robloxDefault ?? 'not published'}</span>
                      <span className="to">{row.blossomValue ?? 'removed'}</span>
                    </div>
                  ))}
                </div>
              </Panel>
            )}
          </Async>
        </Section>
      ) : null}

      {menu.node}

      {editing ? (
        <FlagEditor
          initial={editing}
          definition={catalogByName.get(editing.name) ?? null}
          catalog={catalog.data ?? []}
          pending={setFlag.pending}
          onSave={(name, value) => void setFlag.run(name, value)}
          onClose={() => setEditing(null)}
        />
      ) : null}

      {importing ? <ImportFlagsModal onClose={() => setImporting(false)} /> : null}

      {confirmClear ? (
        <Confirm
          title="Remove overrides from Roblox"
          confirmLabel="Remove"
          pending={clearApplied.pending}
          onConfirm={() => void clearApplied.run()}
          onClose={() => setConfirmClear(false)}
          description="Deletes the override file from the Roblox version folder so the client uses its own values. Your profile keeps the flags, and they are re-applied the next time you launch through Blossom."
        />
      ) : null}
    </div>
  );
}

function CatalogRow({
  flag, set, onSet
}: { flag: FlagDefinition; set: string | undefined; onSet: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr onClick={() => setOpen((v) => !v)} style={{ cursor: 'pointer' }} aria-selected={set !== undefined}>
        <td className="mono">{flag.name}</td>
        <td className="dim">{flag.valueType}</td>
        <td className="dim">{flag.category}</td>
        <td><Badge tone={flag.risk === 'safe' ? 'ok' : flag.risk === 'advanced' ? 'danger' : flag.risk === 'moderate' ? 'warn' : 'default'}>{flag.risk}</Badge></td>
        <td><Badge tone={CONFIDENCE_TONE[flag.confidence]}>{flag.confidence}</Badge></td>
        <td style={{ textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
          <span className="flex" style={{ justifyContent: 'flex-end', gap: 'var(--s2)' }}>
            {set !== undefined ? <Badge tone="accent">{set}</Badge> : null}
            <Button variant="ghost" onClick={onSet}>{set === undefined ? 'Set' : 'Edit'}</Button>
          </span>
        </td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={6} style={{ height: 'auto', padding: 'var(--s3) var(--s4) var(--s4)', background: 'var(--surface-2)' }}>
            <p className="small muted" style={{ maxWidth: '78ch' }}>{flag.description}</p>
            {flag.deprecatedNote ? <p className="small" style={{ color: 'var(--warn)', marginTop: 4 }}>{flag.deprecatedNote}</p> : null}
            {flag.suggestions?.length ? (
              <p className="micro dim mono" style={{ marginTop: 6 }}>Common values: {flag.suggestions.join('  ·  ')}</p>
            ) : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}

function FlagEditor({
  initial, definition, catalog, onSave, onClose, pending
}: {
  initial: { name: string; value: string; isNew: boolean };
  definition: FlagDefinition | null;
  catalog: FlagDefinition[];
  onSave: (name: string, value: string) => void;
  onClose: () => void;
  pending: boolean;
}) {
  const [name, setName] = useState(initial.name);
  const [value, setValue] = useState(initial.value);
  const check = useQuery('flags:validate', { [name]: value }, { deps: [name, value], enabled: Boolean(name) });
  const issue = check.data?.[0];
  const matched = catalog.find((f) => f.name === name) ?? definition;
  const blocked = issue?.severity === 'error' || !name.trim();

  return (
    <Modal
      title={initial.isNew ? 'Add a FastFlag' : name}
      description={matched?.description ?? 'Blossom does not recognise this flag; it will validate the syntax and leave the meaning alone.'}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={blocked} pending={pending} onClick={() => onSave(name.trim(), value)}>Save</Button>
        </>
      }
    >
      <div className="col" style={{ gap: 'var(--s5)' }}>
        <Field
          label="Flag name"
          error={issue?.severity === 'error' && issue.message.includes('prefix') ? issue.message : null}
          hint="Names start with FFlag, DFFlag, FInt, DFInt, FString and similar."
        >
          {(id) => (
            <input
              id={id}
              className="input mono"
              list="flag-catalog"
              autoFocus={initial.isNew}
              value={name}
              spellCheck={false}
              onChange={(e) => setName(e.target.value)}
              disabled={!initial.isNew}
            />
          )}
        </Field>
        <datalist id="flag-catalog">
          {catalog.map((f) => <option key={f.name} value={f.name}>{f.description.slice(0, 60)}</option>)}
        </datalist>

        <Field
          label="Value"
          error={issue?.severity === 'error' && !issue.message.includes('prefix') ? issue.message : null}
          hint={matched?.robloxDefault ? `Roblox's own default is ${matched.robloxDefault}.` : 'Roblox does not publish a default for this flag.'}
        >
          {(id) => matched?.valueType === 'bool' ? (
            <Select
              ariaLabel="Value"
              value={/^true$/i.test(value) ? 'True' : 'False'}
              options={[{ value: 'True', label: 'True' }, { value: 'False', label: 'False' }]}
              onChange={setValue}
            />
          ) : (
            <input
              id={id}
              className="input mono"
              value={value}
              spellCheck={false}
              autoFocus={!initial.isNew}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
        </Field>

        {matched?.suggestions?.length ? (
          <div className="flex wrap" style={{ gap: 'var(--s2)' }}>
            {matched.suggestions.map((s) => (
              <button key={s} className="btn ghost" onClick={() => setValue(s)}>{s}</button>
            ))}
          </div>
        ) : null}

        {issue?.severity === 'warning' ? <Notice tone="warn">{issue.message}</Notice> : null}
        {matched?.risk === 'advanced' ? (
          <Notice tone="warn" title="Marked advanced">
            A wrong value here can make the client unusable. Blossom can always remove it again from this page.
          </Notice>
        ) : null}
      </div>
    </Modal>
  );
}

function ImportFlagsModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [json, setJson] = useState('');
  const [merge, setMerge] = useState(true);

  const run = useAction(async () => {
    const r = await call('flags:import', { json, merge });
    if (r.ok) {
      onClose();
      const errors = r.value.issues.filter((i) => i.severity === 'error').length;
      toast({
        kind: errors ? 'warning' : 'success',
        title: 'Flags imported',
        message: errors ? `${errors} value(s) need attention.` : undefined
      });
    } else {
      toast({ kind: 'error', title: 'Import failed', message: r.error.message });
    }
    return r;
  });

  return (
    <Modal
      title="Import FastFlags"
      description="Paste a flat JSON object of flag names to values — the same format every other launcher uses."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!json.trim()} pending={run.pending} onClick={() => void run.run()}>Import</Button>
        </>
      }
    >
      <div className="col" style={{ gap: 'var(--s4)' }}>
        <Segmented
          value={merge ? 'merge' : 'replace'}
          onChange={(v) => setMerge(v === 'merge')}
          options={[
            { value: 'merge', label: 'Merge with existing' },
            { value: 'replace', label: 'Replace everything' }
          ]}
        />
        <Field label="JSON">
          {(id) => (
            <textarea
              id={id}
              className="input"
              rows={11}
              value={json}
              spellCheck={false}
              autoFocus
              placeholder={'{\n  "DFIntTaskSchedulerTargetFps": "144",\n  "FFlagDisablePostFx": "True"\n}'}
              onChange={(e) => setJson(e.target.value)}
            />
          )}
        </Field>
      </div>
    </Modal>
  );
}
