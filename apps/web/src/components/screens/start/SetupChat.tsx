'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { type NewGameSetup, type SetupProposal } from '@frontier/contracts';
import { Icon, cx } from '@/components/ui';
import { isIconName } from '@/components/ui/icons';
import { requestSetupProposal } from '@/lib/llm/client';
import {
  EMPTY_SETUP_PROPOSAL,
  SETUP_NAME_MAX,
  applySetupChoice,
  mergeSetupProposals,
  parseSetupMessage,
  setupFromProposal,
  setupQuickReplies,
  type SetupQuickReply,
} from '@/lib/game';

export interface SetupChatProps {
  readonly busy: boolean;
  readonly llmAvailable: boolean;
  readonly onFound: (setup: NewGameSetup) => void;
  readonly advanced?: ReactNode;
}

const SECTOR_INTRO: Record<string, { mark: string; line: string }> = {
  'AI & Software': { mark: '∿', line: 'Models, tools, and the infrastructure beneath them.' },
  Manufacturing: { mark: '▧', line: 'Make harder things, faster, with a real factory behind you.' },
  Energy: { mark: '☼', line: 'Sell power, storage, and the systems that keep cities moving.' },
  Robotics: { mark: '✣', line: 'Put intelligence into machines that work in the physical world.' },
  Logistics: { mark: '↗', line: 'Move goods, fleets, and information through a crowded world.' },
  Consumer: { mark: '●', line: 'Win attention, trust, and the daily habits of millions.' },
};

function sectorCopy(chip: SetupQuickReply): { mark: string; line: string } {
  return SECTOR_INTRO[chip.label] ?? { mark: '◆', line: chip.hint };
}

/** A deliberately low-friction founding route. It never depends on a model. */
export function SetupChat({ busy, llmAvailable, onFound, advanced }: SetupChatProps): React.JSX.Element {
  const [proposal, setProposal] = useState<SetupProposal>(EMPTY_SETUP_PROPOSAL);
  const [companyName, setCompanyName] = useState('');
  const [founderName, setFounderName] = useState('');
  const [moreOpen, setMoreOpen] = useState(false);
  const [identityOpen, setIdentityOpen] = useState(false);
  const [brief, setBrief] = useState('');
  const [readingBrief, setReadingBrief] = useState(false);
  const sectors = useMemo(() => setupQuickReplies('sector', proposal), [proposal]);
  const regions = useMemo(() => setupQuickReplies('region', proposal), [proposal]);
  const openings = useMemo(() => setupQuickReplies('backgroundId', proposal), [proposal]);
  const selectedSector = sectors.find((chip) => chip.value === proposal.sector) ?? null;

  const completeProposal = useMemo(() => {
    let next = proposal;
    if (companyName.trim()) next = applySetupChoice(next, 'companyName', companyName.trim().slice(0, SETUP_NAME_MAX));
    if (founderName.trim()) next = applySetupChoice(next, 'founderName', founderName.trim().slice(0, SETUP_NAME_MAX));
    return next;
  }, [proposal, companyName, founderName]);
  const setup = useMemo(() => setupFromProposal(completeProposal), [completeProposal]);
  const chosenRegion = setup === null ? null : regions.find((chip) => chip.value === setup.region) ?? null;
  const chosenOpening = setup === null ? null : openings.find((chip) => chip.value === setup.backgroundId) ?? null;

  function choose(chip: SetupQuickReply): void {
    if (!busy) setProposal((current) => applySetupChoice(current, chip.slot, chip.value));
  }

  async function applyBrief(): Promise<void> {
    const text = brief.trim();
    if (!text || busy || readingBrief) return;
    setReadingBrief(true);
    const deterministic = parseSetupMessage(text, proposal);
    setProposal(deterministic);
    if (llmAvailable) {
      try {
        const interpreted = await requestSetupProposal(text, [], deterministic);
        if (interpreted !== null) setProposal((current) => mergeSetupProposals(current, interpreted));
      } catch {
        // A creative brief still works when a connected model is unavailable.
      }
    }
    setReadingBrief(false);
  }

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="rounded-card border border-hair bg-raised p-3 sm:p-4">
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <p className="label-caps-faint">01 · Choose your arena</p>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-dim">Pick the arena for your first company. The world will build around it.</p>
          </div>
          <span className="hidden text-[11px] font-semibold text-brand sm:block">Six ways in</span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {sectors.map((chip) => {
            const copy = sectorCopy(chip);
            const active = proposal.sector === chip.value;
            return (
              <button key={chip.value} type="button" disabled={busy} aria-pressed={active} onClick={() => choose(chip)} className={cx(
                'press-pop min-h-[118px] rounded-card border p-3 text-left transition-colors',
                active ? 'border-brand bg-brand-wash shadow-card' : 'border-hair bg-panel hover:border-brand',
              )}>
                <span className={cx('flex size-7 items-center justify-center rounded-pill text-[17px] font-bold', active ? 'bg-brand text-white' : 'bg-base text-brand')} aria-hidden="true">{copy.mark}</span>
                <span className="mt-2 block text-[12.5px] font-bold text-ink">{chip.label}</span>
                <span className="mt-1 block text-[10.5px] leading-snug text-ink-faint">{copy.line}</span>
              </button>
            );
          })}
        </div>
      </div>

      {selectedSector !== null ? (
        <div className="animate-rise rounded-card border border-brand bg-brand-wash p-3 sm:p-4">
          <div className="flex items-start gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-pill bg-brand text-[17px] font-bold text-white" aria-hidden="true">{sectorCopy(selectedSector).mark}</span>
            <div className="min-w-0">
              <p className="label-caps-faint text-brand">02 · Give it a name</p>
              <h3 className="mt-0.5 font-display text-[20px] leading-tight text-ink">A {selectedSector.label} company is taking shape.</h3>
            </div>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <label className="block"><span className="label-caps-faint">Company</span><input className="field mt-1 min-h-11" value={companyName || proposal.companyName || ''} maxLength={SETUP_NAME_MAX} placeholder="e.g. Kestrel Works" disabled={busy} onChange={(event) => setCompanyName(event.target.value)} /></label>
            <label className="block"><span className="label-caps-faint">Founder</span><input className="field mt-1 min-h-11" value={founderName || proposal.founderName || ''} maxLength={SETUP_NAME_MAX} placeholder="e.g. Rae Fontaine" disabled={busy} onChange={(event) => setFounderName(event.target.value)} /></label>
          </div>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <button type="button" className="btn btn-ghost tap-target press-pop justify-start" onClick={() => setIdentityOpen((open) => !open)} aria-expanded={identityOpen}>
              <Icon name={identityOpen ? 'chevronDown' : 'chevronRight'} size={15} accent="brand" />{identityOpen ? 'Hide founding details' : 'Choose a city and opening'}
            </button>
            <button type="button" className="icon-knockout-brand btn btn-primary btn-lg tap-target press-pop" disabled={busy || setup === null} onClick={() => setup !== null && onFound(setup)}>
              <Icon name="playMark" size={17} accent="inherit" />Open the doors
            </button>
          </div>
          {identityOpen ? <div className="animate-rise mt-3 grid gap-3 border-t border-brand/20 pt-3 sm:grid-cols-2">
            <ChoiceRow title="Headquarters" chips={regions} selected={proposal.region} onChoose={choose} busy={busy} />
            <ChoiceRow title="First advantage" chips={openings} selected={proposal.backgroundId} onChoose={choose} busy={busy} />
          </div> : null}
          {setup === null ? <p className="mt-2 text-[10.5px] leading-relaxed text-ink-faint">Add a company and founder name to open the doors.</p> : <p className="mt-2 text-[10.5px] leading-relaxed text-ink-faint">Opening in <strong className="text-ink">{chosenRegion?.label ?? setup.region}</strong> as <strong className="text-ink">{chosenOpening?.label ?? setup.backgroundId}</strong>. Change either above before launch.</p>}
        </div>
      ) : <p className="px-1 text-[11.5px] text-ink-faint">Your first choice sets the tone. Everything else can be changed before launch.</p>}

      <div className="border-t border-hair pt-3">
        <button type="button" className="btn btn-ghost tap-target press-pop w-full justify-between" onClick={() => setMoreOpen((open) => !open)} aria-expanded={moreOpen}>
          <span className="flex items-center gap-2"><Icon name="settings" size={15} accent="brand" />Creative setup, seed & difficulty</span><Icon name={moreOpen ? 'chevronDown' : 'chevronRight'} size={15} />
        </button>
        {moreOpen ? <div className="animate-rise mt-3 space-y-4">
          <div className="rounded-card border border-hair bg-raised p-3">
            <label className="label-caps-faint" htmlFor="founding-brief">Start from a brief</label>
            <textarea id="founding-brief" className="field mt-1 min-h-[72px] w-full" value={brief} disabled={busy} placeholder="A warehouse robotics company in East Asia, founded by Morgan…" onChange={(event) => setBrief(event.target.value)} />
            <button type="button" className="btn mt-2 tap-target press-pop" disabled={busy || readingBrief || brief.trim().length === 0} onClick={() => void applyBrief()}><Icon name="check" size={15} accent="brand" />{readingBrief ? 'Reading brief…' : llmAvailable ? 'Use this brief' : 'Use this brief'}</button>
          </div>
          {advanced}
        </div> : null}
      </div>
    </div>
  );
}

function ChoiceRow({ title, chips, selected, onChoose, busy }: { title: string; chips: readonly SetupQuickReply[]; selected: string | null; onChoose: (chip: SetupQuickReply) => void; busy: boolean }): React.JSX.Element {
  return <div><p className="label-caps-faint">{title}</p><div className="mt-1.5 flex flex-wrap gap-1.5">{chips.map((chip) => <button key={chip.value} type="button" disabled={busy} onClick={() => onChoose(chip)} className={cx('tap-target press-pop rounded-pill border px-2.5 py-1.5 text-[11px] font-semibold', selected === chip.value ? 'border-brand bg-brand text-white' : 'border-hair bg-panel text-ink')}><span>{isIconName(chip.icon) ? <Icon name={chip.icon} size={12} accent="inherit" /> : null}</span> {chip.label}</button>)}</div></div>;
}
