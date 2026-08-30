'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { REQUIRED_SUPABASE_VARS } from '@/lib/supabase/config';
import { Panel } from '@/components/ui';

/**
 * The frame both auth pages share, and the gate in front of them.
 *
 * With no Supabase configuration there is nothing to sign into: the page says
 * exactly what is missing and points back at demo mode, which plays the whole
 * game with no credentials at all.
 */
export function AuthShell({
  title,
  subtitle,
  configured,
  children,
  footer,
}: {
  readonly title: string;
  readonly subtitle: string;
  readonly configured: boolean;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-base px-5 py-12">
      <div className="w-full max-w-md">
        <Link href="/" className="mb-6 flex items-center gap-2.5">
          <span className="figure flex size-7 items-center justify-center rounded-[4px] border border-brand/40 bg-brand-wash text-[10px] font-semibold text-brand">
            FC
          </span>
          <span className="label-caps tracking-[0.24em]">Frontier Capital</span>
        </Link>

        <Panel title={title} subtitle={subtitle}>
          {configured ? (
            children
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-[12px] leading-relaxed text-ink-dim">
                Supabase is not configured, so there is no shared world to sign into. This is the default and it is not a fault: demo
                mode runs the same engine, the same invariants and the same 2027 Q1 world entirely in your browser.
              </p>
              <div className="rounded-[4px] border border-hair bg-base/60 p-2.5">
                <p className="label-caps-faint mb-1.5">Set in .env.local, then restart</p>
                <pre className="figure overflow-x-auto text-[10px] leading-relaxed text-ink-dim">
                  {REQUIRED_SUPABASE_VARS.map((name) => `${name}=`).join('\n')}
                </pre>
              </div>
              <p className="text-[11px] text-ink-faint">
                Apply <span className="figure">supabase/migrations</span> and seed with{' '}
                <span className="figure">supabase/seed.sql</span> — the same six rivals, sixteen people and seventeen-node Frontier Map
                the demo loads.
              </p>
              <Link href="/" className="btn btn-primary mt-1 w-full">
                Play in demo mode instead
              </Link>
            </div>
          )}
        </Panel>

        {footer !== undefined ? <div className="mt-4 text-center text-[11px] text-ink-faint">{footer}</div> : null}
      </div>
    </div>
  );
}
