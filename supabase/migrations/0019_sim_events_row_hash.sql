-- 0019_sim_events_row_hash.sql
-- The resolver now chains a per-row tamper-evidence hash (rowHash =
-- fnv1a64(previousRowHash + canonical(event))) instead of hashing the full
-- session state per row; state_hash_before/after are stamped at phase
-- granularity. Persist the chain so a ledger round-tripped through Postgres
-- still satisfies the deterministic_replay invariant.
-- ALTER TABLE is unaffected by the append-only trigger (which guards UPDATE
-- and DELETE of rows, not DDL).

alter table public.sim_events add column row_hash text;

comment on column public.sim_events.row_hash is
  'Chained per-row integrity hash: fnv1a64(previous row_hash || canonical event). state_hash_before/after are phase-granularity session-state hashes.';
