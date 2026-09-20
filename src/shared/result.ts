/**
 * Every service boundary in Blossom Strap returns a Result instead of throwing.
 * Exceptions still happen, but they are caught at the boundary and converted, so
 * the renderer never receives a stack trace and every failure has a stable code.
 */

export type ErrorCode =
  | 'unknown'
  | 'invalid-argument'
  | 'not-found'
  | 'already-exists'
  | 'permission-denied'
  | 'io-failure'
  | 'network-failure'
  | 'parse-failure'
  | 'validation-failed'
  | 'unsupported-platform'
  | 'roblox-not-found'
  | 'roblox-already-running'
  | 'launch-failed'
  | 'profile-invalid'
  | 'incompatible'
  | 'cancelled'
  | 'busy'
  | 'timeout';

export interface BlossomError {
  code: ErrorCode;
  /** Shown to the user. Complete sentence, no stack, no jargon. */
  message: string;
  /** What the user can do about it, when there is something. */
  remediation?: string;
  /** Non-sensitive structured context for logs and diagnostics. */
  details?: Record<string, unknown>;
}

export type Result<T, E = BlossomError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export const Ok = <T>(value: T): Result<T> => ({ ok: true, value });

export const Err = (
  code: ErrorCode,
  message: string,
  extra?: { remediation?: string; details?: Record<string, unknown> }
): Result<never> => ({
  ok: false,
  error: { code, message, ...extra }
});

export function isOk<T, E>(r: Result<T, E>): r is { ok: true; value: T } {
  return r.ok;
}

export function unwrapOr<T>(r: Result<T>, fallback: T): T {
  return r.ok ? r.value : fallback;
}

/** Converts a thrown value into a BlossomError without leaking a stack. */
export function toBlossomError(e: unknown, code: ErrorCode = 'unknown'): BlossomError {
  if (e && typeof e === 'object' && 'code' in e && 'message' in e) {
    const c = (e as { code: unknown }).code;
    if (typeof c === 'string' && typeof (e as { message: unknown }).message === 'string') {
      // Node system errors (ENOENT, EACCES, ...) map onto our codes.
      const mapped: ErrorCode =
        c === 'ENOENT' ? 'not-found'
          : c === 'EACCES' || c === 'EPERM' ? 'permission-denied'
            : c === 'EEXIST' ? 'already-exists'
              : c === 'ETIMEDOUT' ? 'timeout'
                : c.startsWith('E') ? 'io-failure'
                  : code;
      return { code: mapped, message: (e as { message: string }).message };
    }
  }
  if (e instanceof Error) return { code, message: e.message };
  return { code, message: String(e) };
}

/** Runs an async function, converting a throw into an Err. */
export async function attempt<T>(
  fn: () => Promise<T>,
  code: ErrorCode = 'unknown'
): Promise<Result<T>> {
  try {
    return Ok(await fn());
  } catch (e) {
    return { ok: false, error: toBlossomError(e, code) };
  }
}

export function attemptSync<T>(fn: () => T, code: ErrorCode = 'unknown'): Result<T> {
  try {
    return Ok(fn());
  } catch (e) {
    return { ok: false, error: toBlossomError(e, code) };
  }
}
