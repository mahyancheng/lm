'use client';

/**
 * The sync layer, as React reads it.
 *
 * `createSaveSync` is a plain object with a subscribe/snapshot pair precisely so
 * that this file can be four lines of `useSyncExternalStore` and no state
 * mirroring: the sync layer is the store, and a component re-renders when it
 * says something changed. Copying its state into `useState` would give the app
 * two answers to "are we synced?" that could disagree.
 *
 * The server snapshot is the pre-probe state — nothing is known about a host
 * during a render that has no browser — so anything that would differ after
 * hydration must be gated on the game store's `hydrated`, exactly as the
 * `localStorage` panels on the landing page already are.
 */

import { useSyncExternalStore } from 'react';
import { PRE_PROBE_STATE, type SyncState, saveSync } from './sync';

function subscribe(listener: () => void): () => void {
  return saveSync().subscribe(listener);
}

function snapshot(): SyncState {
  return saveSync().snapshot();
}

function serverSnapshot(): SyncState {
  return PRE_PROBE_STATE;
}

export function useSaveSync(): SyncState {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}

/** What the chip says, in words a player reads. */
export function syncStatusLabel(state: SyncState): string {
  switch (state.status) {
    case 'off':
      return 'Saves on this device';
    case 'synced':
      return 'Synced';
    case 'offline':
      return 'Offline — saved here';
    case 'unsynced':
      return 'Not yet synced';
    default:
      return 'Checking…';
  }
}
