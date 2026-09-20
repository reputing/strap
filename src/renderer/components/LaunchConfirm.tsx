import { call, useQuery } from '@renderer/lib/api';
import { count } from '@renderer/lib/format';
import { Async, Badge, Button, Modal, Notice } from '@renderer/components/ui';
import type { LaunchRequest } from '@shared/types';

/**
 * Shown before a launch when "Confirm before launching" is on.
 *
 * It lists what will be applied and which files will be written, because the
 * point of the setting is knowing before it happens, not being asked twice.
 */
export function LaunchConfirm({
  request, onConfirm, onClose, pending
}: { request: LaunchRequest; onConfirm: () => void; onClose: () => void; pending: boolean }) {
  const preview = useQuery('launch:preview', request, { deps: [JSON.stringify(request)] });

  return (
    <Modal
      title="Launch Roblox"
      description="What Blossom will apply to this session."
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={onConfirm} pending={pending}>Launch</Button>
        </>
      }
    >
      <Async query={preview}>
        {(data) => (
          <div className="col" style={{ gap: 'var(--s5)' }}>
            <dl className="kv">
              <dt>Profile</dt><dd>{data.profileName}</dd>
              <dt>Client</dt><dd className="mono">{data.clientVersion ?? 'not detected'}</dd>
              <dt>FastFlags</dt><dd className="num">{count(data.fastFlagCount)}</dd>
              <dt>Client mods</dt><dd className="num">{count(data.modFileCount)}</dd>
              <dt>Asset rules</dt><dd className="num">{count(data.assetRuleCount)}</dd>
              <dt>Process priority</dt><dd>{data.priority}</dd>
              <dt>Extras</dt>
              <dd className="flex wrap" style={{ gap: 'var(--s2)' }}>
                {data.interception ? <Badge tone="accent">interception</Badge> : null}
                {data.capture ? <Badge tone="accent">capture</Badge> : null}
                {data.overlays.map((o) => <Badge key={o} tone="accent">{o}</Badge>)}
                {!data.interception && !data.capture && !data.overlays.length
                  ? <span className="dim small">none</span> : null}
              </dd>
            </dl>

            {data.filesTouched.length ? (
              <Notice title="Files Blossom will write">
                <div className="mono micro dim" style={{ marginTop: 4 }}>
                  {data.filesTouched.map((path) => <div key={path} className="truncate">{path}</div>)}
                </div>
                <p className="micro" style={{ marginTop: 6 }}>
                  Each one is backed up first, and restored when Roblox exits if your profile asks for that.
                </p>
              </Notice>
            ) : null}
          </div>
        )}
      </Async>
    </Modal>
  );
}

/** Reads the setting and either confirms or launches straight away. */
export async function launchWithConfirmation(
  request: LaunchRequest,
  confirmBeforeLaunch: boolean,
  showConfirm: () => void
): Promise<ReturnType<typeof call<'launch:start'>> | null> {
  if (confirmBeforeLaunch) {
    showConfirm();
    return null;
  }
  return call('launch:start', request);
}
