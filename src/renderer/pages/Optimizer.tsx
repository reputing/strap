import { useEffect, useMemo, useState } from 'react';
import { call, useAction, useQuery } from '@renderer/lib/api';
import { bytes, count } from '@renderer/lib/format';
import { Icon } from '@renderer/components/icons';
import {
  Async, Badge, Button, Confirm, Modal, Notice, Panel, Section, Segmented, Toggle, useToast
} from '@renderer/components/ui';
import { PageHead, presetLabel, type ShellState } from '@renderer/app/Shell';
import type { OptimizationAction, OptimizationPlan, PresetId, RiskLevel } from '@shared/types';

const PRESETS: { value: PresetId; label: string; blurb: string }[] = [
  { value: 'conservative', label: 'Conservative', blurb: 'Only safe, reversible changes. Nothing that alters how the game looks.' },
  { value: 'balanced', label: 'Balanced', blurb: 'Removes the frame ceiling and the cheapest visual overheads.' },
  { value: 'performance', label: 'Performance', blurb: 'Prioritises frame consistency. Accepts visible quality loss.' },
  { value: 'low-end', label: 'Low End', blurb: 'Cuts resource use hard for limited RAM or an integrated GPU.' },
  { value: 'custom', label: 'Custom', blurb: 'Nothing is selected until you choose it.' }
];

const RISK_TONE: Record<RiskLevel, 'ok' | 'default' | 'warn' | 'danger'> = {
  safe: 'ok', low: 'default', moderate: 'warn', advanced: 'danger'
};

const CATEGORY_LABEL: Record<string, string> = {
  rendering: 'Rendering', scheduler: 'Frame scheduling', memory: 'Memory and assets',
  network: 'Network', input: 'Input', ui: 'Interface', system: 'System'
};

/**
 * The optimizer page shows a plan before it is applied. Nothing here is a
 * promise: each action states its mechanism and its expected effect, and the
 * ones the machine cannot use are listed with the reason.
 */
export function Optimizer({ shell }: { shell: ShellState }) {
  const toast = useToast();
  const catalog = useQuery('optimizer:catalog', undefined);
  const hardware = useQuery('optimizer:hardware', {});
  const recommendation = useQuery('optimizer:recommend', undefined);

  const profile = shell.profile;
  const [preset, setPreset] = useState<PresetId>('balanced');
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [plan, setPlan] = useState<OptimizationPlan | null>(null);
  const [showPlan, setShowPlan] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  // Follow the active profile, but do not clobber an edit in progress.
  useEffect(() => {
    if (!profile) return;
    setPreset(profile.optimizer.preset);
    setOverrides(profile.optimizer.overrides);
  }, [profile?.id, profile?.optimizer.preset]);

  useEffect(() => {
    let cancelled = false;
    void call('optimizer:plan', { preset, overrides }).then((r) => {
      if (!cancelled && r.ok) setPlan(r.value);
    });
    return () => { cancelled = true; };
  }, [preset, overrides, profile?.id]);

  const apply = useAction(async () => {
    const result = await call('optimizer:apply', { preset, overrides });
    if (result.ok) {
      setShowPlan(false);
      toast({
        kind: 'success',
        title: `${presetLabel(preset)} applied`,
        message: `${count(plan?.actions.length ?? 0)} optimizations written to your profile. Undo is available.`
      });
    } else {
      toast({ kind: 'error', title: 'Could not apply', message: result.error.message });
    }
    return result;
  });

  const undo = useAction(async () => {
    const result = await call('optimizer:undo', undefined);
    if (result.ok) toast({ kind: 'success', title: 'Optimizations undone' });
    else toast({ kind: 'warning', title: 'Nothing to undo', message: result.error.message });
    return result;
  });

  const reset = useAction(async () => {
    const result = await call('optimizer:reset-defaults', undefined);
    setConfirmReset(false);
    if (result.ok) {
      toast({
        kind: 'success',
        title: 'Reset to Roblox defaults',
        message: 'Every flag the optimizer can set was removed. Flags you added by hand were kept.'
      });
    }
    return result;
  });

  const selected = useMemo(() => new Set(plan?.actions.map((a) => a.id) ?? []), [plan]);
  const skippedById = useMemo(
    () => new Map((plan?.skipped ?? []).map((s) => [s.actionId, s.reason])),
    [plan]
  );

  const grouped = useMemo(() => {
    const groups = new Map<string, OptimizationAction[]>();
    for (const action of catalog.data ?? []) {
      const list = groups.get(action.category) ?? [];
      list.push(action);
      groups.set(action.category, list);
    }
    return [...groups.entries()];
  }, [catalog.data]);

  return (
    <div className="page">
      <PageHead
        eyebrow="Optimizer"
        title="Optimizer"
        actions={
          <>
            <Button icon={<Icon.undo size={13} />} onClick={() => void undo.run()} pending={undo.pending}>Undo</Button>
            <Button variant="danger" onClick={() => setConfirmReset(true)}>Reset to Roblox defaults</Button>
            <Button variant="primary" icon={<Icon.check size={13} />} onClick={() => setShowPlan(true)} disabled={!plan}>
              Review and apply
            </Button>
          </>
        }
      >
        Each optimization names the mechanism it uses and what to expect from it. None of them claim a
        frame rate number — run the benchmarks in Diagnostics if you want measurements from this machine.
      </PageHead>

      <Section title="This machine">
        <Async query={hardware}>
          {(hw) => (
            <Panel>
              <div className="flex between wrap" style={{ gap: 'var(--s6)' }}>
                <dl className="kv" style={{ flex: 1, minWidth: 260 }}>
                  <dt>CPU</dt><dd className="truncate">{hw.cpu.model}</dd>
                  <dt>Cores</dt><dd className="num">{hw.cpu.cores} physical · {hw.cpu.threads} logical</dd>
                  <dt>Memory</dt><dd className="num">{bytes(hw.memory.totalBytes)}</dd>
                  <dt>GPU</dt>
                  <dd className="truncate">{hw.gpu[0]?.model ?? 'not reported'}</dd>
                  <dt>Windows</dt><dd>{hw.os.name} {hw.os.build ? `build ${hw.os.build}` : ''}</dd>
                  <dt>Tier</dt><dd><Badge tone={hw.tier === 'high' ? 'ok' : hw.tier === 'low' ? 'warn' : 'default'}>{hw.tier}</Badge></dd>
                </dl>
                {recommendation.data ? (
                  <div style={{ maxWidth: 320 }}>
                    <div className="micro dim" style={{ textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
                      Recommended
                    </div>
                    <div className="flex" style={{ gap: 'var(--s3)', marginBottom: 'var(--s2)' }}>
                      <strong>{presetLabel(recommendation.data.preset)}</strong>
                      <Button variant="ghost" onClick={() => setPreset(recommendation.data!.preset)}>Use it</Button>
                    </div>
                    <p className="small dim">{recommendation.data.reason}</p>
                  </div>
                ) : null}
              </div>
            </Panel>
          )}
        </Async>
        {hardware.error ? (
          <div className="mt">
            <Notice tone="warn" title="Hardware details are unavailable">
              {hardware.error.message} Options that depend on knowing your hardware will be skipped rather
              than applied blind.
            </Notice>
          </div>
        ) : null}
      </Section>

      <Section title="Preset" hint={PRESETS.find((p) => p.value === preset)?.blurb}>
        <Segmented
          value={preset}
          onChange={(value) => { setPreset(value); setOverrides({}); }}
          options={PRESETS.map((p) => ({ value: p.value, label: p.label }))}
        />
        {plan ? (
          <div className="flex mt" style={{ gap: 'var(--s4)' }}>
            <Badge tone="accent">{count(plan.actions.length)} selected</Badge>
            <Badge>{count(plan.changes.filter((c) => c.nextValue !== null).length)} changes</Badge>
            {plan.skipped.length ? <Badge tone="warn">{count(plan.skipped.length)} skipped</Badge> : null}
          </div>
        ) : null}
      </Section>

      <Async query={catalog}>
        {() => (
          <>
            {grouped.map(([category, actions]) => (
              <Section key={category} title={CATEGORY_LABEL[category] ?? category}>
                <Panel>
                  <div className="rows">
                    {actions.map((action) => {
                      const skipped = skippedById.get(action.id);
                      const on = selected.has(action.id);
                      return (
                        <div className="row" key={action.id}>
                          <div className="label">
                            <div className="name">
                              {action.title}
                              <Badge tone={RISK_TONE[action.risk]}>{action.risk}</Badge>
                              <Badge>{action.mechanism}</Badge>
                              {!action.reversible ? <Badge tone="danger">not reversible</Badge> : null}
                            </div>
                            <div className="desc">{action.description}</div>
                            <div className="desc" style={{ color: 'var(--text-2)', marginTop: 4 }}>
                              <strong style={{ fontWeight: 500 }}>Expect: </strong>{action.expectedEffect}
                            </div>
                            {action.compatibility ? (
                              <div className="desc" style={{ marginTop: 4 }}>{action.compatibility}</div>
                            ) : null}
                            {skipped ? (
                              <div className="desc" style={{ color: 'var(--warn)', marginTop: 4 }}>
                                Skipped on this machine: {skipped}
                              </div>
                            ) : null}
                            {action.flags ? (
                              <div className="micro mono dim" style={{ marginTop: 6 }}>
                                {Object.entries(action.flags).map(([k, v]) => `${k} = ${v}`).join('   ')}
                              </div>
                            ) : null}
                          </div>
                          <div className="control">
                            <Toggle
                              label={action.title}
                              checked={on}
                              disabled={Boolean(skipped)}
                              onChange={(value) => {
                                setOverrides((current) => ({ ...current, [action.id]: value }));
                                if (preset !== 'custom') setPreset('custom');
                              }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </Panel>
              </Section>
            ))}
          </>
        )}
      </Async>

      {showPlan && plan ? (
        <PlanModal
          plan={plan}
          pending={apply.pending}
          onApply={() => void apply.run()}
          onClose={() => setShowPlan(false)}
        />
      ) : null}

      {confirmReset ? (
        <Confirm
          title="Reset to Roblox defaults"
          confirmLabel="Reset"
          danger
          pending={reset.pending}
          onConfirm={() => void reset.run()}
          onClose={() => setConfirmReset(false)}
          description={
            <>
              This removes every flag the optimizer is capable of setting from your active profile, and
              returns the process priority to normal. Flags you added yourself in the FastFlags editor are
              kept. Blossom does not write Roblox's own default values — it removes the overrides so
              Roblox uses whatever it ships with.
            </>
          }
        />
      ) : null}
    </div>
  );
}

function PlanModal({
  plan, onApply, onClose, pending
}: { plan: OptimizationPlan; onApply: () => void; onClose: () => void; pending: boolean }) {
  const additions = plan.changes.filter((c) => c.nextValue !== null);
  const removals = plan.changes.filter((c) => c.nextValue === null);

  return (
    <Modal
      title={`Apply ${presetLabel(plan.preset)}`}
      description="Exactly what will change. Nothing is written until you confirm."
      onClose={onClose}
      width={640}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={onApply} pending={pending}>
            Apply {additions.length + removals.length} change{additions.length + removals.length === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      {additions.length === 0 && removals.length === 0 ? (
        <p className="small dim">This preset makes no changes to your current configuration.</p>
      ) : null}

      {additions.length ? (
        <>
          <div className="micro dim mb" style={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}>Set</div>
          <div className="diff panel flush mb">
            {additions.map((change) => (
              <div className={`diff-row ${change.currentValue === null ? 'added' : ''}`} key={`${change.mechanism}-${change.key}`}>
                <span className="name">{change.key}</span>
                <span className="from">{change.currentValue ?? 'not set'}</span>
                <span className="to">{change.nextValue}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}

      {removals.length ? (
        <>
          <div className="micro dim mb" style={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}>Remove</div>
          <div className="diff panel flush mb">
            {removals.map((change) => (
              <div className="diff-row removed" key={`rm-${change.key}`}>
                <span className="name">{change.key}</span>
                <span className="from">{change.currentValue}</span>
                <span className="to">removed</span>
              </div>
            ))}
          </div>
        </>
      ) : null}

      {plan.skipped.length ? (
        <Notice tone="warn" title={`${plan.skipped.length} option${plan.skipped.length === 1 ? '' : 's'} skipped`}>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {plan.skipped.map((s) => <li key={s.actionId}>{s.reason}</li>)}
          </ul>
        </Notice>
      ) : null}

      <div className="mt">
        <Notice tone="info">
          These values are written into your profile, not straight into Roblox. They are applied to the
          client at launch, after Blossom has backed up the file it is about to change.
        </Notice>
      </div>
    </Modal>
  );
}
