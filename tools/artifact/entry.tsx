/**
 * Entry point for the single-file artifact build of Frontier Capital.
 *
 * Recreates the Next.js root layout composition (GameProvider → AppShell →
 * page) over a hash router, importing the real page components. Demo mode
 * only: no server, no Supabase, no live LLM — the app's own graceful
 * degradation paths handle all three.
 */
import { StrictMode, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { GameProvider } from '@/lib/game';
import { AppShell } from '@/components/shell/AppShell';
import { usePathname } from './shims/next-navigation';

import Landing from '@/app/page';
import SignIn from '@/app/(auth)/sign-in/page';
import SignUp from '@/app/(auth)/sign-up/page';
import CommandCentre from '@/app/(game)/command-centre/page';
import Company from '@/app/(game)/company/page';
import Products from '@/app/(game)/products/page';
import Research from '@/app/(game)/research/page';
import People from '@/app/(game)/people/page';
import Network from '@/app/(game)/network/page';
import Markets from '@/app/(game)/markets/page';
import Capital from '@/app/(game)/capital/page';
import Boardroom from '@/app/(game)/boardroom/page';
import Government from '@/app/(game)/government/page';
import Social from '@/app/(game)/social/page';
import News from '@/app/(game)/news/page';
import DealRoom from '@/app/(game)/deal-room/page';
import Financials from '@/app/(game)/financials/page';
import Leaderboard from '@/app/(game)/leaderboard/page';
import ChiefOfStaff from '@/app/(game)/chief-of-staff/page';
import EndQuarter from '@/app/(game)/end-quarter/page';
import QuarterResolution from '@/app/(game)/quarter-resolution/page';

const ROUTES: Record<string, () => JSX.Element> = {
  '/': Landing,
  '/sign-in': SignIn,
  '/sign-up': SignUp,
  '/command-centre': CommandCentre,
  '/company': Company,
  '/products': Products,
  '/research': Research,
  '/people': People,
  '/network': Network,
  '/markets': Markets,
  '/capital': Capital,
  '/boardroom': Boardroom,
  '/government': Government,
  '/social': Social,
  '/news': News,
  '/deal-room': DealRoom,
  '/financials': Financials,
  '/leaderboard': Leaderboard,
  '/chief-of-staff': ChiefOfStaff,
  '/end-quarter': EndQuarter,
  '/quarter-resolution': QuarterResolution,
};

function Router(): JSX.Element {
  const pathname = usePathname();
  const Page = ROUTES[pathname] ?? Landing;
  return <Page />;
}

function App(): JSX.Element {
  return (
    <StrictMode>
      <GameProvider>
        <AppShell>
          <Router />
        </AppShell>
      </GameProvider>
    </StrictMode>
  );
}

const container = document.getElementById('root');
if (container !== null) {
  createRoot(container).render(<App />);
}
