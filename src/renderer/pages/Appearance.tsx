import { useEffect, useState } from 'react';
import { call, useQuery } from '@renderer/lib/api';
import { Icon } from '@renderer/components/icons';
import {
  Badge, Button, Notice, Panel, Row, Section, Segmented, Select, Toggle, useToast
} from '@renderer/components/ui';
import { PageHead, type ShellState } from '@renderer/app/Shell';
import { CrosshairSvg } from '@renderer/components/CrosshairSvg';
import type { AppearanceConfig, CrosshairConfig, HudConfig, Profile } from '@shared/types';

const ACCENTS: { value: AppearanceConfig['accent']; label: string; swatch: string }[] = [
  { value: 'blossom', label: 'Blossom', swatch: '#ff6fa8' },
  { value: 'violet', label: 'Violet', swatch: '#a97bff' },
  { value: 'rose', label: 'Rose', swatch: '#ff7b7b' },
  { value: 'mint', label: 'Mint', swatch: '#4fd6b0' },
  { value: 'amber', label: 'Amber', swatch: '#f0b354' }
];

const CROSSHAIR_STYLES: CrosshairConfig['style'][] = ['cross', 'dot', 'cross-dot', 'circle', 't-shape'];

/**
 * Appearance covers both Blossom's own theme and the overlays it draws over the
 * client. The crosshair designer renders with the same geometry the overlay
 * window uses, so the preview is the thing, not an approximation of it.
 */
export function Appearance({ shell }: { shell: ShellState }) {
  const toast = useToast();
  const profile = shell.profile;
  const overlay = useQuery('overlay:state', undefined);
  const [previewing, setPreviewing] = useState(false);

  // A preview left running when the page closes would sit on top of everything.
  useEffect(() => () => { void call('overlay:preview', { enabled: false }); }, []);

  const patch = async (changes: Partial<Profile>) => {
    if (!profile) return;
    const r = await call('profiles:update', { id: profile.id, patch: changes });
    if (!r.ok) toast({ kind: 'error', title: 'Could not save', message: r.error.message });
  };

  const setCrosshair = (changes: Partial<CrosshairConfig>) => {
    if (!profile) return;
    void patch({ overlay: { ...profile.overlay, crosshair: { ...profile.overlay.crosshair, ...changes } } });
  };

  const setHud = (changes: Partial<HudConfig>) => {
    if (!profile) return;
    void patch({ overlay: { ...profile.overlay, hud: { ...profile.overlay.hud, ...changes } } });
  };

  if (!profile) return <div className="page"><PageHead title="Appearance" /></div>;

  const crosshair = profile.overlay.crosshair;
  const hud = profile.overlay.hud;

  return (
    <div className="page">
      <PageHead eyebrow="Interface" title="Appearance">
        Blossom's own theme, and the overlays it draws over the Roblox window.
      </PageHead>

      <Section title="Theme">
        <Panel>
          <div className="rows">
            <Row name="Accent" desc="Used for state and emphasis, never as decoration.">
              <div className="flex" style={{ gap: 'var(--s2)' }}>
                {ACCENTS.map((accent) => (
                  <button
                    key={accent.value}
                    className="btn"
                    title={accent.label}
                    aria-pressed={profile.appearance.accent === accent.value}
                    onClick={() => void patch({ appearance: { ...profile.appearance, accent: accent.value } })}
                    style={{
                      width: 28, padding: 0,
                      borderColor: profile.appearance.accent === accent.value ? accent.swatch : undefined
                    }}
                  >
                    <span style={{ width: 12, height: 12, borderRadius: 3, background: accent.swatch, display: 'block' }} />
                  </button>
                ))}
              </div>
            </Row>
            <Row name="Density" desc="Compact tightens rows and padding without shrinking the text.">
              <Segmented
                value={profile.appearance.density}
                onChange={(density) => void patch({ appearance: { ...profile.appearance, density } })}
                options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]}
              />
            </Row>
            <Row name="Reduce motion" desc="Removes transitions and animations throughout the interface.">
              <Toggle
                label="Reduce motion"
                checked={profile.appearance.reduceMotion}
                onChange={(reduceMotion) => void patch({ appearance: { ...profile.appearance, reduceMotion } })}
              />
            </Row>
          </div>
        </Panel>
      </Section>

      <Section
        title="Crosshair"
        hint="Drawn over the client in a separate window"
        actions={
          <Button
            onClick={() => {
              const next = !previewing;
              setPreviewing(next);
              void call('overlay:preview', { enabled: next });
            }}
            icon={<Icon.eye size={13} />}
          >
            {previewing ? 'Stop preview' : 'Preview on screen'}
          </Button>
        }
      >
        {!overlay.data?.supported ? (
          <div className="mb">
            <Notice tone="warn" title="Overlays are unavailable">
              {overlay.data?.detail ?? 'Overlays need the Windows helper.'}
            </Notice>
          </div>
        ) : null}

        <div className="flex" style={{ alignItems: 'flex-start', gap: 'var(--s5)' }}>
          <Panel>
            <div style={{ width: 240 }}>
              <div
                style={{
                  height: 200,
                  borderRadius: 'var(--r)',
                  border: '1px solid var(--line)',
                  background: 'repeating-conic-gradient(#1c1b24 0% 25%, #16151d 0% 50%) 50% / 20px 20px',
                  display: 'grid',
                  placeItems: 'center'
                }}
              >
                <CrosshairSvg config={crosshair} />
              </div>
              <p className="micro dim mt">
                Rendered with the same geometry the overlay window uses.
              </p>
            </div>
          </Panel>

          <div style={{ flex: 1, minWidth: 0 }}>
            <Panel>
              <div className="rows">
                <Row name="Show the crosshair">
                  <Toggle label="Crosshair" checked={crosshair.enabled} onChange={(enabled) => setCrosshair({ enabled })} />
                </Row>
                <Row name="Style">
                  <Select
                    ariaLabel="Crosshair style"
                    value={crosshair.style}
                    options={CROSSHAIR_STYLES.map((s) => ({ value: s, label: s.replace('-', ' ') }))}
                    onChange={(style) => setCrosshair({ style })}
                  />
                </Row>
                <Row name="Colour">
                  <div className="flex" style={{ gap: 'var(--s2)' }}>
                    <input
                      type="color"
                      className="color-input"
                      value={crosshair.color}
                      aria-label="Crosshair colour"
                      onChange={(e) => setCrosshair({ color: e.target.value })}
                    />
                    <code className="mono micro dim">{crosshair.color}</code>
                  </div>
                </Row>
                <NumberRow label="Size" value={crosshair.size} min={1} max={60} onChange={(size) => setCrosshair({ size })} />
                <NumberRow label="Thickness" value={crosshair.thickness} min={1} max={10} onChange={(thickness) => setCrosshair({ thickness })} />
                <NumberRow label="Centre gap" value={crosshair.gap} min={0} max={30} onChange={(gap) => setCrosshair({ gap })} />
                <NumberRow label="Opacity" value={Math.round(crosshair.opacity * 100)} min={5} max={100} onChange={(v) => setCrosshair({ opacity: v / 100 })} />
                <Row name="Outline" desc="A dark edge keeps the crosshair readable on light backgrounds.">
                  <Toggle label="Outline" checked={crosshair.outline} onChange={(outline) => setCrosshair({ outline })} />
                </Row>
                <Row name="Offset" desc="Nudge away from the exact centre of the client window.">
                  <div className="flex" style={{ gap: 'var(--s2)' }}>
                    <input
                      className="input num" style={{ width: 64 }} type="number" aria-label="Horizontal offset"
                      value={crosshair.offsetX} onChange={(e) => setCrosshair({ offsetX: Number(e.target.value) || 0 })}
                    />
                    <input
                      className="input num" style={{ width: 64 }} type="number" aria-label="Vertical offset"
                      value={crosshair.offsetY} onChange={(e) => setCrosshair({ offsetY: Number(e.target.value) || 0 })}
                    />
                  </div>
                </Row>
              </div>
            </Panel>
          </div>
        </div>

        <div className="mt">
          <Notice tone="info">
            The crosshair is a separate transparent window sitting above the client — nothing is
            injected into the Roblox process. Windows composites it over borderless and windowed
            clients; an exclusive-fullscreen client will cover it.
          </Notice>
        </div>
      </Section>

      <Section title="Performance HUD" hint="Live figures over the client">
        <Panel>
          <div className="rows">
            <Row name="Show the HUD">
              <Toggle label="HUD" checked={hud.enabled} onChange={(enabled) => setHud({ enabled })} />
            </Row>
            <Row name="Corner">
              <Select
                ariaLabel="HUD corner"
                value={hud.corner}
                options={[
                  { value: 'top-left', label: 'Top left' },
                  { value: 'top-right', label: 'Top right' },
                  { value: 'bottom-left', label: 'Bottom left' },
                  { value: 'bottom-right', label: 'Bottom right' }
                ]}
                onChange={(corner) => setHud({ corner })}
              />
            </Row>
            <Row name="CPU"><Toggle label="CPU" checked={hud.showCpu} onChange={(showCpu) => setHud({ showCpu })} /></Row>
            <Row name="Memory"><Toggle label="Memory" checked={hud.showMemory} onChange={(showMemory) => setHud({ showMemory })} /></Row>
            <Row name="Uptime"><Toggle label="Uptime" checked={hud.showUptime} onChange={(showUptime) => setHud({ showUptime })} /></Row>
            <Row
              name={<span className="flex" style={{ gap: 'var(--s2)' }}>Frame rate <Badge tone="warn">unavailable</Badge></span>}
              desc="Blossom measures the client from outside the process. Reading its frame rate would mean reaching inside it, which Blossom does not do."
            >
              <Toggle label="Frame rate" checked={false} disabled onChange={() => undefined} />
            </Row>
            <Row
              name={<span className="flex" style={{ gap: 'var(--s2)' }}>Ping <Badge tone="warn">unavailable</Badge></span>}
              desc="The client's connection latency is not exposed to other processes."
            >
              <Toggle label="Ping" checked={false} disabled onChange={() => undefined} />
            </Row>
            <NumberRow label="Opacity" value={Math.round(hud.opacity * 100)} min={5} max={100} onChange={(v) => setHud({ opacity: v / 100 })} />
            <NumberRow label="Scale" value={Math.round(hud.scale * 100)} min={50} max={300} onChange={(v) => setHud({ scale: v / 100 })} />
          </div>
        </Panel>
      </Section>
    </div>
  );
}

function NumberRow({
  label, value, min, max, onChange
}: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <Row name={label}>
      <div className="flex" style={{ gap: 'var(--s3)' }}>
        <input
          className="slider"
          type="range"
          min={min}
          max={max}
          value={value}
          aria-label={label}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <span className="num micro dim" style={{ width: 32, textAlign: 'right' }}>{value}</span>
      </div>
    </Row>
  );
}
