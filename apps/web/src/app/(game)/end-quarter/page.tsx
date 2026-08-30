'use client';

/**
 * PLACEHOLDER — End Quarter
 *
 * Review queued actions and lock the submission.
 *
 * A screen agent replaces this whole file. See `apps/web/SCREEN_GUIDE.md` for
 * the store hooks, the primitive props and the layout convention this screen
 * must follow. Keep the route path and the default export name.
 */

import { EmptyState, PageHeader, Panel } from '@/components/ui';
import { useSession } from '@/lib/game';
import { quarterLabel } from '@frontier/contracts';

export default function EndQuarterPage(): React.JSX.Element {
  const session = useSession();

  return (
    <>
      <PageHeader
        title="End Quarter"
        eyebrow={quarterLabel(session.startYear, session.quarter)}
        subtitle="Review queued actions and lock the submission."
      />
      <Panel>
        <EmptyState
          glyph="EQ"
          title="Under construction"
          message="This screen is scaffolded. The engine, the store and the design system behind it are live — the surface is not built yet."
        />
      </Panel>
    </>
  );
}
