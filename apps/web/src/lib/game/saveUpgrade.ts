/** Save-file wrapper around the deterministic World 3 seed compatibility repair. */
import type { SessionState, SimEvent } from '@frontier/contracts';
import type { SaveFile } from './saveFile';
import { W3_TESSELLATE_ACCELERATOR_SAVE_UPGRADE, upgradeWorld3TessellateAcceleratorSupplier } from '@frontier/simulation';

export interface SaveUpgradeResult { readonly file: SaveFile; readonly changed: boolean; }

/**
 * Upgrade only a checkpoint. Historical quarter inputs and records remain
 * byte-for-byte untouched; the marker makes the checkpoint rewrite idempotent.
 */
export function upgradeSaveFileAtLoad(file: SaveFile, finalState?: SessionState, knownEvent?: SimEvent | null): SaveUpgradeResult {
  if ((file.scenarioMigrations ?? []).includes(W3_TESSELLATE_ACCELERATOR_SAVE_UPGRADE)) return { file, changed: false };
  const checkpoint = file.checkpoint;
  const base = finalState ?? checkpoint?.state;
  if (base === undefined) return { file, changed: false };
  const result = upgradeWorld3TessellateAcceleratorSupplier(base);
  if (!result.recognisedOldLayout && !result.applied) return { file, changed: false };
  const event = knownEvent ?? result.event;
  if (result.applied && event === null) return { file, changed: false };
  return {
    file: {
      ...file,
      checkpoint: { quarter: result.state.quarter, state: result.state },
      savedQuarter: result.state.quarter,
      scenarioMigrations: [...(file.scenarioMigrations ?? []), W3_TESSELLATE_ACCELERATOR_SAVE_UPGRADE],
      migrationEvents: event === null ? [...(file.migrationEvents ?? [])] : [...(file.migrationEvents ?? []), event],
    },
    changed: true,
  };
}
