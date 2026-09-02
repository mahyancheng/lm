-- ---------------------------------------------------------------------------
-- 0020_capital_entities.sql
--
-- Capital entities: venture, buyout, hedge and sovereign funds as actors.
--
-- Almost nothing is needed here, and that is the design working rather than the
-- migration being incomplete:
--
--   * A `CapitalEntity.id` **is** the cap-table holder id already carried by
--     `public.holdings.holder_id` with `holder_kind = 'fund'`. An entity is not
--     a new owner, so `public.holder_kind` is untouched and no ownership row
--     changes shape.
--   * The ten new ledger types need no enum change: `public.sim_events.type` is
--     text constrained by `sim_events_type_format`, and every one of
--     `short_position_opened` … `capital_entity_marked` satisfies it.
--   * Shorts, campaigns, orders and the entity rows themselves live inside the
--     session state aggregate, which is stored as JSON. Nothing about them is
--     an equity movement, which is exactly why they may not be one.
--
-- The one genuine schema change is the two institution leaderboards. Appending
-- to a Postgres enum is safe and irreversible in the same way appending to the
-- zod enum is: existing rows keep their meaning, and no value is ever renamed
-- or reordered.
-- ---------------------------------------------------------------------------

alter type public.leaderboard_board add value if not exists 'capital_returns';
alter type public.leaderboard_board add value if not exists 'assets_under_management';

comment on type public.leaderboard_board is
  'Which ranking a leaderboard snapshot holds. Ten boards rank players, companies and characters; capital_returns and assets_under_management rank capital entities, and a player cannot enter either of them.';
