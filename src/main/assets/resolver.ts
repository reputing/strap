import type { AssetRule, AssetType } from '@shared/types';

export interface ResolveRequest {
  /** Numeric asset id, when one could be determined from the request. */
  assetId: string | null;
  /** The full request URL, used by glob rules. */
  url: string;
  /** Type, where it is already known from a previous capture. */
  assetType?: AssetType;
}

export type Resolution =
  | { kind: 'passthrough'; reason: string }
  | { kind: 'replace-asset'; rule: AssetRule; targetAssetId: string }
  | { kind: 'replace-file'; rule: AssetRule; path: string }
  | { kind: 'replace-url'; rule: AssetRule; url: string }
  | { kind: 'remove'; rule: AssetRule };

/**
 * Decides what happens to one asset request.
 *
 * Rules arrive pre-sorted by priority; the first enabled rule whose source
 * matches wins. A rule that matches but has an unusable target resolves to
 * passthrough with a reason rather than failing the request — the guiding
 * principle of the whole asset system is that a customization mistake must
 * never be able to break somebody's client.
 */
export function resolve(request: ResolveRequest, rules: AssetRule[]): Resolution {
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!matches(rule, request)) continue;

    switch (rule.action) {
      case 'passthrough':
        return { kind: 'passthrough', reason: `Rule "${rule.source}" explicitly allows the original.` };

      case 'remove':
        return { kind: 'remove', rule };

      case 'replace-asset': {
        const target = rule.target.trim();
        if (!/^\d{1,20}$/.test(target)) {
          return { kind: 'passthrough', reason: 'The replacement asset id is not a number.' };
        }
        if (request.assetId && target === request.assetId) {
          // A rule pointing at itself would be an infinite indirection.
          return { kind: 'passthrough', reason: 'The rule replaces an asset with itself.' };
        }
        return { kind: 'replace-asset', rule, targetAssetId: target };
      }

      case 'replace-file': {
        const path = rule.target.trim();
        if (!path) return { kind: 'passthrough', reason: 'The rule has no file selected.' };
        return { kind: 'replace-file', rule, path };
      }

      case 'replace-url': {
        const url = rule.target.trim();
        if (!/^https:\/\//i.test(url)) {
          // Plain HTTP would downgrade a request the client made over TLS.
          return { kind: 'passthrough', reason: 'Replacement URLs must use https.' };
        }
        return { kind: 'replace-url', rule, url };
      }

      default:
        return { kind: 'passthrough', reason: 'Unknown rule action.' };
    }
  }

  return { kind: 'passthrough', reason: 'No rule matched.' };
}

/**
 * A rule's source is either an exact asset id or a glob over the request URL.
 * Exact ids are the common case and are checked first because they are cheap.
 */
export function matches(rule: AssetRule, request: ResolveRequest): boolean {
  const source = rule.source.trim();
  if (!source) return false;

  if (/^\d{1,20}$/.test(source)) {
    return request.assetId === source;
  }

  if (source.includes('*') || source.includes('?')) {
    return globToRegExp(source).test(request.url);
  }

  // A non-numeric, non-glob source is treated as a substring of the URL, which
  // is what people reach for when they paste a CDN path.
  return request.url.includes(source);
}

const globCache = new Map<string, RegExp>();

/**
 * Compiles a glob into an anchored regular expression.
 *
 * Patterns come from the user, so every regex metacharacter is escaped before
 * the wildcards are reintroduced — a rule source must never be able to become
 * a catastrophically backtracking pattern.
 */
export function globToRegExp(glob: string): RegExp {
  const cached = globCache.get(glob);
  if (cached) return cached;

  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  const re = new RegExp(`^${pattern}$`, 'i');

  if (globCache.size > 500) globCache.clear();
  globCache.set(glob, re);
  return re;
}

/** Orders rules the way the resolver expects: priority first, then age. */
export function sortRules(rules: AssetRule[]): AssetRule[] {
  return [...rules].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.createdAt - b.createdAt;
  });
}
