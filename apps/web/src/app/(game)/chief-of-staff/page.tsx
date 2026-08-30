'use client';

/**
 * PLACEHOLDER — Chief of Staff
 *
 * Conversational control interface: interpret, propose, confirm.
 *
 * A screen agent replaces this whole file. See `apps/web/SCREEN_GUIDE.md` for
 * the store hooks, the primitive props and the layout convention this screen
 * must follow. Keep the route path and the default export name.
 */

import { EmptyState, PageHeader, Panel } from '@/components/ui';
import { useSession } from '@/lib/game';
import { quarterLabel } from '@frontier/contracts';

export default function ChiefOfStaffPage(): React.JSX.Element {
  const session = useSession();

  return (
    <>
      <PageHeader
        title="Chief of Staff"
        eyebrow={quarterLabel(session.startYear, session.quarter)}
        subtitle="Conversational control interface: interpret, propose, confirm."
      />
      <Panel>
        <EmptyState
          glyph="CS"
          title="Under construction"
          message="This screen is scaffolded. The engine, the store and the design system behind it are live — the surface is not built yet."
        />
      </Panel>
    </>
  );
}
