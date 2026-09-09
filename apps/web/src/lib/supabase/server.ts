/**
 * Server-side Supabase clients.
 *
 * **Server only.** Never import this module from a client component: it reads
 * `SUPABASE_SERVICE_ROLE_KEY`, and a client bundle that references it would
 * inline nothing (server variables are not exposed) while advertising the
 * intent. Import it from route handlers and server components exclusively.
 *
 * Two clients, and the difference matters:
 *
 * - `getServiceClient()` holds the service-role key and bypasses row-level
 *   security. It is for the quarter resolver and for routes that must write
 *   canonical state.
 * - `getRouteClient(cookies)` is the anon-key client bound to a request's
 *   cookies, so RLS applies as the signed-in user.
 *
 * Both return `null` when the environment is not configured.
 */

import { createServerClient } from '@supabase/ssr';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { publicSupabaseConfig } from './config';

export interface CookieRecord {
  readonly name: string;
  readonly value: string;
}

export interface CookieBridge {
  getAll(): CookieRecord[];
  setAll(cookies: readonly { name: string; value: string; options?: Record<string, unknown> }[]): void;
}

/**
 * The service-role client. Bypasses row-level security — only ever call this
 * from a route handler or a server action, and only for writes the engine has
 * already validated.
 */
export function getServiceClient(): SupabaseClient | null {
  const config = publicSupabaseConfig();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (config === null || typeof serviceKey !== 'string' || serviceKey.length === 0) return null;
  return createClient(config.url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * A request-scoped client that respects row-level security.
 *
 * Pass the cookie bridge from `next/headers`:
 *
 * ```ts
 * const store = await cookies();
 * const supabase = getRouteClient({
 *   getAll: () => store.getAll(),
 *   setAll: (list) => list.forEach(({ name, value, options }) => store.set(name, value, options)),
 * });
 * ```
 */
export function getRouteClient(bridge: CookieBridge): SupabaseClient | null {
  const config = publicSupabaseConfig();
  if (config === null) return null;
  return createServerClient(config.url, config.anonKey, {
    cookies: {
      getAll: () => bridge.getAll(),
      setAll: (list) => {
        try {
          bridge.setAll(list);
        } catch {
          // Called from a Server Component: cookies are read-only there, and
          // the middleware-free setup means there is nothing to refresh.
        }
      },
    },
  });
}

export { isSupabaseAdminConfigured, isSupabaseConfigured, publicSupabaseConfig, REQUIRED_SUPABASE_VARS } from './config';
