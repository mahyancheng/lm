import { z } from 'zod';
import {
  CompanyPostureSchema,
  MemorySchema,
  NpcStrategistInputSchema,
  RecentEventSummarySchema,
  RelationshipSchema,
  ResearchProjectSchema,
} from '@frontier/contracts';
import { EMPTY_NPC_EVIDENCE, type NpcStrategistEvidence } from '@frontier/llm';
import { gateway, parseBody, runRole } from '../_gateway';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Evidence the strategist may cite, all of it owned by the company it is
 * planning for. The composer ownership-checks every entry and throws
 * `LlmContextLeakError` on a foreign one; validating the shape here means a
 * malformed body is a 400 rather than a thrown leak error.
 */
const EvidenceSchema = z.object({
  researchProjects: z.array(ResearchProjectSchema).default([]),
  memories: z.array(MemorySchema).default([]),
  relationships: z.array(RelationshipSchema).default([]),
  rivalSignals: z
    .array(z.object({ companyId: z.string().min(1), basis: z.string(), observation: z.string() }))
    .default([]),
  recentPublicEvents: z.array(RecentEventSummarySchema).default([]),
  pastDecisions: z
    .array(
      z.object({
        quarter: z.number().int().min(0),
        posture: CompanyPostureSchema,
        strategySummary: z.string(),
        outcomeSummary: z.string(),
      }),
    )
    .default([]),
  ownCharacterIds: z.array(z.string()).default([]),
});

const BodySchema = z.object({
  input: NpcStrategistInputSchema,
  evidence: EvidenceSchema.nullable().default(null),
});

/**
 * `POST /api/llm/npc-strategist` — one quarter of decisions for one NPC
 * company.
 *
 * The bundle is a set of *attempts*: the engine validates each action against
 * exactly the rules a player's actions face, and background companies fall
 * through to archetype defaults wherever their strategist did not act.
 *
 * Null means the company runs on its archetype default for the quarter, which
 * is a perfectly playable world.
 */
export async function POST(request: Request): Promise<Response> {
  const parsed = await parseBody(request, BodySchema);
  if (!parsed.ok) return parsed.response;

  const { input, evidence } = parsed.value;
  const resolved: NpcStrategistEvidence = evidence === null ? EMPTY_NPC_EVIDENCE : evidence;

  return runRole(async () => {
    const result = await gateway().roles.npcStrategist.plan(input, resolved, {
      sessionId: input.sessionId,
      quarter: input.quarter,
    });
    return { output: result.output, fallbackUsed: result.fallbackUsed };
  });
}
