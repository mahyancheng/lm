'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { getBrowserClient, isSupabaseConfigured } from '@/lib/supabase/client';
import { HOME_ROUTE } from '@/lib/nav';
import { AuthShell } from '../AuthShell';

/**
 * Sign in to a shared world.
 *
 * Gated on configuration: with no Supabase project the shell renders setup
 * guidance instead of a form that could not work. Nothing here is required to
 * play — demo mode needs no account.
 */
export default function SignInPage(): React.JSX.Element {
  const router = useRouter();
  const configured = isSupabaseConfigured();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const supabase = getBrowserClient();
    if (supabase === null) return;
    setBusy(true);
    setError(null);
    try {
      const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
      if (authError !== null) setError(authError.message);
      else router.push(HOME_ROUTE);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Sign in"
      subtitle="Join a shared world with other founders."
      configured={configured}
      footer={
        <>
          No account?{' '}
          <Link href="/sign-up" className="text-brand hover:underline">
            Create one
          </Link>
          {' · '}
          <Link href="/" className="text-brand hover:underline">
            Play offline
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className="block">
          <span className="label-caps-faint">Email</span>
          <input
            className="field mt-1"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            required
          />
        </label>
        <label className="block">
          <span className="label-caps-faint">Password</span>
          <input
            className="field mt-1"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error !== null ? (
          <p className="rounded-[4px] border border-loss/25 bg-loss-wash px-2.5 py-2 text-[11px] text-loss">{error}</p>
        ) : null}
        <button type="submit" className="btn btn-primary mt-1" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </AuthShell>
  );
}
