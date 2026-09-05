'use client';

/**
 * Who this browser is playing as, and whether the host has heard about it.
 *
 * A profile is a **name**, not an account: no password, no email, nothing to
 * reset. That is the whole design, and it is what makes the second device
 * possible — a cookie is per-browser by construction, so it can never make the
 * phone and the laptop the same game, while a name the laptop can *see in a
 * list* and pick can. On a tailnet-only household host a password would be
 * theatre; everyone who can reach the port is the household.
 *
 * The panel is deliberately quiet when there is nothing to say. A host with no
 * `SAVE_DIR` gets one sentence and no controls, because that is the state the
 * game has always been in and it is not a fault to report.
 */

import { useCallback, useEffect, useState } from 'react';
import { type MigrationOutcome, type SlotAction } from '@/lib/saves/plan';
import { type ProfileListing } from '@/lib/saves/shared';
import { saveSync } from '@/lib/saves/sync';
import { syncStatusLabel, useSaveSync } from '@/lib/saves/useSaveSync';
import { Icon, Panel, Tag } from '@/components/ui';
import type { Tone } from '@/components/ui/tokens';

export interface SaveProfilesProps {
  /** The game store's hydration flag: the panel must not render a remembered name during SSR. */
  readonly hydrated: boolean;
  /** True while a replay or a slot load is running; every control here locks with it. */
  readonly disabled: boolean;
  /** Called whenever the picker changed what the slots panel would show. */
  readonly onChanged: () => void;
}

const STATUS_TONE: Readonly<Record<string, Tone>> = {
  synced: 'gain',
  offline: 'warn',
  unsynced: 'warn',
  off: 'neutral',
  unknown: 'neutral',
};

/** One line about what the first reconciliation of a profile actually did. */
export function migrationLine(outcome: MigrationOutcome): string | null {
  const parts: string[] = [];
  if (outcome.uploaded.length > 0) parts.push(`${outcome.uploaded.length} sent to the host`);
  if (outcome.adopted.length > 0) parts.push(`${outcome.adopted.length} taken from it`);
  if (outcome.backedUp.length > 0) parts.push(`${outcome.backedUp.length} kept here as a backup`);
  if (outcome.blocked.length > 0) parts.push(`${outcome.blocked.length} left alone`);
  return parts.length === 0 ? null : `Saves reconciled: ${parts.join(', ')}.`;
}

/** What one slot's plan reads as on a row. Exported for the picker's own tests. */
export function slotActionLabel(action: SlotAction): string {
  switch (action) {
    case 'upload':
      return 'Only here';
    case 'adopt':
      return 'Newer on the host';
    case 'in_sync':
      return 'Synced';
    case 'blocked':
      return 'Preserved';
    default:
      return '';
  }
}

export function SaveProfiles({ hydrated, disabled, onChanged }: SaveProfilesProps): React.JSX.Element | null {
  const state = useSaveSync();
  const [listings, setListings] = useState<readonly ProfileListing[]>([]);
  const [picking, setPicking] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(false);

  const refreshListings = useCallback(async () => {
    const found = await saveSync().probe();
    setListings(found);
  }, []);

  // The host is asked once per visit. Everything after that is a reaction to
  // something the player did, so a landing page left open does not poll a Pi.
  useEffect(() => {
    if (!hydrated) return;
    void refreshListings();
  }, [hydrated, refreshListings]);

  const adopt = useCallback(
    async (name: string) => {
      setBusy(true);
      setRefused(false);
      try {
        if (!(await saveSync().chooseProfile(name))) {
          setRefused(true);
          return;
        }
        // Reconciled immediately, not on the next load: the player just told us
        // who they are, and the whole point is that the slots below now show
        // the game they started somewhere else.
        await saveSync().reconcile();
        setPicking(false);
        setTyped('');
        onChanged();
        await refreshListings();
      } finally {
        setBusy(false);
      }
    },
    [onChanged, refreshListings],
  );

  if (!hydrated) return null;

  const status = state.status;
  const migration = state.migration === null ? null : migrationLine(state.migration);
  const locked = disabled || busy;

  return (
    <Panel
      title="This device"
      subtitle={state.enabled ? 'Saves are kept here and on the host' : 'Saves are kept in this browser'}
      iconName="people"
      iconTone={state.enabled ? 'brand' : 'neutral'}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tag tone={STATUS_TONE[status] ?? 'neutral'} dot>
          {syncStatusLabel(state)}
        </Tag>
        {state.enabled && state.profile !== null ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm tap-target press-pop"
            onClick={() => setPicking((open) => !open)}
            disabled={locked}
            aria-expanded={picking}
          >
            <Icon name={picking ? 'chevronDown' : 'chevronRight'} size={15} />
            Switch profile
          </button>
        ) : null}
      </div>

      {!state.enabled ? (
        <p className="mt-2.5 text-[11.5px] leading-relaxed text-ink-faint">
          {status === 'offline'
            ? 'The host could not be reached, so this game is being saved in this browser. Nothing is lost — it syncs the next time the host answers.'
            : 'This host does not keep saves. Everything is stored in this browser, on this device, exactly as it always has been.'}
        </p>
      ) : (
        <>
          {state.profile === null ? (
            <p className="mt-2.5 text-[11.5px] leading-relaxed text-ink-dim">
              Pick a name and this device&rsquo;s saves go to the host under it. Any other device that picks the same name plays the same
              games.
            </p>
          ) : (
            <p className="mt-2.5 text-[12.5px] leading-relaxed text-ink">
              Playing as <span className="font-bold">{state.displayName ?? state.profile}</span>
              <span className="text-ink-faint"> · {state.profile}</span>
            </p>
          )}

          {migration === null ? null : <p className="mt-1.5 text-[10.5px] leading-relaxed text-ink-faint">{migration}</p>}
          {state.notice === null ? null : <p className="mt-1.5 text-[10.5px] leading-relaxed text-warn">{state.notice}</p>}

          {state.profile === null || picking ? (
            <div className="animate-rise mt-3 flex flex-col gap-2">
              {listings.length === 0 ? (
                <p className="text-[10.5px] leading-relaxed text-ink-faint">The host holds no profiles yet. Name this one.</p>
              ) : (
                <>
                  <span className="label-caps-faint px-1">On the host</span>
                  {listings.map((listing) => (
                    <button
                      key={listing.profile}
                      type="button"
                      className="btn tap-target press-pop justify-start"
                      disabled={locked || listing.profile === state.profile}
                      onClick={() => void adopt(listing.displayName)}
                    >
                      <Icon name="save" size={15} accent="brand" />
                      <span className="min-w-0 truncate text-left">
                        {listing.displayName}
                        <span className="text-ink-faint"> · {occupiedLine(listing)}</span>
                      </span>
                    </button>
                  ))}
                </>
              )}

              <label className="mt-1 flex flex-col gap-1">
                <span className="label-caps-faint px-1">Or a new name</span>
                <input
                  className="field"
                  value={typed}
                  maxLength={64}
                  placeholder="YC"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={locked}
                  onChange={(event) => {
                    setTyped(event.target.value);
                    setRefused(false);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && typed.trim().length > 0) void adopt(typed);
                  }}
                />
              </label>
              {refused ? (
                <p className="text-[10.5px] leading-relaxed text-warn">
                  That name leaves nothing to file it under. Use at least two letters or numbers.
                </p>
              ) : null}
              <button
                type="button"
                className="btn btn-primary tap-target press-pop"
                disabled={locked || typed.trim().length === 0}
                onClick={() => void adopt(typed)}
              >
                <Icon name="plus" size={15} accent="inherit" />
                {busy ? 'Setting up…' : 'Use this name'}
              </button>
              <p className="text-[10.5px] leading-relaxed text-ink-faint">
                This is not an account: no password, nothing to reset. It is only how the host files your saves, so that the laptop can pick
                up the game the phone started.
              </p>
            </div>
          ) : null}
        </>
      )}
    </Panel>
  );
}

/** How many of a listed profile's four slots hold something. */
function occupiedLine(listing: ProfileListing): string {
  const held = listing.slots.filter((slot) => slot.revision > 0);
  if (held.length === 0) return 'no saves';
  const names = new Set(held.map((slot) => slot.companyName).filter((name): name is string => name !== null));
  const first = names.values().next().value;
  return first === undefined ? `${held.length} saved` : `${first}${names.size > 1 ? ` +${names.size - 1}` : ''}`;
}
