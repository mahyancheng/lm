/**
 * next/navigation shim for the single-file artifact build: a hash-fragment
 * router exposing the two APIs the app uses (usePathname, useRouter).
 */
import { useSyncExternalStore } from 'react';

function currentPath(): string {
  if (typeof window === 'undefined') return '/';
  const hash = window.location.hash.replace(/^#/, '');
  return hash === '' ? '/' : hash;
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onHash = (): void => listener();
  window.addEventListener('hashchange', onHash);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('hashchange', onHash);
  };
}

export function navigate(path: string): void {
  if (typeof window === 'undefined') return;
  window.location.hash = path;
  window.scrollTo(0, 0);
}

export function usePathname(): string {
  return useSyncExternalStore(subscribe, currentPath, () => '/');
}

export function useRouter(): {
  push: (path: string) => void;
  replace: (path: string) => void;
  back: () => void;
  forward: () => void;
  refresh: () => void;
  prefetch: (path: string) => void;
} {
  return {
    push: navigate,
    replace: (path: string) => {
      if (typeof window === 'undefined') return;
      const url = new URL(window.location.href);
      url.hash = path;
      window.history.replaceState(null, '', url);
      listeners.forEach((l) => l());
      window.scrollTo(0, 0);
    },
    back: () => window.history.back(),
    forward: () => window.history.forward(),
    refresh: () => undefined,
    prefetch: () => undefined,
  };
}
