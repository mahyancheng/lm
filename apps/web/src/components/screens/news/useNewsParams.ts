'use client';

/**
 * The paper's URL state: `?section=street&mine=1&sector=energy&company=…&edition=7`.
 *
 * Kept in the search params rather than in `useState`, so a reader who taps
 * through to a company and comes back is still on The Street with Mine on, and
 * so an edition can be linked to. Defaults are omitted from the URL: the plain
 * `/news` route is the front page of the newest edition.
 *
 * The search is also remembered (`rememberNewsSearch`) so that the app's own
 * routes to News — the World tab and the sub-tab strip, which link to a plain
 * `/news` — bring the reader back to the section they left. Browser Back
 * already keeps the URL; this is for the taps that do not.
 */

import { useCallback, useEffect, useMemo } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { rememberNewsSearch } from '@/lib/game';
import { newsSearchOver, parseNewsParams, type NewsParams } from './layout';

export function useNewsParams(): [NewsParams, (patch: Partial<NewsParams>) => void] {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  const search = searchParams?.toString() ?? '';
  const params = useMemo(() => parseNewsParams(search), [search]);

  // Whatever the URL says the paper is open on, the shell's News links say too.
  // `rememberNewsSearch` drops `sheet` itself: that is the address the paper is
  // open *at*, and those links supply it themselves.
  useEffect(() => {
    rememberNewsSearch(search);
  }, [search]);

  // Every write merges over the live address rather than replacing it, so the
  // `sheet=news` that opened the paper survives a section tap. Dropping it
  // would close the sheet the reader is standing in.
  const setParams = useCallback(
    (patch: Partial<NewsParams>) => {
      router.replace(`${pathname}${newsSearchOver(search, { ...params, ...patch })}`, { scroll: false });
    },
    [params, pathname, router, search],
  );

  return [params, setParams];
}
