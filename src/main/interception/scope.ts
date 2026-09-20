/**
 * Interception scope.
 *
 * The proxy decrypts traffic for hosts on this list and blind-tunnels
 * everything else. The list is asset delivery only: authentication, payments,
 * presence and telemetry are never decrypted, no matter what the user adds,
 * because those hosts are refused by `isAllowedScopeEntry` below.
 *
 * This is the single enforcement point for that boundary, and it is covered by
 * tests, so widening it is a deliberate, visible change rather than an accident.
 */

/**
 * Asset hosts are the only thing that may be decrypted. The rule is positive —
 * an entry must match one of these shapes — rather than a list of exclusions,
 * because a deny-list is one forgotten hostname away from being wrong.
 */
const ASSET_HOST_PATTERNS: RegExp[] = [
  // Every rbxcdn.com host, including the apex used as a suffix entry.
  /^([a-z0-9-]+\.)*rbxcdn\.com$/,
  // The asset delivery API itself, which is where asset ids are resolved.
  /^assetdelivery\.roblox\.com$/,
  /^assetgame\.roblox\.com$/
];

/**
 * Hosts that must never be decrypted even though they would otherwise match a
 * pattern above. Kept as a second gate so a future pattern change cannot
 * silently pull one of these in.
 */
const FORBIDDEN_PATTERNS: RegExp[] = [
  /(^|\.)auth\.roblox\.com$/,
  /(^|\.)apis\.roblox\.com$/,
  /(^|\.)accountsettings\.roblox\.com$/,
  /(^|\.)accountinformation\.roblox\.com$/,
  /(^|\.)economy\.roblox\.com$/,
  /(^|\.)billing\.roblox\.com$/,
  /(^|\.)twostepverification\.roblox\.com$/,
  /(^|\.)users\.roblox\.com$/,
  /(^|\.)www\.roblox\.com$/,
  /(^|\.)gamejoin\.roblox\.com$/,
  /(^|\.)clientsettings(cdn)?\.roblox\.com$/,
  /(^|\.)ephemeralcounters\.api\.roblox\.com$/
];

/** A configured scope entry is accepted only if it is an asset host. */
export function isAllowedScopeEntry(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (!h || h.length > 253) return false;
  if (!/^[a-z0-9.-]+$/.test(h)) return false;
  if (FORBIDDEN_PATTERNS.some((p) => p.test(h))) return false;
  return ASSET_HOST_PATTERNS.some((p) => p.test(h));
}

export function sanitiseScope(scope: string[]): string[] {
  return [...new Set(scope.map((s) => s.trim().toLowerCase()).filter(isAllowedScopeEntry))];
}

/**
 * Decides whether a CONNECT target is decrypted or tunnelled.
 * Matching is on the exact host or a dot-suffix, never a substring: `evil-rbxcdn.com`
 * must not match `rbxcdn.com`.
 */
export function inScope(host: string, scope: string[]): boolean {
  const h = stripPort(host).toLowerCase();
  if (!h || !isAllowedScopeEntry(h)) return false;

  return scope.some((entry) => {
    const e = entry.trim().toLowerCase();
    if (!e) return false;
    // Exact host, or a dot-boundary suffix. Never a substring: `evil-rbxcdn.com`
    // must not match an entry of `rbxcdn.com`.
    return h === e || h.endsWith(`.${e}`);
  });
}

export function stripPort(hostWithPort: string): string {
  const at = hostWithPort.lastIndexOf(':');
  // Leave IPv6 literals alone.
  if (at <= 0 || hostWithPort.includes(']')) return hostWithPort;
  return hostWithPort.slice(0, at);
}

export function portFrom(hostWithPort: string, fallback = 443): number {
  const at = hostWithPort.lastIndexOf(':');
  if (at <= 0 || hostWithPort.includes(']')) return fallback;
  const n = Number(hostWithPort.slice(at + 1));
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}
