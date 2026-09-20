import { useEffect, useMemo, useState } from 'react';
import { call, on, useAction, useQuery } from '@renderer/lib/api';
import { benchmarkValue, bytes, count, dateTime, relative, time } from '@renderer/lib/format';
import { Icon } from '@renderer/components/icons';
import {
  Async, Badge, Button, Empty, Notice, Panel, Section, Segmented, Select, useToast
} from '@renderer/components/ui';
import { PageHead } from '@renderer/app/Shell';
import type { LogLevel, LogRecord } from '@shared/types';

const LEVEL_TONE: Record<LogLevel, string> = {
  trace: 'var(--text-3)', debug: 'var(--text-3)', info: 'var(--text-2)',
  warn: 'var(--warn)', error: 'var(--danger)', critical: 'var(--danger)'
};

const LEVELS: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'critical'];

/**
 * Diagnostics: a report the user can paste when asking for help, a live log,
 * and benchmarks that measure this machine rather than quoting figures.
 */
export function Diagnostics() {
  const toast = useToast();
  const [tab, setTab] = useState<'report' | 'logs' | 'benchmarks'>('report');

  return (
    <div className="page" style={{ maxWidth: 1180 }}>
      <PageHead eyebrow="Support" title="Diagnostics">
        Everything you need to describe a problem accurately. Reports have usernames, join tickets and
        auth cookies stripped out before they can be copied.
      </PageHead>

      <div className="mb">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'report', label: 'Report' },
            { value: 'logs', label: 'Log' },
            { value: 'benchmarks', label: 'Benchmarks' }
          ]}
        />
      </div>

      {tab === 'report' ? <Report toast={toast} /> : null}
      {tab === 'logs' ? <Logs /> : null}
      {tab === 'benchmarks' ? <Benchmarks /> : null}
    </div>
  );
}

function Report({ toast }: { toast: ReturnType<typeof useToast> }) {
  const report = useQuery('diagnostics:report', undefined);

  const save = useAction(async () => {
    const r = await call('diagnostics:save', {});
    if (r.ok) toast({ kind: 'success', title: 'Report saved', message: r.value.path });
    else if (r.error.code !== 'cancelled') toast({ kind: 'error', title: 'Could not save', message: r.error.message });
    return r;
  });

  const copy = async () => {
    if (!report.data) return;
    await navigator.clipboard.writeText(renderReport(report.data));
    toast({ kind: 'success', title: 'Report copied to the clipboard' });
  };

  return (
    <Async query={report}>
      {(data) => (
        <>
          <div className="btn-row mb">
            <Button variant="primary" icon={<Icon.copy size={13} />} onClick={() => void copy()}>Copy report</Button>
            <Button icon={<Icon.download size={13} />} onClick={() => void save.run()} pending={save.pending}>Save report</Button>
            <Button variant="ghost" icon={<Icon.refresh size={13} />} onClick={report.refetch}>Refresh</Button>
            <Button variant="ghost" icon={<Icon.folder size={13} />} onClick={() => void call('app:open-path', { target: 'logs' })}>
              Open the log folder
            </Button>
          </div>

          {!data.hardwareIncluded ? (
            <div className="mb">
              <Notice tone="info">
                Hardware details are excluded from this report by your settings. Turn them on under
                Settings → Diagnostics if someone helping you needs them.
              </Notice>
            </div>
          ) : null}

          <div className="grid-2">
            <Panel head={<h3>Blossom Strap</h3>}>
              <dl className="kv">
                <dt>Version</dt><dd className="mono">{data.blossom.version}</dd>
                <dt>Channel</dt><dd>{data.blossom.channel}</dd>
                <dt>Electron</dt><dd className="mono">{data.blossom.electron}</dd>
                <dt>Node</dt><dd className="mono">{data.blossom.node}</dd>
                <dt>Chromium</dt><dd className="mono">{data.blossom.chrome}</dd>
              </dl>
            </Panel>

            <Panel head={<h3>System</h3>}>
              <dl className="kv">
                <dt>OS</dt><dd>{data.system.os} {data.system.version}</dd>
                <dt>Architecture</dt><dd>{data.system.arch}</dd>
                <dt>CPU</dt><dd className="truncate">{data.system.cpu}</dd>
                <dt>Memory</dt><dd className="num">{data.system.memoryBytes ? bytes(data.system.memoryBytes) : 'hidden'}</dd>
              </dl>
            </Panel>

            <Panel head={<h3>Roblox</h3>}>
              <dl className="kv">
                <dt>Active</dt><dd className="mono">{data.roblox.active ?? 'not detected'}</dd>
                <dt>Latest known</dt><dd className="mono">{data.roblox.latestKnown ?? 'unknown'}</dd>
                <dt>Running</dt><dd className="num">{count(data.roblox.running)}</dd>
                <dt>Installs</dt><dd className="num">{count(data.roblox.installations.length)}</dd>
              </dl>
              {data.roblox.installations.length ? (
                <div className="mono micro dim mt">
                  {data.roblox.installations.map((i) => (
                    <div key={`${i.kind}-${i.guid}`} className="truncate">{i.kind} · {i.version ?? '—'} · {i.path}</div>
                  ))}
                </div>
              ) : null}
            </Panel>

            <Panel head={<h3>Configuration</h3>}>
              <dl className="kv">
                <dt>Profile</dt>
                <dd>
                  {data.profile
                    ? <span className="flex" style={{ gap: 'var(--s2)' }}>
                      {data.profile.name}
                      <Badge tone={data.profile.valid ? 'ok' : 'danger'}>
                        {data.profile.valid ? 'valid' : `${data.profile.issues} issue(s)`}
                      </Badge>
                    </span>
                    : 'none'}
                </dd>
                <dt>FastFlags</dt><dd className="num">{count(data.modifications.fastFlagCount)}</dd>
                <dt>Optimizer</dt><dd>{data.modifications.optimizerPreset}</dd>
                <dt>Asset rules</dt><dd className="num">{count(data.modifications.assetRuleCount)}</dd>
                <dt>Interception</dt>
                <dd>{data.interception.status}{data.interception.port ? ` · :${data.interception.port}` : ''}</dd>
                <dt>Certificate</dt>
                <dd>{data.interception.certificateInstalled ? 'installed in Roblox' : 'not installed'}</dd>
                <dt>Cache</dt>
                <dd className="num">{count(data.cache.assets)} assets · {bytes(data.cache.bytes)}</dd>
              </dl>
            </Panel>
          </div>

          {data.recentErrors.length ? (
            <Section title="Recent errors">
              <Panel flush>
                <table className="table">
                  <thead><tr><th>Time</th><th>Scope</th><th>Message</th></tr></thead>
                  <tbody>
                    {data.recentErrors.map((error, i) => (
                      <tr key={`${error.at}-${i}`}>
                        <td className="mono micro dim">{time(error.at)}</td>
                        <td className="dim">{error.scope}</td>
                        <td style={{ color: 'var(--danger)' }}>{error.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>
            </Section>
          ) : (
            <div className="mt">
              <Notice><strong style={{ color: 'var(--ok)' }}>No errors recorded this session.</strong></Notice>
            </div>
          )}

          <Section title="Report preview" hint="Exactly what Copy puts on the clipboard">
            <pre
              className="mono selectable"
              style={{
                margin: 0, padding: 'var(--s4)', maxHeight: 320, overflow: 'auto',
                borderRadius: 'var(--r)', border: '1px solid var(--line)',
                background: 'var(--surface-input)', fontSize: 'var(--t-micro)', lineHeight: 1.6
              }}
            >
              {renderReport(data)}
            </pre>
          </Section>
        </>
      )}
    </Async>
  );
}

function Logs() {
  const [level, setLevel] = useState<LogLevel>('info');
  const [records, setRecords] = useState<LogRecord[]>([]);
  const [follow, setFollow] = useState(true);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    void call('diagnostics:logs', { limit: 400, level }).then((r) => { if (r.ok) setRecords(r.value); });
  }, [level]);

  useEffect(() => on('log:record', (record) => {
    if (!follow) return;
    setRecords((current) => [...current, record].slice(-600));
  }), [follow]);

  const visible = useMemo(() => {
    const term = filter.trim().toLowerCase();
    const floor = LEVELS.indexOf(level);
    return records
      .filter((r) => LEVELS.indexOf(r.level) >= floor)
      .filter((r) => !term || r.message.toLowerCase().includes(term) || r.scope.includes(term))
      .slice(-400)
      .reverse();
  }, [records, filter, level]);

  return (
    <>
      <div className="flex mb" style={{ gap: 'var(--s2)' }}>
        <Select
          ariaLabel="Minimum level"
          value={level}
          options={LEVELS.map((l) => ({ value: l, label: l }))}
          onChange={setLevel}
        />
        <input
          className="input"
          style={{ width: 240 }}
          placeholder="Filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <Button onClick={() => setFollow((f) => !f)} icon={follow ? <Icon.pause size={13} /> : <Icon.play size={13} />}>
          {follow ? 'Pause' : 'Follow'}
        </Button>
        <span className="right micro dim num">{count(visible.length)} lines</span>
      </div>

      {visible.length === 0 ? (
        <Empty icon={<Icon.file size={22} />} title="Nothing logged at this level" />
      ) : (
        <Panel flush>
          <div style={{ maxHeight: 560, overflow: 'auto' }}>
            {visible.map((record, i) => (
              <div
                key={`${record.at}-${i}`}
                className="mono micro selectable"
                style={{
                  display: 'grid',
                  gridTemplateColumns: '64px 52px 100px 1fr',
                  gap: 'var(--s3)',
                  padding: '3px var(--s4)',
                  borderBottom: '1px solid var(--line)'
                }}
              >
                <span className="dim">{time(record.at)}</span>
                <span style={{ color: LEVEL_TONE[record.level], textTransform: 'uppercase' }}>{record.level}</span>
                <span className="dim truncate">{record.scope}</span>
                <span style={{ color: record.level === 'error' || record.level === 'critical' ? 'var(--danger)' : undefined }}>
                  {record.message}
                  {record.data ? (
                    <span className="dim">
                      {'  '}
                      {Object.entries(record.data).map(([k, v]) => `${k}=${String(v)}`).join(' ')}
                    </span>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        </Panel>
      )}
    </>
  );
}

function Benchmarks() {
  const existing = useQuery('diagnostics:benchmarks', undefined);
  const [results, setResults] = useState(existing.data ?? []);

  useEffect(() => { if (existing.data?.length) setResults(existing.data); }, [existing.data]);

  const run = useAction(async (id: 'all' | 'startup' | 'memory' | 'asset-loading' | 'configuration' | 'launch-time') => {
    const r = await call('diagnostics:benchmark', { id });
    if (r.ok) {
      setResults((current) => {
        const merged = [...current];
        for (const result of r.value) {
          const index = merged.findIndex((m) => m.id === result.id);
          if (index >= 0) merged[index] = result;
          else merged.push(result);
        }
        return merged;
      });
    }
    return r;
  });

  return (
    <>
      <div className="mb">
        <Notice tone="info">
          These measure this machine right now. Blossom quotes no performance figures anywhere else in
          the interface, because a number that was not measured on your hardware is a guess.
        </Notice>
      </div>

      <div className="btn-row mb">
        <Button variant="primary" onClick={() => void run.run('all')} pending={run.pending} icon={<Icon.activity size={13} />}>
          Run all
        </Button>
        <Button onClick={() => void run.run('asset-loading')} pending={run.pending}>Asset loading</Button>
        <Button onClick={() => void run.run('memory')} pending={run.pending}>Memory</Button>
        <Button onClick={() => void run.run('configuration')} pending={run.pending}>Configuration</Button>
        <Button onClick={() => void run.run('startup')} pending={run.pending}>Startup</Button>
        <Button onClick={() => void run.run('launch-time')} pending={run.pending}>Launch time</Button>
      </div>

      {results.length === 0 ? (
        <Empty icon={<Icon.gauge size={22} />} title="No measurements yet"
          action={<Button variant="primary" onClick={() => void run.run('all')}>Run all benchmarks</Button>}>
          Benchmarks write a temporary file to the same volume the cache lives on, read it back, and hash it.
        </Empty>
      ) : (
        <Panel flush>
          <table className="table">
            <thead><tr><th>Benchmark</th><th className="num">Result</th><th className="num">Samples</th><th>What it measures</th><th>Ran</th></tr></thead>
            <tbody>
              {results.map((result) => (
                <tr key={result.id}>
                  <td>{result.name}</td>
                  <td className="num" style={{ color: result.value < 0 ? 'var(--text-3)' : 'var(--accent)' }}>
                    {benchmarkValue(result.value, result.unit)}
                  </td>
                  <td className="num dim">{result.samples || '—'}</td>
                  <td className="dim small" style={{ whiteSpace: 'normal' }}>{result.detail}</td>
                  <td className="dim" title={dateTime(result.ranAt)}>{relative(result.ranAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </>
  );
}

/** Mirrors the main-process renderer so the preview is the copied text. */
function renderReport(report: import('@shared/types').DiagnosticsReport): string {
  const lines: string[] = [];
  const push = (label: string, value: unknown) => lines.push(`${label.padEnd(22)}${String(value)}`);

  lines.push('Blossom Strap — diagnostics report', new Date(report.generatedAt).toISOString(), '');
  lines.push('APPLICATION');
  push('Version', `${report.blossom.version} (${report.blossom.channel})`);
  push('Electron', report.blossom.electron);
  push('Node', report.blossom.node);
  push('Chromium', report.blossom.chrome);
  lines.push('', 'SYSTEM');
  push('OS', `${report.system.os} ${report.system.version}`);
  push('Architecture', report.system.arch);
  if (report.hardwareIncluded) {
    push('CPU', report.system.cpu);
    push('Memory', `${(report.system.memoryBytes / 1024 ** 3).toFixed(1)} GB`);
  } else {
    push('Hardware', 'excluded by the user');
  }
  lines.push('', 'ROBLOX');
  push('Active', report.roblox.active ?? 'not detected');
  push('Running clients', report.roblox.running);
  push('Latest known', report.roblox.latestKnown ?? 'unknown');
  for (const install of report.roblox.installations) {
    lines.push(`  ${install.kind.padEnd(7)} ${(install.version ?? 'unknown').padEnd(18)} ${install.guid}`);
    lines.push(`          ${install.path}`);
  }
  lines.push('', 'PROFILE');
  if (report.profile) {
    push('Name', `${report.profile.name} (${report.profile.id})`);
    push('Valid', report.profile.valid ? 'yes' : `no — ${report.profile.issues} issue(s)`);
  } else {
    push('Name', 'none');
  }
  lines.push('', 'MODIFICATIONS');
  push('FastFlags', report.modifications.fastFlagCount);
  push('Optimizer preset', report.modifications.optimizerPreset);
  push('Applied actions', report.modifications.appliedActions);
  push('Mod files', report.modifications.modFileCount);
  push('Asset rules', report.modifications.assetRuleCount);
  lines.push('', 'INTERCEPTION');
  push('Status', report.interception.status);
  push('Port', report.interception.port ?? 'not listening');
  push('Certificate', report.interception.certificateInstalled ? 'installed in Roblox' : 'not installed');
  lines.push('', 'CACHE');
  push('Assets', report.cache.assets);
  push('Size', `${(report.cache.bytes / 1024 ** 2).toFixed(1)} MB`);
  lines.push('');
  if (report.recentErrors.length) {
    lines.push('RECENT ERRORS');
    for (const error of report.recentErrors) {
      lines.push(`  [${new Date(error.at).toISOString()}] ${error.scope}: ${error.message}`);
    }
    lines.push('');
  }
  lines.push('LOG');
  for (const line of report.log) lines.push(`  ${line}`);
  return lines.join('\n');
}
