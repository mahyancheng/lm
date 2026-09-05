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
  useActiveCompany,
  useActiveCompanyId,
  useControlledCompanies,
  usePlayerCharacter,
  usePlayerView,
  useCompanyMetrics,
  useQuotes,
  useLeaderboards,
  useQueuedActions,
  useOutcome,
  useLedger,
  useConnection,
  useMarketCap,
  useFounderNetWorth,
  useResolving,
  useLoading,
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
  buildSubmittedActionForCompany,
  createSequenceAllocator,
  createSession,
  drawWorldCandidates,
  getEngine,
  needsConfirmation,
  playerCharacterOf,
  playerCompanyOf,
  playerSeat,
  resolveActiveCompanyId,
  seedOf,
  validateIntentForCompany,
  validateSubmittedAction,
} from './engine';
export type { NewGameOptions, SequenceAllocator } from './engine';

export { controlledCompanyRows, hasGroup } from './group';
export type { ControlledCompanyRow } from './group';

export {
  buildAlerts,
  eliminatedQuarterOf,
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
  DOSSIER_FEED_ITEMS,
  DOSSIER_HISTORY_QUARTERS,
  availabilityOf,
  availableActionsForSession,
  buildChiefOfStaffDossier,
} from './dossier';

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
  CHECKPOINT_INTERVAL,
  MAX_REPLAY_QUARTERS,
  SAVE_KEY,
  SAVE_SLOT_COUNT,
  SAVE_VERSION,
  SLOT_KEYS,
  buildSaveFile,
  clearSaveFile,
  clearSlot,
  exportSave,
  hasSavedGame,
  hasStoredSave,
  importSave,
  inspectSave,
  loadSavedGame,
  loadSavedGameAsync,
  readSaveFile,
  readSlotFile,
  replay,
  replayAsync,
  slotSummaries,
  storedSaveVersion,
  writeSaveFile,
  writeSlotFile,
} from './persistence';
export type {
  LoadedGame,
  QuarterRecord,
  ReplayOptions,
  ReplayProgress,
  SaveCheckpoint,
  SaveFile,
  SaveInspection,
  SaveStatus,
  SlotSummary,
} from './persistence';

export {
  EMPTY_SETUP_PROPOSAL,
  SETUP_ASK_ORDER,
  SETUP_CONFIDENCE,
  SETUP_CONFIRM_BELOW,
  SETUP_EXAMPLES,
  SETUP_NAME_MAX,
  SETUP_OPENING,
  applySetupChoice,
  clearSetupSlot,
  looksLikeName,
  mergeSetupProposals,
  nextSetupSlot,
  normaliseSetupProposal,
  parseSetupMessage,
  setupAcknowledgement,
  setupFromProposal,
  setupQuestion,
  setupQuickReplies,
  setupSummaryLine,
  setupUnderstood,
} from './setupChat';
export type { SetupQuickReply, SetupUnderstood } from './setupChat';

export {
  DEFAULT_COMPANY_NAME,
  DEFAULT_FOUNDER_NAME,
  DEMO_START_YEAR,
  continueLabel,
  saveDetailLine,
  savedCompanyName,
  savedFounderName,
  shortSavedAt,
  slotDetailLine,
  slotOverwriteLabel,
} from './saveDisplay';
export type { SavePosition } from './saveDisplay';

export {
  newsHref,
  readNewsSearch,
  rememberNewsSearch,
  setPendingLaunchCategory,
  setPendingNetworkCharacter,
  setPendingResearchNode,
  setPendingSectorFocus,
  takePendingLaunchCategory,
  takePendingNetworkCharacter,
  takePendingResearchNode,
  takePendingSectorFocus,
} from './deepLink';
