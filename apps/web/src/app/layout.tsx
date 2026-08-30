import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { GameProvider } from '@/lib/game';
import { AppShell } from '@/components/shell/AppShell';
import './globals.css';

export const metadata: Metadata = {
  title: 'Frontier Capital',
  description:
    'An AI-industry corporate grand-strategy simulation: build a company, negotiate, invest, win government contracts and compete for the technological frontier.',
  applicationName: 'Frontier Capital',
};

export const viewport: Viewport = {
  themeColor: '#0a0e12',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
};

/**
 * The root layout.
 *
 * `GameProvider` wraps everything, so the landing page can read whether a save
 * exists and start a session without a route transition. `AppShell` decides
 * whether a given route wears the game chrome.
 */
export default function RootLayout({ children }: { readonly children: ReactNode }): React.JSX.Element {
  return (
    <html lang="en">
      <body className="bg-base text-ink antialiased">
        <GameProvider>
          <AppShell>{children}</AppShell>
        </GameProvider>
      </body>
    </html>
  );
}
