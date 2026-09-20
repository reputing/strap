import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import forge from 'node-forge';
import { Err, Ok, type Result } from '@shared/result';
import type { ScopedLogger } from '@main/core/logger';
import { ensureDir, exists, writeFileAtomic } from '@main/core/fs-utils';

export interface Leaf {
  key: string;
  cert: string;
}

const CA_KEY_FILE = 'blossom-ca.key.pem';
const CA_CERT_FILE = 'blossom-ca.cert.pem';
const CA_VALID_YEARS = 3;
const LEAF_VALID_DAYS = 90;
const LEAF_CACHE_LIMIT = 64;

/**
 * A locally generated certificate authority used only to terminate TLS for the
 * Roblox asset hosts the user has chosen to intercept.
 *
 * This CA is deliberately *not* installed into the Windows trust store. It goes
 * into Roblox Player's own bundled `ssl/cacert.pem` and nowhere else, so its
 * reach is exactly one application. The private key never leaves the user's
 * profile directory, and `destroy` removes it.
 */
export class CertificateAuthority {
  private caKey: forge.pki.rsa.PrivateKey | null = null;
  private caCert: forge.pki.Certificate | null = null;
  private caPem: string | null = null;
  private readonly leaves = new Map<string, Leaf>();

  constructor(
    private readonly directory: string,
    private readonly log: ScopedLogger
  ) {}

  get certificatePem(): string | null {
    return this.caPem;
  }

  get keyPath(): string {
    return join(this.directory, CA_KEY_FILE);
  }

  get certPath(): string {
    return join(this.directory, CA_CERT_FILE);
  }

  /** Loads the CA from disk, generating one on first use. */
  async load(): Promise<Result<void>> {
    await ensureDir(this.directory);

    if ((await exists(this.keyPath)) && (await exists(this.certPath))) {
      try {
        const keyPem = await fs.readFile(this.keyPath, 'utf8');
        const certPem = await fs.readFile(this.certPath, 'utf8');
        const cert = forge.pki.certificateFromPem(certPem);

        if (cert.validity.notAfter.getTime() > Date.now() + 30 * 86_400_000) {
          this.caKey = forge.pki.privateKeyFromPem(keyPem);
          this.caCert = cert;
          this.caPem = certPem;
          this.log.debug('Local certificate authority loaded');
          return Ok(undefined);
        }
        this.log.info('The local certificate authority is close to expiry; generating a new one');
      } catch {
        this.log.warn('The local certificate authority could not be read; generating a new one');
      }
    }

    return this.generate();
  }

  private async generate(): Promise<Result<void>> {
    try {
      // 2048 bits: generating 4096 in pure JavaScript takes long enough that
      // the first launch would visibly stall.
      const keys = forge.pki.rsa.generateKeyPair(2048);
      const cert = forge.pki.createCertificate();

      cert.publicKey = keys.publicKey;
      cert.serialNumber = `00${forge.util.bytesToHex(forge.random.getBytesSync(16))}`;
      cert.validity.notBefore = new Date(Date.now() - 86_400_000);
      cert.validity.notAfter = new Date();
      cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + CA_VALID_YEARS);

      const attrs = [
        { name: 'commonName', value: 'Blossom Strap Local Asset CA' },
        { name: 'organizationName', value: 'Blossom Strap' },
        { shortName: 'OU', value: 'Local asset interception' }
      ];
      cert.setSubject(attrs);
      cert.setIssuer(attrs);
      cert.setExtensions([
        { name: 'basicConstraints', cA: true, critical: true, pathLenConstraint: 0 },
        { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
        { name: 'subjectKeyIdentifier' }
      ]);
      cert.sign(keys.privateKey, forge.md.sha256.create());

      const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
      const certPem = forge.pki.certificateToPem(cert);

      await writeFileAtomic(this.keyPath, keyPem);
      await writeFileAtomic(this.certPath, certPem);
      // The private key is the whole security boundary; keep it owner-only
      // where the platform honours file modes.
      await fs.chmod(this.keyPath, 0o600).catch(() => undefined);

      this.caKey = keys.privateKey;
      this.caCert = cert;
      this.caPem = certPem;
      this.leaves.clear();

      this.log.info('Generated a local certificate authority for asset interception');
      return Ok(undefined);
    } catch (e) {
      return Err('io-failure', 'Blossom could not create the local certificate it needs for interception.', {
        details: { reason: e instanceof Error ? e.message : String(e) }
      });
    }
  }

  /** Mints (and caches) a leaf certificate for one hostname. */
  leafFor(hostname: string): Result<Leaf> {
    if (!this.caKey || !this.caCert) {
      return Err('invalid-argument', 'The local certificate authority is not loaded.');
    }

    const key = hostname.toLowerCase();
    const cached = this.leaves.get(key);
    if (cached) return Ok(cached);

    try {
      const keys = forge.pki.rsa.generateKeyPair(2048);
      const cert = forge.pki.createCertificate();

      cert.publicKey = keys.publicKey;
      cert.serialNumber = `00${forge.util.bytesToHex(forge.random.getBytesSync(16))}`;
      cert.validity.notBefore = new Date(Date.now() - 86_400_000);
      cert.validity.notAfter = new Date(Date.now() + LEAF_VALID_DAYS * 86_400_000);

      cert.setSubject([{ name: 'commonName', value: hostname }]);
      cert.setIssuer(this.caCert.subject.attributes);
      cert.setExtensions([
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
        { name: 'extKeyUsage', serverAuth: true },
        // Modern TLS stacks ignore commonName, so the SAN is what actually matters.
        { name: 'subjectAltName', altNames: [{ type: 2, value: hostname }] }
      ]);
      cert.sign(this.caKey, forge.md.sha256.create());

      const leaf: Leaf = {
        key: forge.pki.privateKeyToPem(keys.privateKey),
        cert: forge.pki.certificateToPem(cert)
      };

      // Bounded cache: a long session touching many CDN hosts should not grow
      // this without limit.
      if (this.leaves.size >= LEAF_CACHE_LIMIT) {
        const oldest = this.leaves.keys().next().value;
        if (oldest) this.leaves.delete(oldest);
      }
      this.leaves.set(key, leaf);
      return Ok(leaf);
    } catch (e) {
      return Err('unknown', `Blossom could not create a certificate for ${hostname}.`, {
        details: { reason: e instanceof Error ? e.message : String(e) }
      });
    }
  }

  /** Removes the CA material from disk. */
  async destroy(): Promise<void> {
    this.caKey = null;
    this.caCert = null;
    this.caPem = null;
    this.leaves.clear();
    await fs.rm(this.keyPath, { force: true }).catch(() => undefined);
    await fs.rm(this.certPath, { force: true }).catch(() => undefined);
    this.log.info('Removed the local certificate authority');
  }

  /** Fingerprint shown in the UI so the user can verify what is installed. */
  fingerprint(): string | null {
    if (!this.caCert) return null;
    const der = forge.asn1.toDer(forge.pki.certificateToAsn1(this.caCert)).getBytes();
    const md = forge.md.sha256.create();
    md.update(der);
    return md.digest().toHex().toUpperCase().match(/.{2}/g)?.join(':') ?? null;
  }
}
