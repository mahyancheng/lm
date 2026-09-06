'use client';

/**
 * Products, world 3: **Connections**.
 *
 * The screen the owner asked for, in the shape of Plutocracy's company view.
 * One line at a time: what feeds it on the left with what each input costs,
 * the line itself in the middle with its cost, price, ask and margin, and who
 * takes it on the right with what they draw. Three columns, inputs to outputs,
 * readable in two seconds — and every pill is a ticket, so understanding the
 * picture and acting on it are the same gesture.
 *
 * One line per picture. Four lines with their alternatives is a 1,600-point
 * hairball at 130 points per pill, so the lines sit in a chip switcher above
 * the picture and the company-wide relationships (compute, agencies) appear on
 * every line's picture because they belong to the company rather than the line.
 *
 * **Following the chain** replaces the industry canvas: tapping a customer, or
 * a supplier on somebody else's picture, opens that company's Connections
 * read-only, with a Back row. An in-screen stack, eight deep, no URL state —
 * browser Back still leaves the screen, which is what a phone's back gesture
 * should do.
 *
 * Every number comes from `connectionsOf`, which decides what this seat is
 * entitled to read. This component never redacts anything, because it is never
 * handed anything to redact.
 */

import { useEffect, useMemo, useState } from 'react';
import { quarterLabel } from '@frontier/contracts';
import { connectionsOf } from '@frontier/simulation';
import { EmptyState, Icon, PageHeader, Panel, cx } from '@/components/ui';
import { takePendingLine, useActiveCompany, usePlayerView, useSession } from '@/lib/game';
import type { TargetChoice } from '../products/nodeLaunch';
import { NodeLaunchModal } from '../products/NodeLaunchModal';
import { NodeLineDrawer } from '../products/NodeLineDrawer';
import { ConnectionsDiagram } from './ConnectionsDiagram';
import { layoutConnections } from './layout';
import { connectionsModel, layoutGroupsOf, type PillAction } from './model';
import { useContainerWidth } from './useContainerWidth';

/** How far a founder may walk up somebody else's chain before the crumb trail is nonsense. */
const MAX_DEPTH = 8;

export function ConnectionsScreen(): React.JSX.Element {
  const session = useSession();
  const view = usePlayerView();
  const company = useActiveCompany();

  // The walk: an empty stack is my own company, and each tap pushes one.
  const [subjectIds, setSubjectIds] = useState<readonly string[]>([]);
  const [productId, setProductId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerSlotId, setDrawerSlotId] = useState<string | null>(null);
  const [drawerAim, setDrawerAim] = useState<TargetChoice | null>(null);
  const [launchOpen, setLaunchOpen] = useState(false);

  // The Research screen hands a line off through sessionStorage rather than a
  // query param — see deepLink.ts — taken once on mount.
  useEffect(() => {
    const pending = takePendingLine();
    if (pending !== null) setProductId(pending);
  }, []);

  const subjectId = subjectIds[subjectIds.length - 1] ?? company.id;
  // Two different questions. `isOwn` decides what may be *done* — my own line's
  // slots are mine to fill wherever I reached it from. `walking` decides
  // whether there is a way *back*: a rival's slot filled by my own company
  // pushes my own id onto the stack, and reading "is this me" off the subject
  // alone hid Back on exactly that screen and stranded the walk.
  const isOwn = subjectId === company.id;
  const walking = subjectIds.length > 0;

  const connections = useMemo(
    () => connectionsOf(session, company.id, subjectId, productId),
    [session, company.id, subjectId, productId],
  );

  // Archetype tints only. Public — it survives `redactRival` — and the glyph
  // would otherwise draw every company in the same neutral roof.
  const archetypes = useMemo(() => {
    const out: Record<string, string> = {};
    for (const entry of session.companies) out[entry.id] = entry.archetype;
    return out;
  }, [session.companies]);

  const model = useMemo(() => connectionsModel(connections, { archetypes }), [connections, archetypes]);
  const { ref, width } = useContainerWidth();
  const layout = useMemo(
    () =>
      layoutConnections({
        width,
        left: layoutGroupsOf(model.left),
        right: layoutGroupsOf(model.right),
        hub: { showOutput: model.hub?.showOutput ?? false },
      }),
    [width, model],
  );

  const openProduct =
    isOwn && connections.productId !== null ? (company.products.find((entry) => entry.id === connections.productId) ?? null) : null;

  const companyNames = useMemo(() => new Map(Object.entries(connections.companyNames)), [connections.companyNames]);

  function closeDrawer(): void {
    setDrawerOpen(false);
    setDrawerSlotId(null);
    setDrawerAim(null);
  }

  function openLine(slotId: string | null, aim: TargetChoice | null): void {
    if (!isOwn) return;
    setDrawerSlotId(slotId);
    setDrawerAim(aim);
    setDrawerOpen(true);
  }

  function walkTo(companyId: string): void {
    if (companyId === subjectId) return;
    setSubjectIds((stack) => (stack.length >= MAX_DEPTH ? [...stack.slice(1), companyId] : [...stack, companyId]));
    setProductId(null);
  }

  function act(action: PillAction): void {
    switch (action.kind) {
      case 'slot':
        openLine(action.slotId, null);
        return;
      case 'aim':
        openLine(null, { industry: action.industry, customer: action.customer });
        return;
      case 'line':
        openLine(null, null);
        return;
      case 'switchLine':
        setProductId(action.productId);
        return;
      case 'company':
        walkTo(action.companyId);
        return;
      default:
        // `href` pills are links; nothing to do here.
        return;
    }
  }

  const subjectName = connections.companyNames[subjectId] ?? 'Undisclosed';

  return (
    <>
      <PageHeader
        title="Connections"
        eyebrow={`${quarterLabel(session.startYear, session.quarter)} · ${company.name}`}
        subtitle="Inputs left, buyers right. Tap anything to act on it."
        actions={
          // Somebody else's picture is not somewhere to open my own line: the
          // panel below says ALETHEIA LABS, and a primary button above it reads
          // as belonging to them.
          isOwn ? (
            <button type="button" className="btn btn-primary tap-target w-full gap-1.5 sm:w-auto" onClick={() => setLaunchOpen(true)}>
              <Icon name="plus" size={16} accent="current" />
              Open a line
            </button>
          ) : undefined
        }
      />

      {!walking ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="connections-back"
            className="btn min-h-11 gap-1.5"
            onClick={() => {
              setSubjectIds((stack) => stack.slice(0, -1));
              setProductId(null);
            }}
          >
            <Icon name="back" size={16} accent="current" />
            Back
          </button>
          <button
            type="button"
            className="btn min-h-11"
            onClick={() => {
              setSubjectIds([]);
              setProductId(null);
            }}
          >
            Your company
          </button>
          <span className="text-[11.5px] text-ink-faint">
            {isOwn
              ? 'Your own company, reached from somebody else’s picture.'
              : `${subjectName} — public relationships only. Prices and volumes appear on a wire you are on.`}
          </span>
        </div>
      )}

      <Panel
        title={isOwn ? 'Your line' : subjectName}
        iconName="network"
        subtitle={
          connections.hub === null
            ? 'No line to draw yet'
            : `${connections.hub.nodeLabel} · per ${connections.hub.unitLabel}`
        }
        flush
      >
        {connections.lines.length > 1 ? (
          <div className="flex flex-wrap gap-1.5 border-b border-hair p-3">
            {connections.lines.map((line) => (
              <button
                key={line.productId}
                type="button"
                data-testid="line-chip"
                aria-pressed={line.selected}
                onClick={() => setProductId(line.productId)}
                className={cx(
                  'min-h-11 rounded-pill border px-3 text-[11.5px]',
                  line.selected ? 'border-brand bg-brand-wash font-semibold text-brand' : 'border-hairline text-ink-dim',
                )}
              >
                {isOwn ? line.name : line.nodeLabel}
              </button>
            ))}
          </div>
        ) : null}

        {/* The ref sits on the bare content box: `clientWidth` counts padding,
            so measuring the padded wrapper would draw a picture wider than the
            column it lands in. The horizontal padding is 4 rather than 12
            because every point of it is half a point off each pill's name. */}
        <div className="overflow-hidden px-1 py-3">
          <div ref={ref}>
            {connections.hub === null ? (
              <EmptyState
                icon="network"
                title={isOwn ? 'No line to draw yet' : `${subjectName} runs no line`}
                message={
                  isOwn
                    ? 'A company with no line on any node makes nothing and books no revenue. Open one and this picture fills in around it.'
                    : 'Nothing of theirs is wired to anything this quarter.'
                }
                action={
                  isOwn ? (
                    <button type="button" className="btn btn-primary tap-target gap-1.5" onClick={() => setLaunchOpen(true)}>
                      <Icon name="plus" size={16} accent="current" />
                      Open the first line
                    </button>
                  ) : undefined
                }
              />
            ) : (
              <ConnectionsDiagram model={model} layout={layout} onAct={act} />
            )}
          </div>
        </div>
      </Panel>

      <NodeLineDrawer
        session={session}
        product={drawerOpen ? openProduct : null}
        onClose={closeDrawer}
        report={view.economyReport}
        companyId={company.id}
        companyNames={companyNames}
        initialSlotId={drawerSlotId}
        initialAim={drawerAim}
      />
      <NodeLaunchModal open={launchOpen} onClose={() => setLaunchOpen(false)} initialNodeId={null} />
    </>
  );
}
