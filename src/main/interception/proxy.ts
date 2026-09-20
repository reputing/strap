import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { once } from 'node:events';
import type { AssetRule, CaptureEvent, InterceptionState } from '@shared/types';
import { Err, Ok, type Result } from '@shared/result';
import type { ScopedLogger } from '@main/core/logger';
import type { CertificateAuthority } from './certificate-authority';
import { inScope, portFrom, stripPort } from './scope';
import { assetIdFromUrl, sniffAsset } from '@main/assets/asset-types';
import { resolve, type Resolution } from '@main/assets/resolver';

export interface ProxyHooks {
  /** Rules to evaluate, already sorted. Re-read per request so edits apply live. */
  rules(): AssetRule[];
  /** Bytes for a replacement that points at a cached asset id. */
  resolveAssetBytes(assetId: string): Promise<Buffer | null>;
  /** Bytes for a replacement that points at a local file. */
  readLocalFile(path: string): Promise<Buffer | null>;
  /** Called for every request the proxy handled. */
  onCapture(event: CaptureEvent, body: Buffer | null): void;
  /** True while response bodies should be cached. */
  shouldCache(): boolean;
}

/** Bodies larger than this are streamed straight through without buffering. */
const MAX_BUFFERED_BYTES = 48 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 30_000;

/**
 * The local asset proxy.
 *
 * Bound to loopback only, on an ephemeral port, and reached by the Roblox
 * process because the launcher puts the proxy variables in *that process's*
 * environment. Nothing else on the machine is redirected: no hosts file, no
 * system proxy setting, no WinINET change.
 *
 * Two paths through a CONNECT:
 *
 *   in scope     → terminate TLS with a locally minted leaf, read the request,
 *                  apply rules, forward or replace.
 *   out of scope → `net.connect` and pipe the raw bytes. Blossom sees the
 *                  hostname it was asked to reach and nothing else.
 *
 * Every failure path ends in the original upstream response. A rule that is
 * broken, a blob that is missing, a disk that is full — none of them may turn
 * into a failed asset load in the client.
 */
export class InterceptionProxy extends EventEmitter {
  private server: http.Server | null = null;
  private port: number | null = null;
  private startedAt: number | null = null;
  private readonly sockets = new Set<net.Socket>();
  private stats: InterceptionState['stats'] = emptyStats();
  private overheadTotal = 0;
  private overheadCount = 0;

  constructor(
    private readonly ca: CertificateAuthority,
    private readonly hooks: ProxyHooks,
    private readonly log: ScopedLogger
  ) {
    super();
  }

  get boundPort(): number | null {
    return this.port;
  }

  get running(): boolean {
    return this.server !== null;
  }

  get since(): number | null {
    return this.startedAt;
  }

  snapshotStats(): InterceptionState['stats'] {
    return {
      ...this.stats,
      meanOverheadMs: this.overheadCount ? Math.round((this.overheadTotal / this.overheadCount) * 100) / 100 : 0
    };
  }

  resetStats(): void {
    this.stats = emptyStats();
    this.overheadTotal = 0;
    this.overheadCount = 0;
  }

  async start(preferredPort: number, scope: string[]): Promise<Result<number>> {
    if (this.server) return Ok(this.port ?? 0);

    const server = http.createServer((_req, res) => {
      // A plain HTTP request to the proxy is not something the client makes;
      // answer it rather than leaving the socket hanging.
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('Blossom Strap asset proxy\n');
    });

    // Node types the CONNECT socket as a Duplex; at runtime it is always the
    // underlying net.Socket, and we need its timeout and address handling.
    server.on('connect', (req, socket, head) => {
      const s = socket as net.Socket;
      this.trackSocket(s);
      void this.handleConnect(req, s, head, scope);
    });

    server.on('clientError', (_err, socket) => {
      socket.destroy();
    });

    try {
      // Loopback only. Binding to 0.0.0.0 would expose the user's Roblox
      // traffic to their whole network.
      server.listen(preferredPort > 0 ? preferredPort : 0, '127.0.0.1');
      await once(server, 'listening');
    } catch (e) {
      // A reserved or in-use preferred port falls back to an ephemeral one.
      if (preferredPort > 0) {
        this.log.warn('The preferred proxy port was unavailable; using an automatic one', { preferredPort });
        try {
          server.listen(0, '127.0.0.1');
          await once(server, 'listening');
        } catch (inner) {
          return Err('io-failure', 'The asset proxy could not start.', {
            details: { reason: inner instanceof Error ? inner.message : String(inner) }
          });
        }
      } else {
        return Err('io-failure', 'The asset proxy could not start.', {
          details: { reason: e instanceof Error ? e.message : String(e) }
        });
      }
    }

    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      return Err('io-failure', 'The asset proxy started without a usable address.');
    }

    this.server = server;
    this.port = address.port;
    this.startedAt = Date.now();
    this.resetStats();
    this.log.info('Asset proxy listening', { port: this.port, scopedHosts: scope.length });
    return Ok(this.port);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.port = null;
    this.startedAt = null;

    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();

    if (server) {
      await new Promise<void>((r) => server.close(() => r()));
      this.log.info('Asset proxy stopped');
    }
  }

  private trackSocket(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => this.sockets.delete(socket));
  }

  private async handleConnect(
    req: http.IncomingMessage,
    socket: net.Socket,
    head: Buffer,
    scope: string[]
  ): Promise<void> {
    const target = req.url ?? '';
    const host = stripPort(target);
    const port = portFrom(target);

    this.stats.requests += 1;

    if (!inScope(host, scope)) {
      this.stats.tunnelled += 1;
      this.tunnel(socket, head, host, port);
      return;
    }

    const leaf = this.ca.leafFor(host);
    if (!leaf.ok) {
      // Without a certificate we cannot terminate; tunnelling keeps the client
      // working, which matters more than intercepting this request.
      this.log.warn('Could not mint a certificate; tunnelling instead', { host });
      this.stats.tunnelled += 1;
      this.tunnel(socket, head, host, port);
      return;
    }

    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

    const secure = new tls.TLSSocket(socket, {
      isServer: true,
      key: leaf.value.key,
      cert: leaf.value.cert
    });
    secure.on('error', () => secure.destroy());
    if (head.length) secure.unshift(head);

    // A short-lived HTTP server bound to this one TLS socket lets Node parse
    // the tunnelled requests for us instead of hand-rolling a parser.
    const inner = http.createServer((innerReq, innerRes) => {
      void this.handleRequest(innerReq, innerRes, host, port);
    });
    inner.on('clientError', (_e, s) => s.destroy());
    inner.emit('connection', secure);

    secure.on('close', () => inner.close());
  }

  /** Raw pass-through. Blossom never sees inside these bytes. */
  private tunnel(socket: net.Socket, head: Buffer, host: string, port: number): void {
    const upstream = net.connect(port, host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });

    upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    host: string,
    port: number
  ): Promise<void> {
    const started = Date.now();
    const url = `https://${host}${req.url ?? '/'}`;
    const assetId = assetIdFromUrl(url);

    let resolution: Resolution = { kind: 'passthrough', reason: 'Resolver did not run.' };
    try {
      resolution = resolve({ assetId, url }, this.hooks.rules());
    } catch (e) {
      // The resolver is pure, but a bug in it must still not break the client.
      this.stats.errors += 1;
      this.log.error('The asset resolver threw; passing the request through', {
        reason: e instanceof Error ? e.message : String(e)
      });
    }

    this.stats.intercepted += 1;

    try {
      switch (resolution.kind) {
        case 'remove':
          this.serveEmpty(res);
          this.record(url, assetId, 'removed', resolution.rule.id, started, null);
          return;

        case 'replace-file': {
          const bytes = await this.hooks.readLocalFile(resolution.path);
          if (bytes) {
            this.serveBytes(res, bytes);
            this.record(url, assetId, 'replaced', resolution.rule.id, started, bytes);
            return;
          }
          this.log.warn('A replacement file could not be read; serving the original', {
            rule: resolution.rule.id
          });
          break;
        }

        case 'replace-asset': {
          const bytes = await this.hooks.resolveAssetBytes(resolution.targetAssetId);
          if (bytes) {
            this.serveBytes(res, bytes);
            this.record(url, assetId, 'replaced', resolution.rule.id, started, bytes);
            return;
          }
          // The replacement is not cached yet: fetch it from Roblox rather than
          // failing, so a fresh rule works on the first load.
          const fetched = await this.fetchUpstream(
            `https://assetdelivery.roblox.com/v1/asset/?id=${encodeURIComponent(resolution.targetAssetId)}`
          );
          if (fetched) {
            this.serveBytes(res, fetched);
            this.record(url, assetId, 'replaced', resolution.rule.id, started, fetched);
            return;
          }
          this.log.warn('A replacement asset could not be fetched; serving the original', {
            rule: resolution.rule.id, target: resolution.targetAssetId
          });
          break;
        }

        case 'replace-url': {
          const bytes = await this.fetchUpstream(resolution.url);
          if (bytes) {
            this.serveBytes(res, bytes);
            this.record(url, assetId, 'replaced', resolution.rule.id, started, bytes);
            return;
          }
          this.log.warn('A replacement URL could not be fetched; serving the original', {
            rule: resolution.rule.id
          });
          break;
        }

        case 'passthrough':
        default:
          break;
      }
    } catch (e) {
      this.stats.errors += 1;
      this.log.error('Replacement failed; serving the original', {
        reason: e instanceof Error ? e.message : String(e)
      });
    }

    // Everything that is not a served replacement ends here: the original request.
    await this.forward(req, res, host, port, url, assetId, started);
  }

  private serveBytes(res: http.ServerResponse, bytes: Buffer): void {
    this.stats.replaced += 1;
    const sniffed = sniffAsset(bytes.subarray(0, 4096));
    res.writeHead(200, {
      'content-type': sniffed.mime,
      'content-length': String(bytes.length),
      'cache-control': 'no-store'
    });
    res.end(bytes);
  }

  private serveEmpty(res: http.ServerResponse): void {
    this.stats.replaced += 1;
    // 200 with no body rather than 404: the client treats a missing asset as an
    // error and retries, while an empty success is simply nothing to draw.
    res.writeHead(200, { 'content-length': '0', 'cache-control': 'no-store' });
    res.end();
  }

  /** Streams the real response through, teeing it into the cache when small enough. */
  private forward(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    host: string,
    port: number,
    url: string,
    assetId: string | null,
    started: number
  ): Promise<void> {
    return new Promise((resolveDone) => {
      const headers = { ...req.headers };
      delete headers['proxy-connection'];

      const upstream = https.request(
        { host, port, path: req.url ?? '/', method: req.method ?? 'GET', headers, servername: host },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);

          const shouldBuffer =
            this.hooks.shouldCache() &&
            (req.method ?? 'GET') === 'GET' &&
            (upRes.statusCode ?? 0) === 200 &&
            Number(upRes.headers['content-length'] ?? 0) <= MAX_BUFFERED_BYTES;

          if (!shouldBuffer) {
            upRes.pipe(res);
            upRes.on('end', () => {
              this.record(url, assetId, 'passthrough', null, started, null);
              resolveDone();
            });
            return;
          }

          const chunks: Buffer[] = [];
          let bytes = 0;
          upRes.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes <= MAX_BUFFERED_BYTES) chunks.push(chunk);
            res.write(chunk);
          });
          upRes.on('end', () => {
            res.end();
            const body = bytes <= MAX_BUFFERED_BYTES ? Buffer.concat(chunks) : null;
            this.record(url, assetId, 'passthrough', null, started, body);
            resolveDone();
          });
        }
      );

      upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => upstream.destroy(new Error('upstream timed out')));
      upstream.on('error', (e) => {
        this.stats.errors += 1;
        this.log.debug('Upstream request failed', { host, reason: e.message });
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
        res.end();
        this.record(url, assetId, 'error', null, started, null);
        resolveDone();
      });

      req.pipe(upstream);
    });
  }

  /** One-shot fetch used to materialise a replacement. */
  private fetchUpstream(url: string): Promise<Buffer | null> {
    return new Promise((resolveDone) => {
      let settled = false;
      const done = (v: Buffer | null) => { if (!settled) { settled = true; resolveDone(v); } };

      try {
        const request = https.get(url, { headers: { 'user-agent': 'BlossomStrap' } }, (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            // One redirect hop only: asset delivery redirects to a CDN once.
            const next = res.headers.location;
            if (/^https:\/\//i.test(next)) {
              void this.fetchUpstream(next).then(done);
              return;
            }
            done(null);
            return;
          }
          if (status !== 200) { res.resume(); done(null); return; }

          const chunks: Buffer[] = [];
          let bytes = 0;
          res.on('data', (c: Buffer) => {
            bytes += c.length;
            if (bytes > MAX_BUFFERED_BYTES) { request.destroy(); done(null); return; }
            chunks.push(c);
          });
          res.on('end', () => done(Buffer.concat(chunks)));
          res.on('error', () => done(null));
        });

        request.setTimeout(UPSTREAM_TIMEOUT_MS, () => { request.destroy(); done(null); });
        request.on('error', () => done(null));
      } catch {
        done(null);
      }
    });
  }

  private record(
    url: string,
    assetId: string | null,
    outcome: CaptureEvent['outcome'],
    ruleId: string | null,
    started: number,
    body: Buffer | null
  ): void {
    const overheadMs = Date.now() - started;
    this.overheadTotal += overheadMs;
    this.overheadCount += 1;
    if (outcome === 'cache-hit') this.stats.cacheHits += 1;

    const event: CaptureEvent = {
      at: Date.now(),
      assetId: assetId ?? 'unknown',
      assetType: body ? sniffAsset(body.subarray(0, 4096)).type : 'unknown',
      url,
      sizeBytes: body?.length ?? null,
      outcome,
      ruleId,
      overheadMs
    };

    try {
      this.hooks.onCapture(event, assetId ? body : null);
    } catch {
      // Capture is observation; it must never affect the request.
    }
  }
}

function emptyStats(): InterceptionState['stats'] {
  return {
    requests: 0, intercepted: 0, tunnelled: 0, replaced: 0,
    cacheHits: 0, errors: 0, meanOverheadMs: 0, droppedCaptureEvents: 0
  };
}
