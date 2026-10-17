import { contextBridge, ipcRenderer } from 'electron'
import type { BuddyBridge, BuddyState } from '@shared/types'

const bridge: BuddyBridge = {
  onState(cb) {
    const listener = (_e: unknown, state: BuddyState): void => cb(state)
    ipcRenderer.on('buddy:state', listener)
    // Asked for once listening, so a state set before the page loaded is not lost.
    ipcRenderer.send('buddy:ready')
    return () => ipcRenderer.removeListener('buddy:state', listener)
  },
  click: () => ipcRenderer.send('buddy:click'),
  drag: (dx, dy, end) => ipcRenderer.send('buddy:drag', dx, dy, !!end),
  passThrough: (on) => ipcRenderer.send('buddy:pass-through', on)
}

contextBridge.exposeInMainWorld('buddy', bridge)
