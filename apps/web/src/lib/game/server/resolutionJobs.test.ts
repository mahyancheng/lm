import { describe, expect, it, vi } from 'vitest';
import { createResolutionJobs } from './resolutionJobs';

describe('quarter resolution jobs', () => {
  it('returns pending immediately, survives client retries, and starts the quarter only once', async () => {
    const jobs = createResolutionJobs();
    let complete!: (value: any) => void;
    const run = vi.fn(async (progress: (s: string) => void) => { progress('Planning rival 1 of 24'); return new Promise<any>((resolve) => { complete = resolve; }); });
    expect(jobs.start('owner', 'game', 'q0', 'same-actions', run).status).toBe('pending');
    await Promise.resolve();
    expect(jobs.read('owner', 'game', 'q0')).toEqual({ status: 'pending', progress: 'Planning rival 1 of 24' });
    expect(jobs.start('owner', 'game', 'q0', 'same-actions', run).status).toBe('pending');
    expect(run).toHaveBeenCalledTimes(1);
    expect(jobs.read('other-owner', 'game', 'q0')).toBeNull();
    expect(jobs.start('owner', 'game', 'q0', 'changed-actions', run).status).toBe('forbidden');
    complete({ status: 'resolved', revision: 2, file: null, outcome: null });
    await vi.waitFor(() => expect(jobs.read('owner', 'game', 'q0')?.status).toBe('resolved'));
    expect(jobs.start('owner', 'game', 'q0', 'same-actions', run).status).toBe('resolved');
    expect(run).toHaveBeenCalledTimes(1);
  });
});
