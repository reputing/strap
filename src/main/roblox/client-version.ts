import { request } from 'node:https';
import { Err, Ok, type Result } from '@shared/result';
import type { RobloxChannel } from '@shared/types';

export interface ClientVersionInfo {
  channel: RobloxChannel;
  /** Marketing version, e.g. "0.678.1.6780512". */
  clientVersion: string;
  /** Version GUID the installation directory is named after. */
  versionGuid: string;
  bootstrapperVersion: string | null;
  fetchedAt: number;
}

const HOST = 'clientsettingscdn.roblox.com';

/**
 * Asks Roblox which client version is current for a channel.
 *
 * This is a read-only public endpoint. Blossom sends no credentials with it and
 * treats failure as "unknown" rather than an error the user must act on: being
 * offline is a normal state for a launcher, not a fault.
 */
export async function fetchLatestClientVersion(
  kind: 'player' | 'studio' = 'player',
  channel: RobloxChannel = 'LIVE',
  timeoutMs = 8000
): Promise<Result<ClientVersionInfo>> {
  const binary = kind === 'studio' ? 'WindowsStudio64' : 'WindowsPlayer';
  const path =
    channel && channel !== 'LIVE'
      ? `/v2/client-version/${binary}/channel/${encodeURIComponent(channel)}`
      : `/v2/client-version/${binary}`;

  const body = await httpsGetJson(HOST, path, timeoutMs);
  if (!body.ok) return body;

  const raw = body.value as Record<string, unknown>;
  const clientVersion = typeof raw['version'] === 'string' ? raw['version'] : null;
  const versionGuid = typeof raw['clientVersionUpload'] === 'string' ? raw['clientVersionUpload'] : null;

  if (!clientVersion || !versionGuid) {
    return Err('parse-failure', 'Roblox returned a client version in an unexpected shape.', {
      details: { keys: Object.keys(raw).slice(0, 10) }
    });
  }

  return Ok({
    channel,
    clientVersion,
    versionGuid,
    bootstrapperVersion: typeof raw['bootstrapperVersion'] === 'string' ? raw['bootstrapperVersion'] : null,
    fetchedAt: Date.now()
  });
}

function httpsGetJson(host: string, path: string, timeoutMs: number): Promise<Result<unknown>> {
  return new Promise((resolve) => {
    const req = request(
      { host, path, method: 'GET', headers: { accept: 'application/json', 'user-agent': 'BlossomStrap' } },
      (res) => {
        const status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('data', (c: Buffer) => {
          bytes += c.length;
          // A version document is tiny; refuse anything that is not.
          if (bytes > 256 * 1024) {
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          if (status < 200 || status >= 300) {
            resolve(Err('network-failure', `Roblox replied with HTTP ${status}.`));
            return;
          }
          try {
            resolve(Ok(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
          } catch {
            resolve(Err('parse-failure', 'Roblox returned a response Blossom could not read.'));
          }
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(Err('timeout', 'Roblox did not respond in time.'));
    });
    req.on('error', (e) => {
      resolve(Err('network-failure', 'Blossom could not reach Roblox.', { details: { reason: e.message } }));
    });
    req.end();
  });
}
