'use client';

/**
 * The browser Supabase client.
 *
 * Returns `null` when the public environment variables are absent, which is the
 * default and is not an error: demo mode is a first-class configuration.
 * Callers must handle null by degrading, never by throwing.
 */

import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { publicSupabaseConfig } from './config';

let cached: SupabaseClient | null = null;

/** The memoised browser client, or null when Supabase is not configured. */
export function getBrowserClient(): SupabaseClient | null {
  if (cached !== null) return cached;
  const config = publicSupabaseConfig();
  if (config === null) return null;
  cached = createBrowserClient(config.url, config.anonKey);
  return cached;
}

export { isSupabaseConfigured, isDemoMode, publicSupabaseConfig } from './config';
