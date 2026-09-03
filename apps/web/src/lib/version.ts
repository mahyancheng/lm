/**
 * Which build is this?
 *
 * The Pi pulls an image on a timer, so "did it update?" is a question the
 * running app has to be able to answer by itself. The answer is stamped into
 * the image by CI — the commit it was built from and the moment it was built —
 * and read back three ways: the start page footer, `GET /api/version`, and the
 * line `deploy/pi/update.sh` prints after health comes up.
 *
 * Two pairs of variables carry it, and both are set by `deploy/pi/Dockerfile`
 * before `next build` runs:
 *
 * - `NEXT_PUBLIC_BUILD_SHA` / `NEXT_PUBLIC_BUILD_TIME` are inlined into the
 *   client bundle by the bundler, which is the only way a browser can know.
 * - `BUILD_SHA` / `BUILD_TIME` are ordinary runtime variables, so a server
 *   route reports what this *process* was started with even if a bundle from
 *   somewhere else were ever served.
 *
 * Absent everywhere means a local `pnpm dev`, which is stated as `dev` rather
 * than left blank — a footer that says nothing is indistinguishable from a
 * footer that failed.
 */

/** What an unstamped build calls itself. */
export const DEV_BUILD = 'dev';

export interface BuildStamp {
  /** Full commit sha, or `dev`. */
  readonly sha: string;
  /** The seven characters a person actually compares, or `dev`. */
  readonly shortSha: string;
  /** ISO-8601 instant the image was built, or null when nothing stamped it. */
  readonly builtAt: string | null;
}

const MONTHS: readonly string[] = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function trimmed(value: string | undefined | null): string {
  return (value ?? '').trim();
}

/** The seven characters of a commit sha a person compares, or `dev`. */
export function shortSha(sha: string | undefined | null): string {
  const value = trimmed(sha);
  if (value.length === 0 || value === DEV_BUILD) return DEV_BUILD;
  return value.slice(0, 7).toLowerCase();
}

/**
 * `2026-09-03T12:17:04Z` reads as `3 Sep 12:17 UTC`.
 *
 * UTC and a fixed month table on purpose: the Pi, the phone reading it and the
 * founder abroad must all be shown the same string, and a locale-dependent
 * formatter would give three. Anything unparseable is null rather than
 * `Invalid Date`.
 */
export function formatBuildTime(iso: string | undefined | null): string | null {
  const value = trimmed(iso);
  if (value.length === 0) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  const month = MONTHS[at.getUTCMonth()] ?? '';
  const hours = String(at.getUTCHours()).padStart(2, '0');
  const minutes = String(at.getUTCMinutes()).padStart(2, '0');
  return `${at.getUTCDate()} ${month} ${hours}:${minutes} UTC`;
}

/** A stamp from whatever the two variables held; neither has to be present. */
export function buildStamp(sha: string | undefined | null, builtAt: string | undefined | null): BuildStamp {
  const full = trimmed(sha);
  const at = trimmed(builtAt);
  return {
    sha: full.length === 0 ? DEV_BUILD : full,
    shortSha: shortSha(full),
    builtAt: at.length === 0 || Number.isNaN(new Date(at).getTime()) ? null : at,
  };
}

/** The one line every surface prints: `Build a09e1f0 · 3 Sep 12:17 UTC`. */
export function buildStampLine(stamp: BuildStamp): string {
  const at = formatBuildTime(stamp.builtAt);
  return at === null ? `Build ${stamp.shortSha}` : `Build ${stamp.shortSha} · ${at}`;
}

/**
 * The stamp the bundler inlined, for anything that renders in a browser.
 *
 * Both reads are written out in full because that is what makes the
 * substitution happen: `process.env[name]` would survive into the bundle as a
 * lookup against an object the browser does not have.
 */
export function clientBuildStamp(): BuildStamp {
  return buildStamp(process.env.NEXT_PUBLIC_BUILD_SHA, process.env.NEXT_PUBLIC_BUILD_TIME);
}

/**
 * The stamp this server process was started with.
 *
 * The runtime pair wins over the inlined pair: it describes the container that
 * is actually answering, which is the thing `update.sh` is asking about.
 */
export function serverBuildStamp(): BuildStamp {
  return buildStamp(
    process.env.BUILD_SHA ?? process.env.NEXT_PUBLIC_BUILD_SHA,
    process.env.BUILD_TIME ?? process.env.NEXT_PUBLIC_BUILD_TIME,
  );
}
