/**
 * The newspaper.
 *
 * News is a front page, not a feed: one edition, laid out by importance, with
 * a masthead, a section strip, the lead, a second tier, the briefs and a list
 * of earlier editions. Social keeps the feed components in `screens/feed`; the
 * two screens share the projection and nothing else.
 */

export { Masthead, MASTHEAD_HEIGHT_PX, PAPER_NAME, CONTROVERSY_BANDS } from './Masthead';
export type { MastheadProps } from './Masthead';
export { SectionStrip, STRIP_HEIGHT_PX, NEWS_CHROME_BUDGET_PX } from './SectionStrip';
export type { SectionStripProps } from './SectionStrip';
export { FilterSheet } from './FilterSheet';
export type { FilterCompanyOption, FilterSheetProps } from './FilterSheet';
export { FrontPage } from './FrontPage';
export type { FrontPageProps } from './FrontPage';
export { LeadStory, LEAD_BODY_LINES, BODY_FONT, openingTextOf } from './LeadStory';
export { SecondTier, TIER_GAP_PX } from './SecondTier';
export { Briefs, leadInOf } from './Briefs';
export { EarlierEditions } from './EarlierEditions';
export { StorySheet } from './StorySheet';
export { WorldSection } from './WorldSection';
export { FittedHeadline, LEAD_SIZES, TIER_SIZES, SHEET_SIZES } from './Headline';
export { Kicker, Byline, SectionRule, ForYou, isOwn, kickerParts, KIND_ICON, KIND_TONE } from './pieces';
export type { NewsContext } from './pieces';
export { useNewsParams } from './useNewsParams';
export { useTypeMeasure, useElementWidth, DEFAULT_COLUMN_WIDTH_PX, SERIF_STACK } from './useTypeMeasure';
export type { TypeMeasure } from './useTypeMeasure';
export {
  DEFAULT_NEWS_PARAMS,
  HALF_WIDTH_FALLBACK_CHARS,
  NEWS_SECTIONS,
  SECOND_TIER_MAX,
  SECOND_TIER_MIN,
  SECTION_LABEL,
  fitsHalf,
  followsId,
  isNewsSection,
  kindsOfSection,
  layoutFrontPage,
  pairForColumns,
  parentOf,
  parseNewsParams,
  resolveEdition,
  serialiseNewsParams,
} from './layout';
export type { FrontPageLayout, NewsParams, NewsSection, TierMeasure } from './layout';
