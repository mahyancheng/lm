'use client';

/**
 * Session settings and the save file, in one sheet off the status bar.
 *
 * Two of these were previously state the player could read but never enter. End
 * Quarter renders a branch for "a model is configured but you have turned it off
 * for this session", and the Chief of Staff panel reports "Auto-execute routine:
 * On/Off" — both were fixed for the life of the session because nothing in the
 * interface set either. They are settings now.
 *
 * The save controls are the other half: a save is the seed, the decisions and
 * what the model contributed, so it is small enough to hand the player as text.
 * Import validates before it writes — a file that will not parse never replaces
 * one that does — and a replay that does not finish leaves the stored file
 * exactly as it was.
 */

import { useState } from 'react';
import { Drawer, Tag, cx } from '@/components/ui';
import { useGame, useGameActions, useLlm, useLoading, useSettings } from '@/lib/game';

export interface SettingsDrawerProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

function Toggle({
  label,
  hint,
  value,
  disabled = false,
  onChange,
}: {
  readonly label: string;
  readonly hint: string;
  readonly value: boolean;
  readonly disabled?: boolean;
  readonly onChange: (next: boolean) => void;
}): React.JSX.Element {
  return (
    <div className="raised-surface flex items-start justify-between gap-3 px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-[12px] font-medium text-ink">{label}</p>
        <p className="mt-0.5 text-[10px] leading-relaxed text-ink-dim">{hint}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!value)}
        className={cx('btn btn-sm shrink-0', value ? 'border-brand/50 bg-brand-wash text-brand' : '')}
      >
        {value ? 'On' : 'Off'}
      </button>
    </div>
  );
}

export function SettingsDrawer({ open, onClose }: SettingsDrawerProps): React.JSX.Element {
  const { actionLog, saveWritable } = useGame();
  const settings = useSettings();
  const llm = useLlm();
  const { loading, progress } = useLoading();
  const { updateSettings, saveGame, loadGame, deleteSave, exportSave, importSave, refreshLlmHealth } = useGameActions();

  const [exported, setExported] = useState<string | null>(null);
  const [importText, setImportText] = useState('');
  const [showImport, setShowImport] = useState(false);

  return (
    <Drawer open={open} onClose={onClose} title="Session settings" subtitle="Preferences and the save file, both local to this browser">
      <div className="flex flex-col gap-4">
        {/* --- preferences ------------------------------------------------- */}
        <section className="flex flex-col gap-2">
          <div className="label-caps">Preferences</div>
          <Toggle
            label="Use the live model"
            hint={
              llm.available
                ? `A model is configured (${llm.model ?? llm.transportKind}). Turn this off for a fully deterministic quarter: world events fire on their templates and rivals run their archetype defaults.`
                : 'No model is configured, so every role already uses its deterministic fallback.'
            }
            value={settings.useLiveModel}
            disabled={!llm.available}
            onChange={(next) => updateSettings({ useLiveModel: next })}
          />
          <Toggle
            label="Auto-execute routine instructions"
            hint="Lets the Chief of Staff queue low-risk interpreted instructions without a click. Never applies to the thirteen that always require an explicit human confirmation."
            value={settings.autoExecuteRoutine}
            onChange={(next) => updateSettings({ autoExecuteRoutine: next })}
          />
          <Toggle
            label="Skip the resolution reveal"
            hint="Jump straight to the finished report instead of revealing it phase by phase."
            value={settings.skipResolutionReveal}
            onChange={(next) => updateSettings({ skipResolutionReveal: next })}
          />
          <div className="flex items-center justify-between gap-2 px-1">
            <span className="text-[10px] text-ink-dim">
              Model status: <Tag tone={llm.available ? 'gain' : 'neutral'} dot>{llm.available ? 'live' : 'offline'}</Tag>
            </span>
            <button type="button" className="btn btn-sm" onClick={() => void refreshLlmHealth()}>
              Re-check
            </button>
          </div>
        </section>

        {/* --- the save ----------------------------------------------------- */}
        <section className="flex flex-col gap-2 border-t border-hair pt-3.5">
          <div className="label-caps">Saved session</div>
          <p className="text-[11px] leading-relaxed text-ink-dim">
            {actionLog.length} resolved quarter{actionLog.length === 1 ? '' : 's'} recorded. A save holds the seed, your decisions and what
            the World Director and the rival strategists contributed — not the world, which is re-resolved from them.
          </p>
          {!saveWritable ? (
            <p className="rounded-[4px] border border-warn/25 bg-warn-wash px-3 py-2 text-[11px] text-warn">
              This session is not being written to disk: the stored save could not be replayed in full, so it is being preserved exactly as
              it is. Start a new session to save again.
            </p>
          ) : null}
          {loading ? (
            <p className="text-[11px] text-ink-dim">
              {progress === null ? 'Replaying…' : `Replaying quarter ${progress.quarter} — ${progress.completed} of ${progress.total}`}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-1.5">
            <button type="button" className="btn btn-sm" onClick={saveGame} disabled={loading}>
              Save now
            </button>
            <button type="button" className="btn btn-sm" onClick={() => void loadGame()} disabled={loading}>
              Load save
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setExported(exportSave() ?? '')} disabled={loading}>
              Export
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setShowImport((value) => !value)} disabled={loading}>
              Import
            </button>
            <button type="button" className="btn btn-sm btn-danger" onClick={deleteSave} disabled={loading}>
              Delete save
            </button>
          </div>

          {exported !== null ? (
            <label className="block">
              <span className="label-caps-faint">
                {exported === '' ? 'Nothing saved in this browser yet' : 'Copy this somewhere safe'}
              </span>
              <textarea className="field mt-1 font-mono text-[10px]" rows={5} readOnly value={exported} spellCheck={false} />
            </label>
          ) : null}

          {showImport ? (
            <div>
              <label className="block">
                <span className="label-caps-faint">Paste an exported save</span>
                <textarea
                  className="field mt-1 font-mono text-[10px]"
                  rows={5}
                  value={importText}
                  onChange={(event) => setImportText(event.target.value)}
                  spellCheck={false}
                  placeholder='{"version":2,"seed":424242,…}'
                />
              </label>
              <button
                type="button"
                className="btn btn-primary btn-sm mt-1.5"
                disabled={importText.trim().length === 0 || loading}
                onClick={() => {
                  void importSave(importText).then((ok) => {
                    if (ok) {
                      setImportText('');
                      setShowImport(false);
                    }
                  });
                }}
              >
                Replace and load
              </button>
            </div>
          ) : null}
        </section>
      </div>
    </Drawer>
  );
}
