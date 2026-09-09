'use client';

import Link from 'next/link';
import { useState } from 'react';
import { getBrowserClient, isSupabaseConfigured } from '@/lib/supabase/client';
import { AuthShell } from '../AuthShell';

/**
 * Create an account for shared sessions.
 *
 * Gated the same way as sign-in. A successful sign-up may require email
 * confirmation depending on the project's auth settings, so the page says so
 * rather than redirecting into a session that does not exist yet.
 */
export default function SignUpPage(): React.JSX.Element {
  const configured = isSupabaseConfigured();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const supabase = getBrowserClient();
    if (supabase === null) return;
    setBusy(true);
    setError(null);
    try {
      const { error: authError } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { display_name: displayName } },
      });
      if (authError !== null) setError(authError.message);
      else setSent(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Sign-up failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Create an account"
      subtitle="One founder, one seat at the table."
      configured={configured}
      footer={
        <>
          Already have one?{' '}
          <Link href="/sign-in" className="text-brand hover:underline">
            Sign in
          </Link>
          {' · '}
          <Link href="/" className="text-brand hover:underline">
            Play offline
          </Link>
        </>
      }
    >
      {sent ? (
        <div className="flex flex-col gap-3">
          <p className="rounded-[4px] border border-gain/25 bg-gain-wash px-2.5 py-2 text-[12px] text-gain">
            Account created. If the project requires email confirmation, follow the link sent to {email} before signing in.
          </p>
          <Link href="/sign-in" className="btn btn-primary">
            Go to sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-3">
          <label className="block">
            <span className="label-caps-faint">Founder name</span>
            <input
              className="field mt-1"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              maxLength={60}
              autoComplete="name"
              required
            />
          </label>
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
              autoComplete="new-password"
              minLength={8}
              required
            />
            <span className="mt-1 block text-[10px] text-ink-faint">At least eight characters.</span>
          </label>
          {error !== null ? (
            <p className="rounded-[4px] border border-loss/25 bg-loss-wash px-2.5 py-2 text-[11px] text-loss">{error}</p>
          ) : null}
          <button type="submit" className="btn btn-primary mt-1" disabled={busy}>
            {busy ? 'Creating…' : 'Create account'}
          </button>
        </form>
      )}
    </AuthShell>
  );
}
