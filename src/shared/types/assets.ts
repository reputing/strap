export type AssetType =
  | 'image'
  | 'texture'
  | 'mesh'
  | 'audio'
  | 'animation'
  | 'model'
  | 'font'
  | 'translation'
  | 'video'
  | 'json'
  | 'text'
  | 'unknown';

export type RuleAction = 'replace-asset' | 'replace-file' | 'replace-url' | 'remove' | 'passthrough';

/**
 * A single replacement rule. Rules live in rule sets ("asset profiles") and are
 * evaluated in priority order; the first enabled match wins.
 */
export interface AssetRule {
  id: string;
  /** Rule set this rule belongs to. */
  setId: string;
  /** Source asset id (numeric, as a string) or a glob over the request path. */
  source: string;
  action: RuleAction;
  /** Target asset id / absolute local path / URL. Empty for `remove`. */
  target: string;
  assetType: AssetType;
  enabled: boolean;
  /** Higher wins. Ties break on creation order. */
  priority: number;
  notes: string;
  createdAt: number;
  updatedAt: number;
  /** Times this rule has been served since it was created. */
  hits: number;
}

export interface AssetRuleSet {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  /** Display and evaluation order relative to other sets. */
  order: number;
  createdAt: number;
  updatedAt: number;
  ruleCount: number;
}

export interface CachedAsset {
  assetId: string;
  assetType: AssetType;
  sourceUrl: string | null;
  /** SHA-256 of the bytes; also the blob store key. */
  hash: string;
  sizeBytes: number;
  firstSeen: number;
  lastSeen: number;
  hitCount: number;
  /** Where the bytes came from. */
  origin: 'proxy' | 'roblox-cache' | 'import';
  /** Decoded metadata, e.g. image dimensions or audio duration. Best effort. */
  meta: Record<string, string | number> | null;
}

export interface AssetQuery {
  search?: string;
  types?: AssetType[];
  minSize?: number;
  maxSize?: number;
  seenAfter?: number;
  seenBefore?: number;
  origin?: CachedAsset['origin'];
  /** Only assets that have a rule targeting them. */
  replacedOnly?: boolean;
  sort?: 'lastSeen' | 'firstSeen' | 'size' | 'assetId' | 'hits';
  direction?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface AssetPage {
  items: CachedAsset[];
  total: number;
  offset: number;
  limit: number;
}

export interface CacheStats {
  assetCount: number;
  blobCount: number;
  totalBytes: number;
  duplicateBytesSaved: number;
  byType: Record<string, { count: number; bytes: number }>;
  oldest: number | null;
  newest: number | null;
}

export interface CaptureEvent {
  at: number;
  assetId: string;
  assetType: AssetType;
  url: string;
  sizeBytes: number | null;
  /** How the request was resolved. */
  outcome: 'passthrough' | 'replaced' | 'removed' | 'cache-hit' | 'error';
  ruleId: string | null;
  /** Milliseconds Blossom added to the request. */
  overheadMs: number | null;
}

export type InterceptionStatus = 'stopped' | 'starting' | 'running' | 'degraded' | 'failed';

export interface InterceptionState {
  status: InterceptionStatus;
  /** Loopback port the proxy is bound to, when running. */
  port: number | null;
  /** Why the engine is degraded or failed. */
  detail: string | null;
  /** Whether Blossom's CA is currently present in Roblox's own bundle. */
  certificateInstalled: boolean;
  startedAt: number | null;
  stats: {
    requests: number;
    intercepted: number;
    tunnelled: number;
    replaced: number;
    cacheHits: number;
    errors: number;
    /** Mean added latency over intercepted requests, ms. */
    meanOverheadMs: number;
    droppedCaptureEvents: number;
  };
}
