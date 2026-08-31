/**
 * Supabase availability detection.
 *
 * The app must work in full with zero environment variables. Supabase is a
 * *mode*, not a dependency: when the variables are absent the multiplayer
 * surfaces explain how to configure it instead of rendering forms that cannot
 * work.
 *
 * `NEXT_PUBLIC_*` variables are inlined by the bundler at build time, so they
 * must be read as whole property accesses — never `process.env[name]`.
 */

export interface SupabasePublicConfig {
  readonly url: string;
  readonly anonKey: string;
}

/** Browser-visible configuration, or null when it is not set. */
export function publicSupabaseConfig(): SupabasePublicConfig | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (typeof url !== 'string' || url.length === 0) return null;
  if (typeof anonKey !== 'string' || anonKey.length === 0) return null;
  return { url, anonKey };
}

/** True when the browser has enough configuration to talk to Supabase. */
export function isSupabaseConfigured(): boolean {
  return publicSupabaseConfig() !== null;
}

/**
 * True when the SERVER can actually verify a Supabase admin — i.e. the
 * service-role key is present, so a JWT can be checked and `profiles.is_admin`
 * read.
 *
 * The credential-setup gate keys "require a Supabase admin" on THIS, not on the
 * public config: with only the public URL/anon key set (and no service role),
 * the server cannot verify any admin, so demanding one would lock the panel
 * with no way in. Server-only — never inline this in a client bundle.
 */
export function isSupabaseAdminConfigured(): boolean {
  if (publicSupabaseConfig() === null) return false;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return typeof serviceKey === 'string' && serviceKey.length > 0;
}

/** True when the app is running its fully local, deterministic single-player mode. */
export function isDemoMode(): boolean {
  if (process.env.NEXT_PUBLIC_DEMO_MODE === 'false') return false;
  return !isSupabaseConfigured();
}

/** The environment variables a player has to set to leave demo mode. */
export const REQUIRED_SUPABASE_VARS: readonly string[] = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
];
