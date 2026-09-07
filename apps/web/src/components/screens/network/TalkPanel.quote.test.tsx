import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NewGameSetupSchema } from '@frontier/contracts';
import { sellersFor } from '@frontier/simulation';

const { characterReply, companyReply } = vi.hoisted(() => ({ characterReply: vi.fn(), companyReply: vi.fn() }));

vi.mock('@/lib/llm/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/llm/client')>()),
  requestCharacterReply: characterReply,
  requestCompanyDialogue: companyReply,
}));

// These components are presentation primitives. Their small host equivalents
// leave TalkPanel and BuyAccelerators mounted for real while making the node
// harness exercise the actual review/confirm callbacks.
vi.mock('@/components/ui', () => ({
  AiLabel: () => null,
  Icon: () => null,
  SectionHeading: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Tag: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  cx: (...values: unknown[]) => values.filter(Boolean).join(' '),
  CashAfter: () => null,
  EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
  ValidationBanner: () => null,
  SliderField: ({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) => <label>{label}<input value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>,
  ConfirmDialog: ({ open, title, confirmLabel, onConfirm }: { open: boolean; title: string; confirmLabel: string; onConfirm: () => void }) => open ? <section><div>{title}</div><button type="button" onClick={onConfirm}>{confirmLabel}</button></section> : null,
  cashAfterOf: (company: { financials: { cash: number } }, spend: number) => ({ afterUsd: company.financials.cash - spend, line: null }),
  roundStep: () => 1,
}));

import { TalkPanel } from './TalkPanel';
import { GameProvider, PLAYER_ID, playerCompanyOf, useGame, useGameActions, type GameStoreActions, type GameStoreState } from '@/lib/game';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type FakeNode = Record<string, unknown> & { childNodes: FakeNode[]; parentNode: FakeNode | null };

function fakeStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; }, clear: () => values.clear(), getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null, removeItem: (key) => void values.delete(key), setItem: (key, value) => void values.set(key, value),
  } as Storage;
}

function fakeDom(): { win: Record<string, unknown>; container: Element } {
  const doc: Record<string, unknown> = { nodeType: 9, addEventListener: () => {}, removeEventListener: () => {}, activeElement: null };
  const element = (tag: string): FakeNode => {
    const node: FakeNode = {
      nodeType: 1, nodeName: tag.toUpperCase(), tagName: tag.toUpperCase(), namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: doc,
      childNodes: [], parentNode: null, style: {}, addEventListener: () => {}, removeEventListener: () => {},
      appendChild(child: FakeNode) { child.parentNode = node; node.childNodes.push(child); return child; },
      removeChild(child: FakeNode) { node.childNodes.splice(node.childNodes.indexOf(child), 1); child.parentNode = null; return child; },
      insertBefore(child: FakeNode, before: FakeNode | null) { child.parentNode = node; const index = before === null ? -1 : node.childNodes.indexOf(before); if (index < 0) node.childNodes.push(child); else node.childNodes.splice(index, 0, child); return child; },
      setAttribute: () => {}, removeAttribute: () => {}, hasAttribute: () => false, scrollIntoView: () => {}, textContent: '',
    };
    return node;
  };
  doc.createElement = element;
  doc.createElementNS = (_namespace: string, tag: string) => element(tag);
  doc.createTextNode = (text: string): FakeNode => ({ nodeType: 3, nodeValue: text, ownerDocument: doc, childNodes: [], parentNode: null, textContent: text });
  doc.documentElement = element('html');
  const win: Record<string, unknown> = { event: undefined, document: doc, localStorage: fakeStorage(), HTMLIFrameElement: class {}, HTMLElement: class {} };
  doc.defaultView = win;
  return { win, container: element('div') as unknown as Element };
}

const globals = globalThis as unknown as { window?: unknown; document?: unknown };
let root: Root;
let container: FakeNode;
let state: GameStoreState | null = null;
let actions: GameStoreActions | null = null;
let sellerCompanyId = '';
let targetCharacterId = '';

function Probe({ panel }: { panel: boolean }): React.JSX.Element | null {
  state = useGame();
  actions = useGameActions();
  if (!panel || sellerCompanyId === '' || targetCharacterId === '') return null;
  const company = playerCompanyOf(state.session);
  const target = state.session.characters.find((character) => character.id === targetCharacterId);
  if (target === undefined || company.ceoCharacterId === null) throw new Error('fixture requires both CEOs');
  return <TalkPanel session={state.session} target={target} selfId={company.ceoCharacterId} inbound={null} outbound={null} theirMemories={[]} accessBasis="test access" />;
}

function walk(node: FakeNode, found: FakeNode[] = []): FakeNode[] {
  found.push(node);
  for (const child of node.childNodes) walk(child, found);
  return found;
}

function reactProps(node: FakeNode): Record<string, unknown> {
  const key = Object.keys(node).find((entry) => entry.startsWith('__reactProps$'));
  if (key === undefined) throw new Error(`No React props on ${String(node.tagName)}`);
  return node[key] as Record<string, unknown>;
}

function contentText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(contentText).join('');
  if (value !== null && typeof value === 'object' && 'props' in value) return contentText((value as { props: { children?: unknown } }).props.children);
  return '';
}

function button(label: string): FakeNode {
  const match = walk(container).find((node) => node.tagName === 'BUTTON' && contentText(reactProps(node).children) === label);
  if (match === undefined) throw new Error(`Button ${label} was not rendered`);
  return match;
}

function click(node: FakeNode): void {
  const onClick = reactProps(node).onClick as (() => void) | undefined;
  if (onClick === undefined) throw new Error('Expected a clickable button');
  onClick();
}

beforeEach(async () => {
  const dom = fakeDom();
  globals.window = dom.win;
  globals.document = (dom.win as { document: unknown }).document;
  container = dom.container as unknown as FakeNode;
  state = null;
  actions = null;
  sellerCompanyId = '';
  targetCharacterId = '';
  companyReply.mockReset();
  characterReply.mockReset();
  root = createRoot(dom.container);
  await act(async () => { root.render(<GameProvider><Probe panel={false} /></GameProvider>); });
  for (let pass = 0; pass < 25 && (state === null || !(state as GameStoreState).hydrated || (state as GameStoreState).loading); pass += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  if (state === null || actions === null) throw new Error('GameProvider did not mount');
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  delete globals.window;
  delete globals.document;
});

describe('TalkPanel accelerator quote', () => {
  it('keeps a verified CEO quote after conversation persistence and queues its exact reviewed purchase', async () => {
    await act(async () => {
      actions!.newGame({ seed: 424242, setup: NewGameSetupSchema.parse({ companyName: 'Northwind AI', founderName: 'Rae Fontaine', backgroundId: 'consumer_ai', worldVersion: 2 }) });
    });
    const company = playerCompanyOf(state!.session);
    const seller = sellersFor(state!.session, 'accelerators', company.id)[0]!;
    sellerCompanyId = seller.company.id;
    const appointedExecutive = state!.session.characters.find((character) => character.companyId === sellerCompanyId && character.id === seller.company.ceoCharacterId);
    if (appointedExecutive === undefined) throw new Error('fixture requires the seller CEO');
    // Board dismissal promotes an executive without changing that character's
    // role. Model the resulting state directly: the company-owned dialogue
    // must follow the canonical CEO pointer, not the founder label.
    appointedExecutive.role = 'executive';
    seller.company.ceoCharacterId = appointedExecutive.id;
    targetCharacterId = appointedExecutive.id;
    const units = Math.min(2, seller.sellableUnits);
    companyReply.mockResolvedValue({ text: 'Here is our published quote.', acceleratorPurchaseDraft: { sellerCompanyId, units, unitPriceUsd: seller.unitPriceUsd }, dealDraft: undefined, memoryToStore: null });

    await act(async () => { root.render(<GameProvider><Probe panel /></GameProvider>); });
    const textarea = walk(container).find((node) => node.tagName === 'TEXTAREA');
    if (textarea === undefined) throw new Error('TalkPanel textarea was not rendered');
    await act(async () => {
      (reactProps(textarea).onChange as (event: { target: { value: string } }) => void)({ target: { value: 'I want two accelerators.' } });
    });
    await act(async () => { click(button('Send')); await Promise.resolve(); });

    // recordConversationTurn changes nextTurnSequence and causes TalkPanel's
    // transcript hydration effect. The quote card must survive that provider update.
    expect(state!.session.conversationThreads?.[0]?.nextTurnSequence).toBe(2);
    expect(walk(container).some((node) => node.textContent === 'Purchase from this company')).toBe(true);
    expect(walk(container).some((node) => node.textContent === 'Review purchase')).toBe(true);

    await act(async () => { click(button('Review purchase')); });
    await act(async () => { click(button('Queue for this quarter')); });
    const queued = state!.queuedActions.at(-1);
    expect(queued?.intent).toEqual({ type: 'buy_accelerators', sellerCompanyId, units, maxPricePerUnitUsd: seller.unitPriceUsd, quotedUnitPriceUsd: seller.unitPriceUsd });
    expect(queued?.confirmedByHuman).toBe(true);
    expect(companyReply).toHaveBeenCalledTimes(1);
    expect(characterReply).not.toHaveBeenCalled();
    expect(companyReply.mock.calls[0]?.[0].gameFacts).toEqual(expect.arrayContaining([{ label: 'Negotiation counterparty (company)', value: sellerCompanyId }]));
    expect(PLAYER_ID).toBe(state!.session.players[0]?.playerId);
  });
});
