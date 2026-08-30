/**
 * `@/lib/game` — the one import a screen needs.
 *
 * ```tsx
 * import { usePlayerView, useGameActions, formatMoney } from '@/lib/game';
 * ```
 *
 * Everything here is client-safe. Nothing in this module imports
 * `@frontier/llm` or the Claude Agent SDK; the model is reached only through
 * `@/lib/llm/client`, which is fetch and nothing else.
 */

export {
  GameProvider,
  useGame,
  useGameActions,
  useSession,
  usePlayerCompany,
  usePlayerCharacter,
  usePlayerView,
  useCompanyMetrics,
  useQuotes,
  useLeaderboards,
  useQueuedActions,
  useOutcome,
  useConnection,
  useMarketCap,
  useFounderNetWorth,
  useResolving,
  useSettings,
  useLlm,
} from './provider';
export type { GameSettings, GameStoreActions, GameStoreState, QueuedActionEntry } from './provider';

export {
  DEMO_CHARACTERS,
  DEMO_COMPANIES,
  DEMO_PLAYER_ID,
  DEMO_SEED,
  PLAYER_ID,
  buildSubmittedAction,
  createSession,
  drawWorldCandidates,
  getEngine,
  needsConfirmation,
  playerCharacterOf,
  playerCompanyOf,
  playerSeat,
  seedOf,
} from './engine';
export type { NewGameOptions } from './engine';

export {
  buildAlerts,
  founderNetWorth,
  latestQuote,
  leaderboardOf,
  marketCapOf,
  metricsFor,
  projectPlayerView,
  quotesFor,
  redactRival,
  visibleResearchProjects,
} from './playerView';

export {
  buildChiefOfStaffInput,
  buildNpcStrategistInput,
  buildWorldDirectorInput,
  companyBriefing,
  currentBudgets,
  openDecisions,
  strategistCompanies,
  worldBriefing,
} from './briefings';

export {
  MAX_REPLAY_QUARTERS,
  SAVE_KEY,
  clearSaveFile,
  hasSavedGame,
  loadSavedGame,
  readSaveFile,
  replay,
  writeSaveFile,
} from './persistence';
export type { LoadedGame, SaveFile } from './persistence';
