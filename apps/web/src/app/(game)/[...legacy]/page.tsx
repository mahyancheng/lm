'use client';

/**
 * Every address the game used to have.
 *
 * Twenty-two routes became five tabs and twenty sheets. A bookmark, an old
 * screenshot and a link inside a saved conversation all still work: the first
 * segment is looked up in `LEGACY_ROUTES` and the browser is replaced onto the
 * new address, query and fragment intact. `replace`, not `push`, so Back from
 * the new address does not land on the old one and bounce forward again.
 *
 * An unknown segment is a 404 and says so. The check runs during the render
 * rather than in the effect, so the server answers with the status rather than
 * a page that changes its mind in the browser.
 */

import { notFound, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect } from 'react';
import { LEGACY_ROUTES, firstSegmentOf, legacyHref } from '@/lib/sheets';

export default function LegacyPage(): React.JSX.Element {
  const pathname = usePathname();
  if (!Object.prototype.hasOwnProperty.call(LEGACY_ROUTES, firstSegmentOf(pathname))) notFound();
  return (
    <Suspense fallback={null}>
      <LegacyRedirect />
    </Suspense>
  );
}

function LegacyRedirect(): null {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const search = searchParams?.toString() ?? '';

  useEffect(() => {
    // The fragment never reaches the server and is not in `useSearchParams`.
    const hash = typeof window === 'undefined' ? '' : window.location.hash;
    router.replace(legacyHref(`${pathname}${search === '' ? '' : `?${search}`}${hash}`));
  }, [pathname, router, search]);

  return null;
}
