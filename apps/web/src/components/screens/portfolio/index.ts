/**
 * The Portfolio screen's parts.
 *
 * `rows.ts` is the reading layer and holds every sentence the screen prints;
 * the two components draw them. Nothing in this folder computes an economic
 * figure — `portfolioOf` and `founderPortfolioOf` in `@frontier/simulation` do.
 */

export { CompanyChips, FactTag, PositionCard } from './PositionCard';
export type { PositionCardProps } from './PositionCard';

export { PositionDrawer } from './PositionDrawer';
export type { PositionDrawerProps, PositionTarget } from './PositionDrawer';

export {
  ACTION_LABEL,
  PORTFOLIO_TABS,
  TAB_ICON,
  TAB_LABEL,
  actionHref,
  firstPopulatedTab,
  founderHoldingLine,
  fundLine,
  gainPct,
  gainTone,
  lockupLine,
  ownershipLabel,
  pctLabel,
  reconciliationLine,
  shortLine,
  stakeLine,
  subsidiaryLine,
  tabCounts,
  totalsLine,
} from './rows';
export type { PortfolioTab } from './rows';
