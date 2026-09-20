import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC_EVENT_CHANNEL, IPC_REQUEST_CHANNEL,
  type BlossomBridge, type IpcChannel, type IpcEventName, type IpcEventPayload, type IpcParams
} from '@shared/ipc';

/**
 * The only surface the renderer can reach.
 *
 * Two functions: one to invoke a named request, one to subscribe to a named
 * event. No Node, no `require`, no `ipcRenderer`, no module access. Everything
 * the UI can do is something a main-process handler chose to expose.
 */
const bridge: BlossomBridge = {
  invoke(channel, params) {
    return ipcRenderer.invoke(IPC_REQUEST_CHANNEL, channel, params);
  },

  on(event, listener) {
    const wrapped = (_e: unknown, name: string, payload: unknown) => {
      if (name !== event) return;
      listener(payload as IpcEventPayload<typeof event>);
    };
    ipcRenderer.on(IPC_EVENT_CHANNEL, wrapped);
    return () => { ipcRenderer.removeListener(IPC_EVENT_CHANNEL, wrapped); };
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

export type { IpcChannel, IpcParams, IpcEventName };
