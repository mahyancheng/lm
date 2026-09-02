/**
 * The universal feed.
 *
 * One card component, one list, one set of pure helpers — shared by News, which
 * shows everything, and Social, which shows the same stream narrowed to what
 * people said. There is no second feed anywhere in the app, and no screen
 * partitions the record by who wrote it.
 */

export { Feed } from './Feed';
export type { FeedProps } from './Feed';

export { FeedItem, toneOfSentiment } from './FeedItem';
export type { FeedContext, FeedItemProps } from './FeedItem';

export { FEED_SECTOR_ORDER, FeedFilterBar } from './FeedFilterBar';
export type { FeedCompanyOption, FeedFilterBarProps } from './FeedFilterBar';

export {
  FEED_FILTER_ALL,
  FEED_KIND_GROUPS,
  buildFeed,
  companiesInFeed,
  countByKindGroup,
  countByNetwork,
  countBySector,
  feedSectorsOf,
  filterFeed,
  groupByQuarter,
  groupOfKind,
  isOwnItem,
  kindsOfGroup,
  matchesFeedFilter,
  sectorsInFeed,
  threadFeed,
  topByReach,
} from './filters';
export type { FeedFilter, FeedKindGroup, FeedQuarter, FeedThread } from './filters';
