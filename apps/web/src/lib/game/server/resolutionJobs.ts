/** Short HTTP requests observe one owner-bound, idempotent quarter job. */
import type { resolveCanonicalQuarter } from './sessionAuthority';

type Result = Awaited<ReturnType<typeof resolveCanonicalQuarter>>;
export type ResolutionJobStatus = Result | { readonly status: 'pending'; readonly progress: string };
type Job = { readonly fingerprint: string; status: ResolutionJobStatus; finishedAt: number | null };
const refused: Result = { status: 'forbidden', revision: null, file: null, outcome: null };

export function createResolutionJobs() {
  const jobs = new Map<string, Job>();
  const key = (owner: string, session: string, request: string) => JSON.stringify([owner, session, request]);
  return {
    read(owner: string, session: string, request: string): ResolutionJobStatus | null {
      return jobs.get(key(owner, session, request))?.status ?? null;
    },
    start(owner: string, session: string, request: string, fingerprint: string, run: (progress: (message: string) => void) => Promise<Result>): ResolutionJobStatus {
      const id = key(owner, session, request);
      const existing = jobs.get(id);
      if (existing !== undefined) return existing.fingerprint === fingerprint ? existing.status : refused;
      for (const [oldId, job] of jobs) if (job.finishedAt !== null && Date.now() - job.finishedAt > 15 * 60_000) jobs.delete(oldId);
      // Bound memory without evicting a running job and accidentally starting it twice.
      if (jobs.size >= 256) return { status: 'missing', revision: null, file: null, outcome: null };
      const job: Job = { fingerprint, status: { status: 'pending', progress: 'Verifying canonical session' }, finishedAt: null };
      jobs.set(id, job);
      void Promise.resolve().then(() => run((progress) => { job.status = { status: 'pending', progress }; }))
        .then((result) => { job.status = result; })
        .catch(() => { job.status = refused; })
        .finally(() => { job.finishedAt = Date.now(); });
      return job.status;
    },
  };
}
