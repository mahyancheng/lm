'use client';

/**
 * PLACEHOLDER — Quarter Resolution
 *
 * Exactly what changed last quarter, and why.
 *
 * A screen agent replaces this whole file. See `apps/web/SCREEN_GUIDE.md` for
 * the store hooks, the primitive props and the layout convention this screen
 * must follow. Keep the route path and the default export name.
 */

import { EmptyState, PageHeader, Panel } from '@/components/ui';
import { useSession } from '@/lib/game';
import { quarterLabel } from '@frontier/contracts';

export default function QuarterResolutionPage(): React.JSX.Element {
  const session = useSession();

  return (
    <>
      <PageHeader
        title="Quarter Resolution"
        eyebrow={quarterLabel(session.startYear, session.quarter)}
        subtitle="Exactly what changed last quarter, and why."
      />
      <Panel>
        <EmptyState
          glyph="QR"
          title="Under construction"
          message="This screen is scaffolded. The engine, the store and the design system behind it are live — the surface is not built yet."
        />
      </Panel>
    </>
  );
}
