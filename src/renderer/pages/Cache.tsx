import { useEffect, useMemo, useState } from 'react';
import { call, useAction, useDebounced, useQuery } from '@renderer/lib/api';
import { bytes, count, dateTime, relative } from '@renderer/lib/format';
import { Icon } from '@renderer/components/icons';
import {
  Async, Badge, Button, Confirm, Empty, Field, Modal, Notice, Panel,
  Select, useContextMenu, useToast
} from '@renderer/components/ui';
import { VirtualTable, type Column } from '@renderer/components/VirtualTable';
import { AssetPreview } from '@renderer/components/AssetPreview';
import { PageHead } from '@renderer/app/Shell';
import type { AssetQuery, AssetType, CachedAsset } from '@shared/types';

const PAGE_SIZE = 200;
const TYPES: (AssetType | 'all')[] = [
  'all', 'image', 'texture', 'mesh', 'audio', 'animation', 'model', 'font', 'video', 'json', 'text', 'unknown'
];

const SIZE_FILTERS = [
  { value: 'any', label: 'Any size', min: undefined, max: undefined },
  { value: 'tiny', label: 'Under 64 KB', min: undefined, max: 64 * 1024 },
  { value: 'small', label: '64 KB – 1 MB', min: 64 * 1024, max: 1024 * 1024 },
  { value: 'large', label: 'Over 1 MB', min: 1024 * 1024, max: undefined }
] as const;

const DATE_FILTERS = [
  { value: 'any', label: 'Any time', after: undefined },
  { value: 'hour', label: 'Last hour', after: 3_600_000 },
  { value: 'day', label: 'Last 24 hours', after: 86_400_000 },
  { value: 'week', label: 'Last 7 days', after: 7 * 86_400_000 }
] as const;

/**
 * The cache browser.
 *
 * Queries are paged and served by SQLite; the table is windowed. Thousands of
 * assets never enter renderer memory, and previews are fetched one at a time on
 * selection rather than eagerly for every visible row.
 */
export function Cache() {
  const toast = useToast();
  const menu = useContextMenu();

  const [term, setTerm] = useState('');
  const debounced = useDebounced(term, 200);
  const [type, setType] = useState<AssetType | 'all'>('all');
  const [size, setSize] = useState<typeof SIZE_FILTERS[number]['value']>('any');
  const [date, setDate] = useState<typeof DATE_FILTERS[number]['value']>('any');
  const [sort, setSort] = useState<{ key: string; direction: 'asc' | 'desc' }>({ key: 'lastSeen', direction: 'desc' });
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [selected, setSelected] = useState<CachedAsset | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [showDuplicates, setShowDuplicates] = useState(false);

  const query: AssetQuery = useMemo(() => {
    const sizeFilter = SIZE_FILTERS.find((f) => f.value === size)!;
    const dateFilter = DATE_FILTERS.find((f) => f.value === date)!;
    return {
      search: debounced.trim() || undefined,
      types: type === 'all' ? undefined : [type],
      minSize: sizeFilter.min,
      maxSize: sizeFilter.max,
      seenAfter: dateFilter.after ? Date.now() - dateFilter.after : undefined,
      sort: sort.key as AssetQuery['sort'],
      direction: sort.direction,
      limit,
      offset: 0
    };
  }, [debounced, type, size, date, sort, limit]);

  const page = useQuery('cache:query', query, {
    deps: [JSON.stringify(query)],
    on: ['cache:changed']
  });
  const stats = useQuery('cache:stats', undefined, { on: ['cache:changed'] });

  // A new filter starts from the first page again.
  useEffect(() => { setLimit(PAGE_SIZE); }, [debounced, type, size, date, sort]);

  const remove = useAction(async (ids: string[]) => {
    const r = await call('cache:delete', { assetIds: ids });
    if (r.ok) {
      setSelected(null);
      toast({ kind: 'success', title: `${count(r.value.deleted)} removed`, message: `${bytes(r.value.bytesFreed)} freed.` });
    }
    return r;
  });

  const clear = useAction(async () => {
    const r = await call('cache:clear', undefined);
    setConfirmClear(false);
    if (r.ok) {
      setSelected(null);
      toast({ kind: 'success', title: 'Cache cleared', message: `${bytes(r.value.bytesFreed)} freed.` });
    }
    return r;
  });

  const exportAssets = useAction(async (ids: string[]) => {
    const r = await call('cache:export', { assetIds: ids });
    if (r.ok) toast({ kind: 'success', title: `${count(r.value.exported)} exported`, message: r.value.directory });
    else if (r.error.code !== 'cancelled') toast({ kind: 'error', title: 'Export failed', message: r.error.message });
    return r;
  });

  const columns: Column<CachedAsset>[] = [
    {
      key: 'assetId', header: 'Asset', width: 'minmax(104px, 1.6fr)', sortable: true,
      render: (a) => <span className="mono truncate">{a.assetId}</span>
    },
    {
      key: 'assetType', header: 'Type', width: 'minmax(68px, 0.7fr)',
      render: (a) => <span className="dim">{a.assetType}</span>
    },
    {
      key: 'size', header: 'Size', width: 'minmax(70px, 0.7fr)', align: 'right', sortable: true,
      render: (a) => <span className="num">{bytes(a.sizeBytes)}</span>
    },
    {
      key: 'hits', header: 'Hits', width: 'minmax(62px, 0.5fr)', align: 'right', sortable: true,
      render: (a) => <span className="num dim">{count(a.hitCount)}</span>
    },
    {
      key: 'lastSeen', header: 'Last seen', width: 'minmax(106px, 0.9fr)', sortable: true,
      render: (a) => <span className="dim">{relative(a.lastSeen)}</span>
    },
    {
      key: 'origin', header: 'Origin', width: 'minmax(116px, 0.8fr)',
      render: (a) => <Badge>{a.origin}</Badge>
    }
  ];

  if (page.error) {
    return (
      <div className="page">
        <PageHead eyebrow="Assets" title="Cache" />
        <Notice tone="danger" title="The asset index is unavailable">
          {page.error.message} {page.error.remediation ?? ''}
        </Notice>
      </div>
    );
  }

  return (
    <div className="page" style={{ maxWidth: 1320 }}>
      <PageHead
        eyebrow="Assets"
        title="Cache"
        actions={
          <>
            <Button onClick={() => setShowDuplicates(true)} icon={<Icon.copy size={13} />}>Duplicates</Button>
            <Button variant="danger" onClick={() => setConfirmClear(true)} icon={<Icon.trash size={13} />}>Clear cache</Button>
          </>
        }
      >
        Everything Blossom has captured, indexed by content. Identical bytes are stored once no matter
        how many asset ids point at them.
      </PageHead>

      {stats.data ? (
        <div className="grid-3 mb">
          <Stat label="Assets" value={count(stats.data.assetCount)} />
          <Stat label="On disk" value={bytes(stats.data.totalBytes)} />
          <Stat label="Saved by dedupe" value={bytes(stats.data.duplicateBytesSaved)} detail="Bytes never written twice" />
        </div>
      ) : null}

      <div className="flex mb wrap" style={{ gap: 'var(--s2)' }}>
        <input
          className="input"
          style={{ width: 260 }}
          placeholder="Search by asset id or URL…"
          value={term}
          spellCheck={false}
          onChange={(e) => setTerm(e.target.value)}
        />
        <Select ariaLabel="Type" value={type} options={TYPES.map((t) => ({ value: t, label: t === 'all' ? 'All types' : t }))} onChange={(v) => setType(v as AssetType | 'all')} />
        <Select ariaLabel="Size" value={size} options={SIZE_FILTERS.map((f) => ({ value: f.value, label: f.label }))} onChange={(v) => setSize(v as typeof size)} />
        <Select ariaLabel="Date" value={date} options={DATE_FILTERS.map((f) => ({ value: f.value, label: f.label }))} onChange={(v) => setDate(v as typeof date)} />
        <span className="right micro dim num">
          {page.data ? `${count(page.data.items.length)} of ${count(page.data.total)}` : ''}
        </span>
      </div>

      <div className="flex" style={{ alignItems: 'flex-start', gap: 'var(--s5)' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Async query={page} empty={(p) => p.items.length === 0
            ? <Empty icon={<Icon.database size={22} />} title={debounced ? 'Nothing matches those filters' : 'The cache is empty'}>
              {debounced ? undefined : 'Turn on capture and launch Roblox to start indexing assets.'}
            </Empty>
            : null}>
            {(p) => (
              <VirtualTable
                rows={p.items}
                columns={columns}
                height={520}
                getKey={(a) => a.assetId}
                selectedKey={selected?.assetId ?? null}
                sort={sort}
                onSort={(key) => setSort((s) => ({
                  key,
                  direction: s.key === key && s.direction === 'desc' ? 'asc' : 'desc'
                }))}
                onRowClick={setSelected}
                onReachEnd={() => { if (p.items.length < p.total) setLimit((l) => Math.min(l + PAGE_SIZE, 5000)); }}
                onRowContextMenu={(asset, e) => menu.open(e, [
                  { label: 'Copy asset id', onSelect: () => void navigator.clipboard.writeText(asset.assetId) },
                  {
                    label: 'Copy source URL',
                    disabled: !asset.sourceUrl,
                    onSelect: () => asset.sourceUrl && void navigator.clipboard.writeText(asset.sourceUrl)
                  },
                  { label: 'Export…', onSelect: () => void exportAssets.run([asset.assetId]) },
                  {
                    label: 'Open the cached file',
                    onSelect: async () => {
                      const r = await call('cache:blob-path', asset.assetId);
                      if (r.ok) await call('app:open-path', { target: 'custom', custom: r.value.path });
                    }
                  },
                  { separator: true, label: '' },
                  { label: 'Delete from cache', danger: true, onSelect: () => void remove.run([asset.assetId]) }
                ])}
              />
            )}
          </Async>
        </div>

        <div style={{ width: 330, flex: 'none' }}>
          {selected ? (
            <Inspector
              asset={selected}
              onClose={() => setSelected(null)}
              onExport={() => void exportAssets.run([selected.assetId])}
              onDelete={() => void remove.run([selected.assetId])}
            />
          ) : (
            <Panel>
              <Empty icon={<Icon.eye size={20} />} title="Select an asset">
                Previews, metadata and replacement actions appear here.
              </Empty>
            </Panel>
          )}
        </div>
      </div>

      {menu.node}

      {showDuplicates ? <DuplicatesModal onClose={() => setShowDuplicates(false)} /> : null}

      {confirmClear ? (
        <Confirm
          title="Clear the asset cache"
          confirmLabel="Clear everything"
          danger
          pending={clear.pending}
          onConfirm={() => void clear.run()}
          onClose={() => setConfirmClear(false)}
          description={
            <>
              Removes every indexed asset and every cached file
              {stats.data ? ` — ${count(stats.data.assetCount)} assets, ${bytes(stats.data.totalBytes)}` : ''}.
              Your replacement rules are not affected; assets they point at will be fetched again.
            </>
          }
        />
      ) : null}
    </div>
  );
}

function Inspector({
  asset, onClose, onExport, onDelete
}: { asset: CachedAsset; onClose: () => void; onExport: () => void; onDelete: () => void }) {
  const toast = useToast();
  const [replacing, setReplacing] = useState(false);
  const replacement = useQuery('assets:rule:test', { assetId: asset.assetId }, { deps: [asset.assetId] });

  return (
    <div className="col" style={{ gap: 'var(--s4)' }}>
      <Panel>
        <div className="flex between mb">
          <h3 className="mono truncate" title={asset.assetId}>{asset.assetId}</h3>
          <Button variant="ghost" size="icon" onClick={onClose} title="Close"><Icon.x size={12} /></Button>
        </div>
        <AssetPreview asset={asset} />
      </Panel>

      <Panel head={<h3>Details</h3>}>
        <dl className="kv">
          <dt>Type</dt><dd>{asset.assetType}</dd>
          <dt>Size</dt><dd className="num">{bytes(asset.sizeBytes)}</dd>
          <dt>Hash</dt><dd className="mono micro truncate" title={asset.hash}>{asset.hash.slice(0, 16) || '—'}</dd>
          <dt>Origin</dt><dd>{asset.origin}</dd>
          <dt>Times seen</dt><dd className="num">{count(asset.hitCount)}</dd>
          <dt>First captured</dt><dd title={dateTime(asset.firstSeen)}>{relative(asset.firstSeen)}</dd>
          <dt>Last captured</dt><dd title={dateTime(asset.lastSeen)}>{relative(asset.lastSeen)}</dd>
          <dt>Source</dt>
          <dd className="mono micro truncate" title={asset.sourceUrl ?? ''}>{asset.sourceUrl ?? 'not recorded'}</dd>
          <dt>Replacement</dt>
          <dd>
            {replacement.data?.rule
              ? <Badge tone="accent">{replacement.data.rule.action}</Badge>
              : <span className="dim small">none</span>}
          </dd>
        </dl>
        {replacement.data && !replacement.data.rule ? (
          <p className="micro dim mt">{replacement.data.reason}</p>
        ) : null}
      </Panel>

      <div className="btn-row">
        <Button variant="primary" icon={<Icon.sliders size={13} />} onClick={() => setReplacing(true)}>Replace</Button>
        <Button icon={<Icon.download size={13} />} onClick={onExport}>Export</Button>
        <Button
          icon={<Icon.copy size={13} />}
          onClick={() => { void navigator.clipboard.writeText(asset.assetId); toast({ kind: 'success', title: 'Asset id copied' }); }}
        >
          Copy id
        </Button>
        <Button
          icon={<Icon.external size={13} />}
          disabled={!asset.sourceUrl}
          onClick={() => { void navigator.clipboard.writeText(asset.sourceUrl ?? ''); toast({ kind: 'success', title: 'URL copied' }); }}
        >
          Copy URL
        </Button>
        <Button variant="danger" icon={<Icon.trash size={13} />} onClick={onDelete}>Delete</Button>
      </div>

      {replacing ? (
        <ReplaceModal
          asset={asset}
          onClose={() => setReplacing(false)}
          onSaved={() => { setReplacing(false); replacement.refetch(); }}
        />
      ) : null}
    </div>
  );
}

/**
 * Creates a replacement rule straight from the inspector — the common case is
 * "I found this asset in the cache and want to change it", and making the user
 * copy an id over to the Assets page for that would be silly.
 */
function ReplaceModal({
  asset, onClose, onSaved
}: { asset: CachedAsset; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const sets = useQuery('assets:sets', undefined);
  const [setId, setSetId] = useState('');
  const [action, setAction] = useState<'replace-asset' | 'replace-file' | 'remove'>('replace-asset');
  const [target, setTarget] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!setId && sets.data?.length) setSetId(sets.data[0]!.id);
  }, [sets.data, setId]);

  const save = useAction(async () => {
    const r = await call('assets:rule:upsert', {
      setId,
      source: asset.assetId,
      action,
      target: action === 'remove' ? '' : target.trim(),
      assetType: asset.assetType,
      enabled: true,
      priority: 0,
      notes: `Created from the cache browser.`
    });
    if (r.ok) { toast({ kind: 'success', title: 'Replacement rule created' }); onSaved(); }
    else setError(r.error.message);
    return r;
  });

  const pickFile = async () => {
    const r = await call('cache:import-file', { assetId: asset.assetId, path: '' });
    if (r.ok) toast({ kind: 'success', title: 'File imported into the cache' });
    else if (r.error.code !== 'cancelled') setError(r.error.message);
  };

  return (
    <Modal
      title={`Replace ${asset.assetId}`}
      description="Adds a rule to one of your rule sets. It applies while a profile that includes that set is running."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            pending={save.pending}
            disabled={!setId || (action !== 'remove' && !target.trim())}
            onClick={() => void save.run()}
          >
            Create rule
          </Button>
        </>
      }
    >
      {!sets.data?.length ? (
        <Notice tone="warn" title="No rule sets yet">
          Create a rule set on the Assets page first — rules have to live in one.
        </Notice>
      ) : (
        <div className="col" style={{ gap: 'var(--s5)' }}>
          <Field label="Rule set">
            {() => (
              <Select
                ariaLabel="Rule set"
                value={setId}
                options={sets.data!.map((s) => ({ value: s.id, label: s.name }))}
                onChange={setSetId}
              />
            )}
          </Field>

          <Field label="Action">
            {() => (
              <Select
                ariaLabel="Action"
                value={action}
                options={[
                  { value: 'replace-asset', label: 'Replace with another asset' },
                  { value: 'replace-file', label: 'Replace with a local file' },
                  { value: 'remove', label: 'Remove entirely' }
                ]}
                onChange={(v) => setAction(v as typeof action)}
              />
            )}
          </Field>

          {action !== 'remove' ? (
            <Field
              label="Target"
              error={error}
              hint={action === 'replace-asset' ? 'A numeric asset id.' : 'A full path to a file on this machine.'}
            >
              {(id) => (
                <div className="flex" style={{ gap: 'var(--s2)' }}>
                  <input
                    id={id}
                    className="input mono"
                    style={{ flex: 1 }}
                    value={target}
                    spellCheck={false}
                    autoFocus
                    onChange={(e) => { setTarget(e.target.value); setError(null); }}
                  />
                  {action === 'replace-file' ? (
                    <Button onClick={() => void pickFile()} icon={<Icon.folder size={13} />}>Import…</Button>
                  ) : null}
                </div>
              )}
            </Field>
          ) : null}

          <Notice tone="info">
            If the replacement cannot be served, Blossom serves the original asset. A rule can never
            break the client.
          </Notice>
        </div>
      )}
    </Modal>
  );
}

function DuplicatesModal({ onClose }: { onClose: () => void }) {
  const duplicates = useQuery('cache:duplicates', undefined);

  return (
    <Modal
      title="Duplicate content"
      description="Assets whose bytes are identical. They already share one file on disk — this is what deduplication saved."
      onClose={onClose}
      width={620}
      footer={<Button variant="ghost" onClick={onClose}>Close</Button>}
    >
      <Async query={duplicates} empty={(list) => list.length === 0
        ? <Empty title="No duplicates">Every cached asset has unique content.</Empty>
        : null}>
        {(list) => (
          <table className="table">
            <thead><tr><th>Content</th><th className="num">Copies</th><th className="num">Size</th><th className="num">Saved</th></tr></thead>
            <tbody>
              {list.map((group) => (
                <tr key={group.hash}>
                  <td className="mono micro truncate">{group.assetIds.slice(0, 3).join(', ')}{group.assetIds.length > 3 ? ` +${group.assetIds.length - 3}` : ''}</td>
                  <td className="num">{count(group.assetIds.length)}</td>
                  <td className="num">{bytes(group.sizeBytes)}</td>
                  <td className="num" style={{ color: 'var(--ok)' }}>{bytes(group.sizeBytes * (group.assetIds.length - 1))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Async>
    </Modal>
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
