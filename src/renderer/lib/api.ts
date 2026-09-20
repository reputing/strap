import { useCallback, useEffect, useRef, useState } from 'react';
import type { BlossomBridge, IpcChannel, IpcEventName, IpcEventPayload, IpcParams, IpcResult } from '@shared/ipc';
import type { BlossomError, Result } from '@shared/result';

declare global {
  interface Window {
    blossom: BlossomBridge;
  }
}

/**
 * The renderer's only route to the main process.
 *
 * Every call returns a Result. Nothing here throws, so a component never has to
 * decide between a try/catch and an error boundary — it renders the error the
 * same way it renders the data.
 */
export async function call<C extends IpcChannel>(
  channel: C,
  params: IpcParams<C>
): Promise<Result<IpcResult<C>>> {
  try {
    return await window.blossom.invoke(channel, params);
  } catch {
    // The bridge itself failing means the main process is gone.
    return {
      ok: false,
      error: { code: 'unknown', message: 'Blossom lost contact with its background process.' }
    };
  }
}

export function on<E extends IpcEventName>(
  event: E,
  listener: (payload: IpcEventPayload<E>) => void
): () => void {
  return window.blossom.on(event, listener);
}

export interface Query<T> {
  data: T | null;
  error: BlossomError | null;
  loading: boolean;
  refetch: () => void;
}

/**
 * Loads once and re-loads when `deps` change or an event fires.
 *
 * Results that arrive after the component unmounted, or after a newer request
 * started, are discarded — the common cause of a list flickering back to stale
 * data after a refresh.
 */
export function useQuery<C extends IpcChannel>(
  channel: C,
  params: IpcParams<C>,
  options: { deps?: unknown[]; on?: IpcEventName[]; enabled?: boolean } = {}
): Query<IpcResult<C>> {
  const [data, setData] = useState<IpcResult<C> | null>(null);
  const [error, setError] = useState<BlossomError | null>(null);
  const [loading, setLoading] = useState(options.enabled !== false);
  const generation = useRef(0);
  const alive = useRef(true);
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const run = useCallback(async () => {
    if (options.enabled === false) return;
    const mine = ++generation.current;
    setLoading(true);
    const result = await call(channel, paramsRef.current);
    if (!alive.current || mine !== generation.current) return;

    if (result.ok) { setData(result.value); setError(null); }
    else { setError(result.error); }
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, options.enabled]);

  useEffect(() => {
    alive.current = true;
    void run();
    return () => { alive.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, ...(options.deps ?? [])]);

  useEffect(() => {
    if (!options.on?.length) return;
    const offs = options.on.map((event) => on(event, () => { void run(); }));
    return () => { for (const off of offs) off(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, options.on?.join('|')]);

  return { data, error, loading, refetch: () => { void run(); } };
}

/** Subscribes to a push channel, seeded with an initial value. */
export function useEventValue<E extends IpcEventName>(
  event: E,
  initial: IpcEventPayload<E> | null
): IpcEventPayload<E> | null {
  const [value, setValue] = useState(initial);
  useEffect(() => on(event, setValue), [event]);
  return value;
}

/** An async action with its own pending and error state. */
export function useAction<Args extends unknown[], T>(
  fn: (...args: Args) => Promise<Result<T>>
): {
  run: (...args: Args) => Promise<Result<T>>;
  pending: boolean;
  error: BlossomError | null;
  clearError: () => void;
} {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<BlossomError | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const run = useCallback(async (...args: Args) => {
    setPending(true);
    setError(null);
    const result = await fn(...args);
    if (alive.current) {
      setPending(false);
      if (!result.ok) setError(result.error);
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fn]);

  return { run, pending, error, clearError: () => setError(null) };
}

/** Delays a fast-changing value — used for every search box in the app. */
export function useDebounced<T>(value: T, delayMs = 180): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
