import { globalShortcut } from 'electron';
import type { AppSettings, HotkeyAction } from '@shared/types';
import type { ScopedLogger } from './core/logger';

/**
 * Global hotkeys.
 *
 * Off by default, and registered one at a time only for actions the user has
 * bound. A launcher that silently takes over key combinations system-wide is a
 * launcher that breaks somebody else's software, so nothing is registered until
 * `hotkeys.enabled` is explicitly turned on.
 *
 * A binding another application already owns is reported rather than swallowed.
 */
export class HotkeyController {
  private registered: string[] = [];

  constructor(
    private readonly run: (action: HotkeyAction) => void,
    private readonly log: ScopedLogger
  ) {}

  apply(settings: AppSettings): { registered: string[]; failed: { action: HotkeyAction; accelerator: string }[] } {
    this.unregisterAll();
    const failed: { action: HotkeyAction; accelerator: string }[] = [];

    if (!settings.hotkeys.enabled) {
      this.log.debug('Global hotkeys are turned off');
      return { registered: [], failed };
    }

    for (const [action, accelerator] of Object.entries(settings.hotkeys.bindings) as [HotkeyAction, string][]) {
      if (!accelerator?.trim()) continue;
      try {
        const ok = globalShortcut.register(accelerator, () => {
          try {
            this.run(action);
          } catch (e) {
            this.log.error('A hotkey action failed', {
              action, reason: e instanceof Error ? e.message : String(e)
            });
          }
        });
        if (ok) this.registered.push(accelerator);
        else failed.push({ action, accelerator });
      } catch {
        failed.push({ action, accelerator });
      }
    }

    if (this.registered.length) this.log.info('Global hotkeys registered', { count: this.registered.length });
    for (const f of failed) {
      this.log.warn('A hotkey could not be registered; another application is probably using it', f);
    }

    return { registered: [...this.registered], failed };
  }

  unregisterAll(): void {
    for (const accelerator of this.registered) {
      try {
        globalShortcut.unregister(accelerator);
      } catch { /* already gone */ }
    }
    this.registered = [];
  }
}
