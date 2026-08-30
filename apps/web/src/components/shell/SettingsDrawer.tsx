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
 *
 * The third, and the reason this sheet is now the first thing an "Offline" chip
 * points at: **the Claude credential**. `claude setup-token` prints a token,
 * and until it could be pasted here the only way to give it to the game was to
 * edit a dotfile and restart a dev server — a step that quietly decided most
 * players would never see a live model at all. The token goes to the server and
 * never comes back; what this sheet shows is its last four characters.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Drawer, Tag, cx } from '@/components/ui';
import { useGame, useGameActions, useLlm, useLoading, useSettings } from '@/lib/game';
import {
  type TokenFetch,
  type TokenStatus,
  connectToken,
  disconnectToken,
  fetchTokenStatus,
  testToken,
  tokenDraftIssue,
} from '@/lib/llm/token';
import { resetLlmHealth } from '@/lib/llm/client';
import type { SettingsSection } from './settingsBus';
import {
  NO_SERVER_LINE,
  credentialLine,
  refusalLine,
  sourceChip,
  statusHeadline,
  testResultLine,
  tokenPanelState,
  transportLabel,
} from './tokenSetup';

export interface SettingsDrawerProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Which section to scroll to on open. Set when the sheet was opened from an "Offline" affordance. */
  readonly focus?: SettingsSection | null;
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
    <div className="raised-surface flex items-start justify-between gap-3 px-3.5 py-3">
      <div className="min-w-0">
        <p className="text-[12px] font-semibold text-ink">{label}</p>
        <p className="mt-0.5 text-[10px] leading-relaxed text-ink-dim">{hint}</p>
      </div>
      {/* A real switch: a pill track and a knob that slides. Transform only. */}
      <button
        type="button"
        role="switch"
        aria-checked={value}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!value)}
        className={cx(
          'tap-target -my-2 flex shrink-0 items-center justify-center rounded-chip',
          disabled ? 'cursor-not-allowed opacity-45' : 'cursor-pointer',
        )}
      >
        <span
          aria-hidden="true"
          className={cx(
            'flex h-6 w-11 items-center rounded-pill border transition-colors',
            value ? 'border-brand-strong bg-brand-strong' : 'border-hair-strong bg-raised',
          )}
        >
          <span
            className={cx(
              'block size-4 rounded-pill bg-panel shadow-card transition-transform',
              value ? 'translate-x-[22px]' : 'translate-x-[3px]',
            )}
          />
        </span>
        <span className="sr-only">{value ? 'On' : 'Off'}</span>
      </button>
    </div>
  );
}

/** Tone of the one-line outcome under the Claude controls. */
type NoticeTone = 'gain' | 'loss' | 'neutral';

const NOTICE_CLASS: Record<NoticeTone, string> = {
  gain: 'border-gain/25 bg-gain-wash text-gain',
  loss: 'border-loss/25 bg-loss-wash text-loss',
  neutral: 'border-hair bg-raised text-ink-dim',
};

/** The three steps, written for somebody who has never opened a terminal for this app. */
const SETUP_STEPS: readonly { readonly step: string; readonly detail: string }[] = [
  { step: 'Install Claude Code', detail: 'npm i -g @anthropic-ai/claude-code — then sign in with your Claude subscription.' },
  { step: 'Run claude setup-token', detail: 'It prints one long token. That token is the whole credential.' },
  { step: 'Paste it below', detail: 'It goes straight to this server and is never stored in the browser or written to disk.' },
];

/**
 * The Claude credential, end to end: what is in force, how to get one, and how
 * to prove it works.
 *
 * Every write goes to the server and the server answers with a descriptor, so
 * this component never holds a credential for longer than the keystrokes it
 * takes to paste one. `resetLlmHealth()` after every mutation is what makes the
 * status-bar dot change without a reload.
 */
function ClaudeSection({
  focus,
  onChanged,
}: {
  readonly focus: boolean;
  readonly onChanged: () => void;
}): React.JSX.Element {
  const [fetched, setFetched] = useState<TokenFetch<TokenStatus> | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<'connect' | 'disconnect' | 'test' | null>(null);
  const [notice, setNotice] = useState<{ readonly tone: NoticeTone; readonly text: string } | null>(null);
  const anchor = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    setFetched(await fetchTokenStatus());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (focus) anchor.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [focus]);

  /** Every mutation ends the same way: re-read the descriptor, drop the health memo. */
  const settle = useCallback(async () => {
    resetLlmHealth();
    await load();
    onChanged();
  }, [load, onChanged]);

  const panel = tokenPanelState(fetched);
  const status = panel.status;
  const trimmed = draft.trim();
  const draftIssue = tokenDraftIssue(draft);

  async function connect(): Promise<void> {
    if (trimmed.length === 0 || draftIssue !== null || busy !== null) return;
    setBusy('connect');
    setNotice(null);
    const result = await connectToken(trimmed);
    if (result.kind === 'ok' && result.value.ok) {
      setDraft('');
      setNotice({ tone: 'gain', text: `Connected. Roles now run on the ${transportLabel(result.value.transportKind)}.` });
      await settle();
    } else if (result.kind === 'refused') {
      setNotice({ tone: 'loss', text: refusalLine(result.status, result.reason) });
    } else {
      setNotice({ tone: 'loss', text: NO_SERVER_LINE });
    }
    setBusy(null);
  }

  async function disconnect(): Promise<void> {
    if (busy !== null) return;
    setBusy('disconnect');
    setNotice(null);
    const result = await disconnectToken();
    if (result.kind === 'ok' && result.value.ok) {
      setNotice({ tone: 'neutral', text: 'Disconnected. Whatever the environment supplies takes over again.' });
      await settle();
    } else if (result.kind === 'refused') {
      setNotice({ tone: 'loss', text: refusalLine(result.status, result.reason) });
    } else {
      setNotice({ tone: 'loss', text: NO_SERVER_LINE });
    }
    setBusy(null);
  }

  async function test(): Promise<void> {
    if (busy !== null) return;
    setBusy('test');
    setNotice(null);
    const result = await testToken();
    if (result.kind === 'ok') {
      setNotice({ tone: result.value.ok ? 'gain' : 'loss', text: testResultLine(result.value) });
      resetLlmHealth();
      onChanged();
    } else if (result.kind === 'refused') {
      setNotice({ tone: 'loss', text: refusalLine(result.status, result.reason) });
    } else {
      setNotice({ tone: 'loss', text: NO_SERVER_LINE });
    }
    setBusy(null);
  }

  const chip = status === null ? null : sourceChip(status.source);

  return (
    <section ref={anchor} className="flex flex-col gap-2 scroll-mt-2">
      <div className="label-caps">AI · Claude</div>

      {/* --- what is in force -------------------------------------------- */}
      <div className="raised-surface flex flex-col gap-1.5 px-3.5 py-3">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-[12px] font-semibold text-ink">
            <span
              aria-hidden="true"
              className={cx('inline-block size-1.5 rounded-full', status?.available === true ? 'bg-gain pulse-dot' : 'bg-ink-faint')}
            />
            {panel.phase === 'loading' ? 'Checking…' : statusHeadline(status)}
          </span>
          {status === null ? null : <Tag tone={status.available ? 'gain' : 'neutral'}>{transportLabel(status.transportKind)}</Tag>}
        </div>
        {status === null ? null : (
          <div className="flex items-center justify-between gap-2">
            <span className="figure truncate text-[10.5px] text-ink-dim">{credentialLine(status)}</span>
            {chip === null ? null : <Tag tone={status.source === 'runtime' ? 'brand' : 'neutral'}>{chip}</Tag>}
          </div>
        )}
      </div>

      {/* --- the phases --------------------------------------------------- */}
      {panel.phase === 'no-server' || panel.phase === 'restricted' ? (
        <p className="px-1 text-[10.5px] leading-relaxed text-ink-faint">{panel.message}</p>
      ) : null}

      {panel.phase === 'unconfigured' ? (
        <>
          <ol className="flex flex-col gap-1.5">
            {SETUP_STEPS.map((entry, index) => (
              <li key={entry.step} className="flex items-start gap-2.5">
                <span className="figure mt-px flex size-4 shrink-0 items-center justify-center rounded-pill bg-brand-wash text-[9px] font-bold text-brand">
                  {index + 1}
                </span>
                <span className="min-w-0">
                  <span className="block text-[11.5px] font-semibold text-ink">{entry.step}</span>
                  <span className="block text-[10px] leading-relaxed text-ink-faint">{entry.detail}</span>
                </span>
              </li>
            ))}
          </ol>
          <label className="block">
            <span className="label-caps-faint">Paste the token</span>
            <input
              type="password"
              className="field mt-1 font-mono text-[10px]"
              value={draft}
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-ant-oat01-…"
              aria-label="Claude credential"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void connect();
              }}
            />
          </label>
          {draftIssue === null ? null : <p className="px-1 text-[10px] text-warn">{draftIssue}</p>}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={trimmed.length === 0 || draftIssue !== null || busy !== null}
              onClick={() => void connect()}
            >
              {busy === 'connect' ? 'Connecting…' : 'Connect'}
            </button>
            <span className="text-[10px] text-ink-faint">An sk-ant-api… key switches to the metered API instead.</span>
          </div>
        </>
      ) : null}

      {panel.phase === 'configured' ? (
        <div className="flex flex-wrap gap-1.5">
          <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void test()}>
            {busy === 'test' ? 'Testing…' : 'Test connection'}
          </button>
          {status?.source === 'runtime' ? (
            <button type="button" className="btn btn-sm btn-danger" disabled={busy !== null} onClick={() => void disconnect()}>
              {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
            </button>
          ) : null}
          <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void load()}>
            Re-check
          </button>
        </div>
      ) : null}

      {panel.phase === 'configured' && status?.source === 'env' ? (
        <p className="px-1 text-[10px] leading-relaxed text-ink-faint">
          This credential comes from the server environment. Clear the variable there to change it, or paste a token to override it for
          this process.
        </p>
      ) : null}

      {notice === null ? null : (
        <p className={cx('rounded-card border px-3.5 py-2.5 text-[10.5px] leading-relaxed', NOTICE_CLASS[notice.tone])}>{notice.text}</p>
      )}

      {panel.phase === 'configured' || panel.phase === 'unconfigured' ? (
        <p className="px-1 text-[10px] leading-relaxed text-ink-faint">
          A token pasted here lives in this server process only. That is the right answer for <span className="figure">pnpm dev</span> on
          your own machine; a multi-instance deployment needs <span className="figure">CLAUDE_CODE_OAUTH_TOKEN</span> in the environment
          instead.
        </p>
      ) : null}
    </section>
  );
}

export function SettingsDrawer({ open, onClose, focus = null }: SettingsDrawerProps): React.JSX.Element {
  const { actionLog, saveWritable } = useGame();
  const settings = useSettings();
  const llm = useLlm();
  const { loading, progress } = useLoading();
  const { updateSettings, saveGame, loadGame, deleteSave, exportSave, importSave, refreshLlmHealth } = useGameActions();

  const [exported, setExported] = useState<string | null>(null);
  const [importText, setImportText] = useState('');
  const [showImport, setShowImport] = useState(false);

  return (
    <Drawer open={open} onClose={onClose} title="Session settings" subtitle="Claude, preferences and the save file">
      <div className="flex flex-col gap-4">
        {/* --- the credential ----------------------------------------------- */}
        {open ? <ClaudeSection focus={focus === 'ai'} onChanged={() => void refreshLlmHealth()} /> : null}

        {/* --- preferences ------------------------------------------------- */}
        <section className="flex flex-col gap-2 border-t border-hair pt-3.5">
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
            <p className="rounded-card border border-warn/25 bg-warn-wash px-3.5 py-2.5 text-[11px] text-warn">
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
