import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC_EVENT_CHANNEL, IPC_REQUEST_CHANNEL,
  type BlossomBridge, type IpcEventName, type IpcEventPayload
} from '@shared/ipc';

/**
 * The only surface the renderer can reach.
 *
 * Two functions: one to invoke a named request, one to subscribe to a named
 * event. No Node, no `require`, no `ipcRenderer`, no module access. Everything
 * the UI can do is something a main-process handler chose to expose.
 */

/**
 * Event subscriptions are fanned out from a single IPC listener.
 *
 * The obvious implementation — one `ipcRenderer.on` per subscription — adds a
 * listener to the same channel for every hook in the application, trips Node's
 * max-listener warning at eleven, and grows with the component tree. One
 * listener dispatching to a local map has neither problem.
 */
const listeners = new Map<string, Set<(payload: unknown) => void>>();

ipcRenderer.on(IPC_EVENT_CHANNEL, (_event, name: string, payload: unknown) => {
  const forEvent = listeners.get(name);
  if (!forEvent) return;
  // Copied before iterating so a listener that unsubscribes itself, or
  // subscribes another, cannot disturb this dispatch.
  for (const listener of [...forEvent]) {
    try {
      listener(payload);
    } catch {
      // One bad subscriber must not stop the others from being told.
    }
  }
});

const bridge: BlossomBridge = {
  invoke(channel, params) {
    return ipcRenderer.invoke(IPC_REQUEST_CHANNEL, channel, params);
  },

  on<E extends IpcEventName>(event: E, listener: (payload: IpcEventPayload<E>) => void) {
    const wrapped = listener as (payload: unknown) => void;
    let forEvent = listeners.get(event);
    if (!forEvent) {
      forEvent = new Set();
      listeners.set(event, forEvent);
    }
    forEvent.add(wrapped);

    return () => {
      const current = listeners.get(event);
      if (!current) return;
      current.delete(wrapped);
      if (current.size === 0) listeners.delete(event);
    };
  }
};

contextBridge.exposeInMainWorld('blossom', bridge);

/**
 * Overlay windows get a separate, deliberately tiny surface: they receive
 * configuration and samples, and can send nothing back.
 */
contextBridge.exposeInMainWorld('blossomOverlay', {
  onConfig(listener: (payload: { kind: 'crosshair' | 'hud'; config: unknown }) => void) {
    const wrapped = (_e: unknown, payload: { kind: 'crosshair' | 'hud'; config: unknown }) => listener(payload);
    ipcRenderer.on('overlay:config', wrapped);
    return () => { ipcRenderer.removeListener('overlay:config', wrapped); };
  },
  onSample(listener: (payload: unknown) => void) {
    const wrapped = (_e: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on('overlay:sample', wrapped);
    return () => { ipcRenderer.removeListener('overlay:sample', wrapped); };
  }
});
