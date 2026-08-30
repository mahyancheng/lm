'use client';

/**
 * PLACEHOLDER — Social
 *
 * Synthetic social networks, PR, marketing.
 *
 * A screen agent replaces this whole file. See `apps/web/SCREEN_GUIDE.md` for
 * the store hooks, the primitive props and the layout convention this screen
 * must follow. Keep the route path and the default export name.
 */

import { EmptyState, PageHeader, Panel } from '@/components/ui';
import { useSession } from '@/lib/game';
import { quarterLabel } from '@frontier/contracts';

export default function SocialPage(): React.JSX.Element {
  const session = useSession();

  return (
    <>
      <PageHeader
        title="Social"
        eyebrow={quarterLabel(session.startYear, session.quarter)}
        subtitle="Synthetic social networks, PR, marketing."
      />
      <Panel>
        <EmptyState
          glyph="SO"
          title="Under construction"
          message="This screen is scaffolded. The engine, the store and the design system behind it are live — the surface is not built yet."
        />
      </Panel>
    </>
  );
}
