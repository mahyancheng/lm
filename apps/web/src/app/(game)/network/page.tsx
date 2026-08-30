'use client';

/**
 * PLACEHOLDER — Network
 *
 * Investors, founders, officials, directors, journalists.
 *
 * A screen agent replaces this whole file. See `apps/web/SCREEN_GUIDE.md` for
 * the store hooks, the primitive props and the layout convention this screen
 * must follow. Keep the route path and the default export name.
 */

import { EmptyState, PageHeader, Panel } from '@/components/ui';
import { useSession } from '@/lib/game';
import { quarterLabel } from '@frontier/contracts';

export default function NetworkPage(): React.JSX.Element {
  const session = useSession();

  return (
    <>
      <PageHeader
        title="Network"
        eyebrow={quarterLabel(session.startYear, session.quarter)}
        subtitle="Investors, founders, officials, directors, journalists."
      />
      <Panel>
        <EmptyState
          glyph="NE"
          title="Under construction"
          message="This screen is scaffolded. The engine, the store and the design system behind it are live — the surface is not built yet."
        />
      </Panel>
    </>
  );
}
