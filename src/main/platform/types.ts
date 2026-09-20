import type { HardwareProfile } from '@shared/types';
import type { Result } from '@shared/result';

export interface OsProcess {
  pid: number;
  name: string;
  executable: string | null;
  startedAt: number;
}

export interface ProcessCounters {
  pid: number;
  /** Cumulative CPU time consumed by the process, milliseconds. */
  cpuTimeMs: number;
  /** Working set, bytes. */
  memoryBytes: number;
  startedAt: number;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ProcessEvent =
  | { kind: 'started'; process: OsProcess }
  | { kind: 'stopped'; pid: number };

/**
 * Everything OS-specific lives behind this interface. There are two
 * implementations: the real Windows one, and a fake used by tests and by
 * non-Windows development so the rest of the app can be exercised anywhere.
 */
export interface PlatformAdapter {
  readonly id: 'windows' | 'fake';
  /** False when the adapter cannot do real work (e.g. fake on Linux). */
  readonly operational: boolean;

  init(): Promise<void>;
  dispose(): Promise<void>;

  listProcesses(names: string[]): Promise<Result<OsProcess[]>>;

  /**
   * Subscribes to process start/stop for the given executable names.
   * Implementations must be event-driven where the OS allows it; the returned
   * function unsubscribes.
   */
  watchProcesses(names: string[], listener: (e: ProcessEvent) => void): Promise<Result<() => void>>;

  sampleProcess(pid: number): Promise<Result<ProcessCounters>>;

  setPriority(pid: number, priority: 'normal' | 'above-normal' | 'high'): Promise<Result<void>>;
  setAffinity(pid: number, mask: number): Promise<Result<void>>;
  killProcess(pid: number): Promise<Result<void>>;

  queryHardware(): Promise<Result<HardwareProfile>>;

  /** Bounds of the process's main window, for positioning overlays. */
  getMainWindowBounds(pid: number): Promise<Result<WindowBounds | null>>;

  /** Whether the process's main window currently has focus. */
  isForeground(pid: number): Promise<Result<boolean>>;

  /** Registers or clears Blossom as the handler for a URL protocol. */
  setProtocolHandler(protocol: string, command: string | null): Promise<Result<void>>;
  getProtocolHandler(protocol: string): Promise<Result<string | null>>;

  setRunAtLogin(enabled: boolean, command: string): Promise<Result<void>>;
}
