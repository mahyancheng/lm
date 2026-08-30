import { z } from 'zod';
import { ResolutionReportSchema } from '@frontier/contracts';
import { gateway, parseBody, runRole } from '../_gateway';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  report: ResolutionReportSchema,
  focusCompanyId: z.string().min(1).nullable().default(null),
});

/**
 * `POST /api/llm/narrator` — optional colour over a committed report.
 *
 * The narrator's only input is `committedLines`, every one of which already
 * traces to a ledger row. It explains what the simulator did; it never decides
 * anything and it may not introduce a number that was not supplied.
 *
 * If it is unavailable the Quarter Resolution screen renders its lines
 * directly — they are human-readable by construction, which is why this whole
 * role is optional.
 */
export async function POST(request: Request): Promise<Response> {
  const parsed = await parseBody(request, BodySchema);
  if (!parsed.ok) return parsed.response;

  const { report, focusCompanyId } = parsed.value;

  const committedLines = report.phases.flatMap((phase) =>
    phase.lines.map((line) => ({ phase: line.phase, text: line.text, deltaLabel: line.deltaLabel })),
  );

  return runRole(async () => {
    const result = await gateway().roles.narrator.narrate(
      {
        sessionId: report.sessionId,
        quarter: report.quarter,
        committedLines,
        focusCompanyId: focusCompanyId ?? null,
      },
      { sessionId: report.sessionId, quarter: report.quarter },
    );
    return { output: result.output, fallbackUsed: result.fallbackUsed };
  });
}
