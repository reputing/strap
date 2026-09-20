import { ipcMain, type WebContents } from 'electron';
import { IPC_EVENT_CHANNEL, IPC_REQUEST_CHANNEL, type IpcChannel, type IpcEventName, type IpcEventPayload, type IpcParams, type IpcResult } from '@shared/ipc';
import { Err, toBlossomError, type Result } from '@shared/result';
import type { ScopedLogger } from './logger';

type Handler<C extends IpcChannel> = (params: IpcParams<C>) => Promise<Result<IpcResult<C>>> | Result<IpcResult<C>>;

/**
 * Handlers are stored erased, because a map cannot hold a different function
 * type per key. `handle` keeps the call site fully typed; this is the one
 * place the type is widened, and the only value that ever reaches it came
 * from a typed `handle` call.
 */
type ErasedHandler = (params: unknown) => Promise<Result<unknown>> | Result<unknown>;

/**
 * The single IPC boundary.
 *
 * One `invoke` channel carries every request, dispatched by name against a
 * registry. That means there is exactly one place where renderer input crosses
 * into the main process, one place where exceptions are converted into
 * `Result`s, and one place to look when something does not reach a service.
 *
 * A handler that throws produces a generic error for the renderer and a full
 * stack in the log: the UI never receives internals.
 */
export class IpcRouter {
  private readonly handlers = new Map<string, ErasedHandler>();
  private readonly windows = new Set<WebContents>();
  private registered = false;

  constructor(private readonly log: ScopedLogger) {}

  handle<C extends IpcChannel>(channel: C, handler: Handler<C>): void {
    if (this.handlers.has(channel)) {
      throw new Error(`Duplicate IPC handler for ${channel}`);
    }
    this.handlers.set(channel, handler as ErasedHandler);
  }

  /** Channels declared in the contract but not wired up. Checked at startup. */
  missing(expected: readonly string[]): string[] {
    return expected.filter((c) => !this.handlers.has(c));
  }

  listen(): void {
    if (this.registered) return;
    this.registered = true;

    ipcMain.handle(IPC_REQUEST_CHANNEL, async (_event, channel: unknown, params: unknown) => {
      if (typeof channel !== 'string') {
        return Err('invalid-argument', 'Malformed request.');
      }

      const handler = this.handlers.get(channel);
      if (!handler) {
        this.log.warn('A request arrived for an unknown channel', { channel });
        return Err('not-found', 'That action is not available in this version.');
      }

      const started = Date.now();
      try {
        const result = await handler(params);
        const elapsed = Date.now() - started;
        // Surface anything slow enough that the user would feel it.
        if (elapsed > 750) this.log.debug('Slow request', { channel, ms: elapsed });
        if (!result.ok) this.log.debug('Request failed', { channel, code: result.error.code });
        return result;
      } catch (e) {
        const error = toBlossomError(e);
        this.log.error('A request threw', {
          channel,
          message: error.message,
          stack: e instanceof Error ? e.stack?.split('\n').slice(0, 4).join(' | ') : undefined
        });
        return Err('unknown', 'Something went wrong inside Blossom. The details are in the log.', {
          remediation: 'Open Diagnostics to see what happened.'
        });
      }
    });
  }

  register(contents: WebContents): void {
    this.windows.add(contents);
    contents.once('destroyed', () => this.windows.delete(contents));
  }

  /** Pushes an event to every live renderer. */
  emit<E extends IpcEventName>(event: E, payload: IpcEventPayload<E>): void {
    for (const contents of this.windows) {
      if (contents.isDestroyed()) {
        this.windows.delete(contents);
        continue;
      }
      try {
        contents.send(IPC_EVENT_CHANNEL, event, payload);
      } catch {
        // A window closing mid-send is normal and not worth logging.
      }
    }
  }

  dispose(): void {
    if (this.registered) {
      ipcMain.removeHandler(IPC_REQUEST_CHANNEL);
      this.registered = false;
    }
    this.handlers.clear();
    this.windows.clear();
  }
}
