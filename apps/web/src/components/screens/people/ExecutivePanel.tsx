'use client';

/**
 * Executives: who holds a post here, and how to change that.
 *
 * Two tickets. **Poach** makes an approach to somebody at another company — an
 * attempt, decided by the target, with the engine's own `poachProbability`
 * shown before it is sent. **Appoint** fills a C-suite post, which is a
 * governance matter: the validator clamps it into a `csuite_appointment` board
 * proposal, and the banner says so in those words.
 *
 * The connection rule is enforced by the engine and explained here. A private
 * approach to somebody far above the founder's connection level is refused with
 * the gap stated; a public approach is still available and the target's employer
 * remembers it either way.
 */

import { useMemo, useState } from 'react';
import type {
  ActionValidationResult,
  Approach,
  Character,
  Company,
  ExecutiveRole,
  PlayerView,
  SessionState,
} from '@frontier/contracts';
import { EXECUTIVE_ROLES } from '@frontier/contracts';
import { checkAccess, poachProbability } from '@frontier/simulation';
import { formatMoney, formatPct, formatScore } from '@frontier/shared';
import {
  AccessBadge,
  EmptyState,
  Icon,
  Meter,
  Panel,
  PersonChip,
  SectionHeading,
  SliderField,
  Tag,
  ValidationBanner,
  roundStep,
} from '@/components/ui';
import { useGameActions } from '@/lib/game';

export interface ExecutivePanelProps {
  readonly session: SessionState;
  readonly company: Company;
  readonly founder: Character;
  readonly view: PlayerView;
}

const EXEC_ROLE_LABEL: Readonly<Record<ExecutiveRole, string>> = {
  ceo: 'Chief executive',
  cto: 'Chief technology officer',
  cfo: 'Chief financial officer',
  coo: 'Chief operating officer',
  chief_scientist: 'Chief scientist',
  chief_revenue: 'Chief revenue officer',
  general_counsel: 'General counsel',
  chief_security: 'Chief security officer',
};

/** Roles worth approaching: the people who run and build other companies. */
const POACHABLE_ROLES = new Set(['founder_ceo', 'executive', 'researcher']);

export function ExecutivePanel({ session, company, founder, view }: ExecutivePanelProps): React.JSX.Element {
  const { queueAction, validateIntent } = useGameActions();

  const [targetId, setTargetId] = useState('');
  const [premium, setPremium] = useState(0.4);
  const [approach, setApproach] = useState<Approach>('private');
  const [poachResult, setPoachResult] = useState<ActionValidationResult | null>(null);

  const [appointId, setAppointId] = useState('');
  const [appointRole, setAppointRole] = useState<ExecutiveRole>('cto');
  const [appointComp, setAppointComp] = useState('400000');
  const [appointResult, setAppointResult] = useState<ActionValidationResult | null>(null);

  const employerName = useMemo(() => {
    const names = new Map<string, string>();
    for (const rival of view.visibleCompanies) {
      if (rival.id !== undefined && rival.name !== undefined) names.set(rival.id, rival.name);
    }
    names.set(company.id, company.name);
    return names;
  }, [view.visibleCompanies, company]);

  const ownStaff = useMemo(
    () => session.characters.filter((character) => character.companyId === company.id && character.isActive),
    [session.characters, company.id],
  );

  const candidates = useMemo(
    () =>
      session.characters
        .filter((character) => character.isActive && character.companyId !== company.id && POACHABLE_ROLES.has(character.role))
        .sort((a, b) => b.connectionLevel - a.connectionLevel),
    [session.characters, company.id],
  );

  const target = candidates.find((character) => character.id === targetId) ?? null;
  const access = target === null ? null : checkAccess(session, founder.id, target.id);
  const probability =
    target === null ? null : poachProbability(session, company, target.id, founder.id, premium, approach);

  const poachPreview =
    target === null
      ? null
      : validateIntent({ type: 'poach_executive', targetCharacterId: target.id, compPremiumPct: premium, approach });

  function sendApproach(): void {
    if (target === null) return;
    const entry = queueAction({ type: 'poach_executive', targetCharacterId: target.id, compPremiumPct: premium, approach });
    setPoachResult(entry.validation);
  }

  const appointCompValue = Number.parseFloat(appointComp);
  const appointCompMax = Math.max(
    Math.min(company.financials.cash * 4, 20_000_000),
    Number.isFinite(appointCompValue) ? appointCompValue : 0,
    1_000_000,
  );
  const appointPreview =
    appointId.length === 0 || !Number.isFinite(appointCompValue)
      ? null
      : validateIntent({ type: 'appoint_executive', characterId: appointId, executiveRole: appointRole, annualCompUsd: appointCompValue });

  function sendAppointment(): void {
    if (appointId.length === 0 || !Number.isFinite(appointCompValue)) return;
    const entry = queueAction({ type: 'appoint_executive', characterId: appointId, executiveRole: appointRole, annualCompUsd: appointCompValue });
    setAppointResult(entry.validation);
  }

  return (
    <Panel title="Executives" iconName="briefcase" subtitle="Who holds a post here, and the two ways that changes">
      <SectionHeading rule>In post</SectionHeading>
      <div className="mt-2 space-y-1.5">
        {ownStaff.length === 0 ? (
          <EmptyState compact icon="briefcase" title="No named leadership" message="Nobody in this session holds a C-suite post at this company." />
        ) : (
          ownStaff.map((character) => (
            <PersonChip
              key={character.id}
              character={character}
              className="tap-target"
              subtitle={character.title}
              right={
                <div className="flex items-center gap-2">
                  <span
                    className="figure flex items-center gap-1 text-[11px] text-ink-faint"
                    title={`Connection level ${formatScore(character.connectionLevel)}`}
                  >
                    <Icon name="network" size={13} accent="current" />
                    {formatScore(character.connectionLevel)}
                  </span>
                  {character.id === company.ceoCharacterId ? <Tag tone="brand">CEO</Tag> : null}
                </div>
              }
            />
          ))
        )}
      </div>

      <div className="mt-4 border-t border-hair pt-3">
        <SectionHeading>Approach someone</SectionHeading>
        <p className="mt-1.5 text-[11.5px] text-ink-faint">
          An approach, not an appointment. The target decides, from their traits, their relationships and their memory of how you have behaved.
        </p>

        <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2">
          <label className="block">
            <span className="label-caps-faint mb-1 block">Target</span>
            <select className="field tap-target" value={targetId} onChange={(event) => setTargetId(event.target.value)}>
              <option value="">Select a person…</option>
              {candidates.map((character) => (
                <option key={character.id} value={character.id}>
                  {character.name} — {employerName.get(character.companyId ?? '') ?? 'independent'}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label-caps-faint mb-1 block">Approach</span>
            <select className="field tap-target" value={approach} onChange={(event) => setApproach(event.target.value as Approach)}>
              <option value="private">Private — discreet and slower</option>
              <option value="public">Public — faster, and a fight</option>
            </select>
          </label>
        </div>

        <div className="mt-2.5">
          <SliderField
            label="Compensation premium"
            value={premium}
            onChange={setPremium}
            min={0}
            max={2}
            step={0.05}
            format={formatPct}
            exact={false}
          />
        </div>

        {target === null ? null : (
          <div className="raised-surface mt-2.5 px-3 py-2.5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <PersonChip character={target} subtitle={target.title} size="sm" className="max-w-[60%]" />
              {access === null ? null : (
                <AccessBadge state={access.allowed ? (access.overrideId === null ? 'open' : 'override') : 'blocked'} gap={Math.round(access.gap)} />
              )}
            </div>
            {access === null ? null : <p className="mt-2 text-[12px] text-ink-dim">{access.reason}</p>}
            {probability === null ? null : (
              <div className="mt-2.5">
                <Meter value={probability * 100} label="Probability the approach succeeds" />
              </div>
            )}
            {!(access?.allowed ?? true) && approach === 'private' ? (
              <p className="mt-2 text-[11.5px] text-warn">
                A private approach is out of reach at this connection gap. A public approach is still possible, and their employer will remember it.
              </p>
            ) : null}
          </div>
        )}

        <div className="mt-2.5 flex justify-end">
          <button
            type="button"
            className="btn btn-primary tap-target w-full gap-1.5 sm:w-auto"
            disabled={target === null}
            onClick={sendApproach}
          >
            <Icon name="handshake" size={16} accent="current" />
            Queue approach
          </button>
        </div>

        {poachResult === null && poachPreview !== null ? (
          <div className="mt-2">
            <ValidationBanner result={poachPreview} compact />
          </div>
        ) : null}
        {poachResult === null ? null : (
          <div className="mt-2">
            <ValidationBanner result={poachResult} />
          </div>
        )}
      </div>

      <div className="mt-4 border-t border-hair pt-3">
        <SectionHeading>Appoint to a post</SectionHeading>
        <p className="mt-1.5 text-[11.5px] text-ink-faint">
          A C-suite appointment is a governance matter. The validator tables it as a board proposal rather than executing it, and the board votes.
        </p>

        <div className="mt-2.5 grid gap-2.5 sm:grid-cols-3">
          <label className="block sm:col-span-2">
            <span className="label-caps-faint mb-1 block">Person</span>
            <select className="field tap-target" value={appointId} onChange={(event) => setAppointId(event.target.value)}>
              <option value="">Select a person…</option>
              {ownStaff.map((character) => (
                <option key={character.id} value={character.id}>
                  {character.name} — already employed
                </option>
              ))}
              {candidates.map((character) => (
                <option key={character.id} value={character.id}>
                  {character.name} — {employerName.get(character.companyId ?? '') ?? 'independent'}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label-caps-faint mb-1 block">Post</span>
            <select className="field tap-target" value={appointRole} onChange={(event) => setAppointRole(event.target.value as ExecutiveRole)}>
              {EXECUTIVE_ROLES.map((role) => (
                <option key={role} value={role}>
                  {EXEC_ROLE_LABEL[role]}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-2.5">
          {/* The appoint rule charges one quarter of the package against
              uncommitted cash, so four times cash is the honest ceiling. */}
          <SliderField
            label="Annual compensation"
            value={Number.isFinite(appointCompValue) ? appointCompValue : 0}
            onChange={(next) => setAppointComp(String(next))}
            min={0}
            max={appointCompMax}
            step={roundStep(appointCompMax)}
            format={formatMoney}
          />
          <span className="mt-1 block text-[11px] text-ink-faint">A year — the first quarter is charged against uncommitted cash.</span>
        </div>

        <div className="mt-2.5 flex justify-end">
          <button
            type="button"
            className="btn tap-target w-full gap-1.5 sm:w-auto"
            disabled={appointPreview === null}
            onClick={sendAppointment}
          >
            <Icon name="boardTable" size={16} accent="current" />
            Table the appointment
          </button>
        </div>

        {appointResult === null && appointPreview !== null ? (
          <div className="mt-2">
            <ValidationBanner result={appointPreview} compact />
          </div>
        ) : null}
        {appointResult === null ? null : (
          <div className="mt-2">
            <ValidationBanner result={appointResult} />
          </div>
        )}
      </div>
    </Panel>
  );
}
