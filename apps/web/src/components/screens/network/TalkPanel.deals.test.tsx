import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DealProposalSchema, NewGameSetupSchema, type SessionState } from '@frontier/contracts';
import { createWorld3Session, W3_DEFAULT_SETUP } from '@frontier/simulation';

const queueAction = vi.hoisted(() => vi.fn());
const requestCompanyDialogue = vi.hoisted(() => vi.fn());
const queueCompanyDialogueCommand = vi.hoisted(() => vi.fn());
let currentSession: SessionState;
let activeCompanyId = '';
vi.mock('@/lib/game', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/game')>()),
  useActiveCompany: () => currentSession.companies.find((company) => company.id === activeCompanyId)!,
  usePlayerView: () => ({ visibleCompanies: currentSession.companies, techGraph: currentSession.techGraph, opportunities: [] }),
  useGameActions: () => ({ recordConversationTurn: vi.fn(), queueAction }),
  useGame: () => ({ ledger: [] }),
  useQueuedActions: () => [],
}));
vi.mock('@/components/ui', () => ({
  AiLabel: () => null, Icon: () => null, SectionHeading: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Tag: ({ children }: { children: ReactNode }) => <span>{children}</span>, cx: (...values: unknown[]) => values.filter(Boolean).join(' '),
  ConfirmDialog: ({ open, title, terms, confirmLabel, onConfirm }: { open: boolean; title: string; terms: { label: string; value: string }[]; confirmLabel: string; onConfirm: () => void }) => open ? <section><div>{title}</div>{terms.map((term) => <div key={`${term.label}-${term.value}`}>{term.value}</div>)}<button type="button" onClick={onConfirm}>{confirmLabel}</button></section> : null,
}));
vi.mock('../deal-room/DealBuilder', () => ({ DealBuilder: () => null }));
vi.mock('../company/BuyAccelerators', () => ({ BuyAccelerators: () => null }));
vi.mock('@/lib/llm/client', () => ({ requestCharacterReply: vi.fn(), requestCompanyDialogue, queueCompanyDialogueCommand }));
import { TalkPanel } from './TalkPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type FakeNode = Record<string, unknown> & { childNodes: FakeNode[]; parentNode: FakeNode | null };
function fakeDom(): { win: Record<string, unknown>; container: Element } { const doc: Record<string, unknown> = { nodeType: 9, addEventListener: () => {}, removeEventListener: () => {}, activeElement: null }; const element = (tag: string): FakeNode => { const node: FakeNode = { nodeType: 1, nodeName: tag.toUpperCase(), tagName: tag.toUpperCase(), namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: doc, childNodes: [], parentNode: null, style: {}, addEventListener: () => {}, removeEventListener: () => {}, appendChild(child: FakeNode) { child.parentNode = node; node.childNodes.push(child); return child; }, removeChild(child: FakeNode) { node.childNodes.splice(node.childNodes.indexOf(child), 1); child.parentNode = null; return child; }, insertBefore(child: FakeNode, before: FakeNode | null) { child.parentNode = node; const index = before === null ? -1 : node.childNodes.indexOf(before); if (index < 0) node.childNodes.push(child); else node.childNodes.splice(index, 0, child); return child; }, setAttribute: () => {}, removeAttribute: () => {}, hasAttribute: () => false, scrollIntoView: () => {}, textContent: '' }; return node; }; doc.createElement = element; doc.createElementNS = (_namespace: string, tag: string) => element(tag); doc.createTextNode = (text: string): FakeNode => ({ nodeType: 3, nodeValue: text, ownerDocument: doc, childNodes: [], parentNode: null, textContent: text }); doc.documentElement = element('html'); const win: Record<string, unknown> = { event: undefined, document: doc, HTMLIFrameElement: class {}, HTMLElement: class {} }; doc.defaultView = win; return { win, container: element('div') as unknown as Element }; }
function walk(node: FakeNode, found: FakeNode[] = []): FakeNode[] { found.push(node); for (const child of node.childNodes) walk(child, found); return found; }
function props(node: FakeNode): Record<string, unknown> { const key = Object.keys(node).find((entry) => entry.startsWith('__reactProps$')); if (!key) throw new Error('missing react props'); return node[key] as Record<string, unknown>; }
function text(value: unknown): string { if (typeof value === 'string' || typeof value === 'number') return String(value); if (Array.isArray(value)) return value.map(text).join(''); if (value && typeof value === 'object' && 'props' in value) return text((value as { props: { children?: unknown } }).props.children); return ''; }
function button(container: FakeNode, label: string): FakeNode { const node = walk(container).find((candidate) => candidate.tagName === 'BUTTON' && text(props(candidate).children) === label); if (!node) throw new Error(`missing ${label}`); return node; }
function click(node: FakeNode): void { (props(node).onClick as () => void)(); }
const globals = globalThis as unknown as { window?: unknown; document?: unknown }; let root: Root; let container: FakeNode; let targetId = ''; let selfId = '';
function Panel(): React.JSX.Element { const target = currentSession.characters.find((character) => character.id === targetId)!; return <TalkPanel session={currentSession} target={target} selfId={selfId} inbound={null} outbound={null} theirMemories={[]} accessBasis="test" />; }

beforeEach(() => { const dom = fakeDom(); globals.window = dom.win; globals.document = (dom.win as { document: unknown }).document; container = dom.container as unknown as FakeNode; root = createRoot(dom.container); queueAction.mockReset(); requestCompanyDialogue.mockReset(); queueCompanyDialogueCommand.mockReset(); currentSession = createWorld3Session(424242, NewGameSetupSchema.parse({ ...W3_DEFAULT_SETUP, companyName: 'Buyer', founderName: 'Avery', backgroundId: 'consumer_ai', sector: 'ai' })); activeCompanyId = currentSession.players[0]!.companyId; selfId = currentSession.players[0]!.characterId; const target = currentSession.characters.find((character) => character.companyId !== activeCompanyId && character.id === currentSession.companies.find((company) => company.id === character.companyId)?.ceoCharacterId)!; targetId = target.id; });
afterEach(async () => { await act(async () => root.unmount()); delete globals.window; delete globals.document; });

describe('TalkPanel owned-hardware terms', () => {
  it('shows exact terms, requires confirmation, queues acceptance, then renders canonical delivery without a false pending status', async () => {
    const targetCompanyId = currentSession.characters.find((character) => character.id === targetId)!.companyId!;
    const deal = DealProposalSchema.parse({ id: 'deal_hardware_terms', proposerId: targetCompanyId, proposerKind: 'company', counterpartyId: activeCompanyId, counterpartyKind: 'company', gives: [{ kind: 'owned_accelerator_supply', supplierCompanyId: targetCompanyId, buyerCompanyId: activeCompanyId, quantityPerQuarter: 1250, durationQuarters: 4, hardwarePriceReference: 'seller_quote', premiumPct: 5, maxUnitPriceUsd: 987654, priority: 7, nonExclusive: true, cancellable: true, contractEndQuarter: currentSession.quarter + 4 }], gets: [], confidentiality: 'private', expiresQuarter: currentSession.quarter + 1, binding: true, intentStatements: [], summary: 'Four-quarter accelerator supply agreement.', status: 'proposed', createdQuarter: currentSession.quarter, respondedQuarter: null, conversationId: null, breachedByPartyId: null, settlements: [] });
    currentSession = { ...currentSession, deals: [...currentSession.deals, deal] };
    await act(async () => root.render(<Panel />));
    const rendered = walk(container).map((node) => node.textContent).filter(Boolean).join(' ');
    expect(rendered).toContain('1250 owned accelerators/quarter × 4 quarters'); expect(rendered).toContain('max $987,654/unit');
    await act(async () => click(button(container, 'Accept terms'))); expect(queueAction).not.toHaveBeenCalled(); expect(walk(container).map((node) => node.textContent).join(' ')).toContain('Accept these company terms');
    await act(async () => click(button(container, 'Queue acceptance'))); expect(queueAction).toHaveBeenCalledWith({ type: 'accept_deal', dealId: deal.id }, { confirmed: true });
    const accepted = { ...deal, status: 'accepted' as const, respondedQuarter: currentSession.quarter, settlements: [{ quarter: currentSession.quarter, obligationKind: 'owned_accelerator_supply' as const, status: 'delivered' as const, dueUnits: 1250, deliveredUnits: 1250, unitPriceUsd: 900000, totalUsd: 1125000000, reason: null }] };
    currentSession = { ...currentSession, deals: currentSession.deals.map((entry) => entry.id === deal.id ? accepted : entry), conversationThreads: [{ id: 'thread', sessionId: currentSession.sessionId, playerCompanyId: activeCompanyId, playerCharacterId: selfId, targetCharacterId: targetId, targetCompanyId, turns: [{ speakerId: targetId, text: 'Queued previously.', quarter: currentSession.quarter - 1, targetCompanyId, receipts: [{ status: 'queued', revision: 3, intent: { type: 'accept_deal', dealId: deal.id }, reason: null }] }], nextTurnSequence: 1, lastMessageQuarter: currentSession.quarter - 1 }] };
    await act(async () => root.render(<Panel />)); const updated = walk(container).map((node) => node.textContent).filter(Boolean).join(' ');
    expect(updated).toContain('accepted'); expect(updated).toContain('Latest delivery:'); expect(updated).toContain('delivered'); expect(updated).toContain('1250'); expect(updated).toContain('Submitted for quarter — see current terms below'); expect(updated).not.toContain('Accept terms');
  });
});


describe('TalkPanel CEO proposal queue', () => {
  it('renders a CEO offer in chat and queues the reviewed proposal through the dialogue endpoint', async () => {
    const targetCompanyId = currentSession.characters.find((character) => character.id === targetId)!.companyId!;
    requestCompanyDialogue.mockResolvedValue({
      turnId: 'turn_ceo_offer',
      output: { text: 'I can put this offer to our team.', commands: [{ type: 'propose_deal', proposal: { counterpartyId: targetCompanyId, counterpartyKind: 'company', gives: [], gets: [{ kind: 'cash_payment', fromCompanyId: targetCompanyId, toCompanyId: activeCompanyId, amountUsd: 500000 }], confidentiality: 'private', expiresQuarter: currentSession.quarter + 1, binding: true, intentStatements: [], summary: 'Seed a joint launch.' } }] },
      receipts: [], revision: 7,
    });
    queueCompanyDialogueCommand.mockResolvedValue({ status: 'queued', revision: 8, intent: { type: 'propose_deal', proposal: { counterpartyId: targetCompanyId } }, reason: null });
    await act(async () => root.render(<Panel />));
    const textarea = walk(container).find((node) => node.tagName === 'TEXTAREA')!;
    await act(async () => { (props(textarea).onChange as (event: unknown) => void)({ target: { value: 'Can you make a concrete offer?' } }); });
    await act(async () => { click(button(container, 'Send')); await Promise.resolve(); });
    expect(walk(container).map((node) => node.textContent).join(' ')).toContain('CEO offer');
    await act(async () => click(button(container, 'Queue for resolution')));
    await act(async () => { const choices = walk(container).filter((node) => node.tagName === 'BUTTON' && text(props(node).children) === 'Queue for resolution'); click(choices.at(-1)!); await Promise.resolve(); });
    expect(queueCompanyDialogueCommand).toHaveBeenCalledWith(expect.objectContaining({ sessionId: currentSession.sessionId, conversationId: targetCompanyId }), 'turn_ceo_offer', 0, expect.objectContaining({ type: 'propose_deal' }));
    expect(walk(container).map((node) => node.textContent).join(' ')).toContain('Queued for resolution. It is not accepted, binding, or delivered');
  });
});

describe('TalkPanel restored CEO proposals', () => {
  it('hydrates a queued CEO proposal from the canonical thread without offering it again', async () => {
    const targetCompanyId = currentSession.characters.find((character) => character.id === targetId)!.companyId!;
    const command = { type: 'accept_deal' as const, dealId: 'deal_restore' };
    currentSession = {
      ...currentSession,
      conversationThreads: [{
        id: 'thread:restore', sessionId: currentSession.sessionId, playerCompanyId: activeCompanyId, playerCharacterId: selfId,
        targetCharacterId: targetId, targetCompanyId, nextTurnSequence: 2, lastMessageQuarter: currentSession.quarter,
        turns: [
          { turnId: 'turn_restored', speakerId: selfId, text: 'Will you accept?', quarter: currentSession.quarter, targetCompanyId },
          { turnId: 'turn_restored', speakerId: targetId, text: 'Here is our response.', quarter: currentSession.quarter, targetCompanyId, proposedCommands: [command], receipts: [{ status: 'queued', revision: 12, intent: command, reason: null }] },
        ],
      }],
    };
    await act(async () => root.render(<Panel />));
    const rendered = walk(container).map((node) => node.textContent).join(' ');
    expect(rendered).toContain('CEO acceptance');
    expect(rendered).toContain('Submitted for quarter');
    expect(rendered).toContain('Queued for resolution. It is not accepted, binding, or delivered');
    expect(() => button(container, 'Queue for resolution')).toThrow();
  });

  it('shows an earlier-quarter draft as expired instead of allowing it to be queued', async () => {
    const targetCompanyId = currentSession.characters.find((character) => character.id === targetId)!.companyId!;
    const command = { type: 'accept_deal' as const, dealId: 'deal_old' };
    currentSession = {
      ...currentSession,
      conversationThreads: [{
        id: 'thread:old', sessionId: currentSession.sessionId, playerCompanyId: activeCompanyId, playerCharacterId: selfId,
        targetCharacterId: targetId, targetCompanyId, nextTurnSequence: 2, lastMessageQuarter: currentSession.quarter - 1,
        turns: [{ turnId: 'turn_old', speakerId: targetId, text: 'Old terms.', quarter: currentSession.quarter - 1, targetCompanyId, proposedCommands: [command] }],
      }],
    };
    await act(async () => root.render(<Panel />));
    expect(walk(container).map((node) => node.textContent).join(' ')).toContain('Draft expired — refresh terms');
    expect(() => button(container, 'Queue for resolution')).toThrow();
  });
});

describe('TalkPanel CEO queue retry', () => {
  it('keeps the reviewed proposal available after a transport failure and retries the same persisted id', async () => {
    const targetCompanyId = currentSession.characters.find((character) => character.id === targetId)!.companyId!;
    const command = { type: 'accept_deal' as const, dealId: 'deal_retry' };
    requestCompanyDialogue.mockResolvedValue({ turnId: 'turn_retry', output: { text: 'Review this acceptance.', commands: [command] }, receipts: [], revision: 7 });
    queueCompanyDialogueCommand.mockResolvedValueOnce(null).mockResolvedValueOnce({ status: 'queued', revision: 8, intent: command, reason: null });
    await act(async () => root.render(<Panel />));
    const textarea = walk(container).find((node) => node.tagName === 'TEXTAREA')!;
    await act(async () => { (props(textarea).onChange as (event: unknown) => void)({ target: { value: 'Confirm the deal.' } }); });
    await act(async () => { click(button(container, 'Send')); await Promise.resolve(); });
    const confirm = async (): Promise<void> => {
      await act(async () => click(button(container, 'Queue for resolution')));
      await act(async () => { const choices = walk(container).filter((node) => node.tagName === 'BUTTON' && text(props(node).children) === 'Queue for resolution'); click(choices.at(-1)!); await Promise.resolve(); });
    };
    await confirm();
    expect(walk(container).map((node) => node.textContent).join(' ')).toContain('Could not contact the queue. You can try again.');
    await confirm();
    expect(queueCompanyDialogueCommand).toHaveBeenNthCalledWith(2, expect.objectContaining({ conversationId: targetCompanyId }), 'turn_retry', 0, command);
    expect(walk(container).map((node) => node.textContent).join(' ')).toContain('Queued for resolution. It is not accepted, binding, or delivered');
  });
});

describe('TalkPanel historical CEO receipts', () => {
  it('renders a prior-quarter queued receipt as historical rather than pending', async () => {
    const targetCompanyId = currentSession.characters.find((character) => character.id === targetId)!.companyId!;
    const command = { type: 'accept_deal' as const, dealId: 'deal_prior_receipt' };
    currentSession = {
      ...currentSession,
      conversationThreads: [{ id: 'thread:prior-receipt', sessionId: currentSession.sessionId, playerCompanyId: activeCompanyId, playerCharacterId: selfId, targetCharacterId: targetId, targetCompanyId, nextTurnSequence: 2, lastMessageQuarter: currentSession.quarter - 1, turns: [{ turnId: 'turn_prior_receipt', speakerId: targetId, text: 'Prior submission.', quarter: currentSession.quarter - 1, targetCompanyId, proposedCommands: [command], receipts: [{ status: 'queued', revision: 12, intent: command, reason: null }] }] }],
    };
    await act(async () => root.render(<Panel />));
    const rendered = walk(container).map((node) => node.textContent).join(' ');
    expect(rendered).toContain(`Submitted in Q${currentSession.quarter - 1}`);
    expect(rendered).toContain('historical submission, not a pending action');
    expect(rendered).not.toContain('Queued for resolution. It is not accepted, binding, or delivered');
  });
});
