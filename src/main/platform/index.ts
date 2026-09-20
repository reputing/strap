import type { ScopedLogger } from '@main/core/logger';
import type { PlatformAdapter } from './types';
import { FakeAdapter } from './fake-adapter';
import { WindowsAdapter } from './windows/windows-adapter';

export * from './types';
export { FakeAdapter } from './fake-adapter';
export { WindowsAdapter, classifyTier } from './windows/windows-adapter';

/**
 * Windows gets the real adapter; every other platform gets the fake one, which
 * reports itself as non-operational so the UI can be honest about it rather
 * than showing fabricated values.
 */
export function createPlatformAdapter(log: ScopedLogger): PlatformAdapter {
  if (process.platform === 'win32') return new WindowsAdapter(log);
  log.warn('Not running on Windows; OS integration is disabled', { platform: process.platform });
  return new FakeAdapter();
}
