'use client';

/**
 * The search the paper was last open on, for the shell's News links.
 *
 * Read from session storage after mount and again on every route change, so a
 * server render and the first client render agree (both see none), and the
 * link on the Social screen already carries the section the reader just left.
 * The paper writes it in `useNewsParams`.
 */

import { useEffect, useState } from 'react';
import { readNewsSearch } from '@/lib/game';

export function useNewsSearch(pathname: string): string {
  const [search, setSearch] = useState('');
  useEffect(() => {
    setSearch(readNewsSearch());
  }, [pathname]);
  return search;
}
