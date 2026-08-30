-- ===========================================================================
-- seed.sql — Frontier Capital demo world
--
-- A complete, deterministic session for local development: 2027 Q1, seed
-- 424242, six major AI companies, fifteen named people with traits and
-- relationships, a five-member board, three government agencies with two open
-- procurements, a sixteen-node Frontier Map, an in-world exchange with opening
-- quotes and a first leaderboard.
--
-- Every id is fixed so fixtures, tests and screenshots reference the same
-- entities across resets. Re-runnable: it purges the demo session first.
--
-- Applied by:  supabase db reset
-- ===========================================================================

select public.purge_session('00000000-0000-4000-8000-000000000001');

-- ---------------------------------------------------------------------------
-- Session
-- ---------------------------------------------------------------------------

insert into public.game_sessions (
  id, name, slug, seed, status, current_quarter, start_year, start_quarter_of_year,
  max_human_players, is_public, is_demo, config, engine_version, created_by
) values (
  '00000000-0000-4000-8000-000000000001',
  'Frontier Capital — Demo World',
  'demo-world',
  424242,
  'active',
  1,
  2027,
  1,
  8,
  true,
  true,
  '{
     "leaderboard_weights": {
       "founder_wealth": 0.22,
       "enterprise_value": 0.18,
       "innovation": 0.15,
       "reputation": 0.12,
       "network": 0.10,
       "government": 0.10,
       "financial_resilience": 0.08,
       "session_objectives": 0.05
     },
     "ownership_thresholds": {
       "portfolio": 0.01,
       "strategic": 0.05,
       "major": 0.10,
       "board_pressure": 0.15,
       "voting_bloc": 0.25,
       "control": 0.50
     },
     "connection_gap_threshold": 10,
     "event_budget_per_quarter": 1.0,
     "npc_tiers": { "major": 6, "significant": 24, "background": 180 },
     "market": { "base_volatility": 0.12, "sector_beta": 1.0 }
   }'::jsonb,
  '0.1.0',
  null
);

insert into public.quarters (
  id, session_id, quarter_no, year, quarter_of_year, status, opened_at, resolver_version
) values (
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000001',
  1, 2027, 1, 'planning', now(), '0.1.0'
);

-- ---------------------------------------------------------------------------
-- Jurisdictions
-- ---------------------------------------------------------------------------

insert into public.jurisdictions (
  id, session_id, code, name, region, regulatory_stance, export_control_level,
  corporate_tax_rate, energy_cost_index, talent_index
) values
  ('0a000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
   'UF', 'United Federation', 'north_atlantic', 0.55, 0.42, 0.21, 1.00, 1.20),
  ('0a000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001',
   'EUZ', 'European Union Zone', 'europe', 0.78, 0.30, 0.26, 1.35, 1.05),
  ('0a000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001',
   'PAC', 'Pacific Compact', 'asia_pacific', 0.41, 0.55, 0.17, 0.88, 1.10);

-- ---------------------------------------------------------------------------
-- Companies — six major players, deliberately varied archetypes
-- ---------------------------------------------------------------------------

insert into public.companies (
  id, session_id, name, ticker, archetype, stage, tier, status, is_player_company,
  jurisdiction_id, founded_year, headquarters, tagline, description, thesis,
  is_public, listed_quarter, brand_trust, safety_orientation, attributes
) values
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
   'Nexus Intelligence', 'NXS', 'frontier_lab', 'public', 'major', 'active', false,
   '0a000000-0000-4000-8000-000000000001', 2019, 'Bay Federal District',
   'Scale is the shortest path.',
   'The largest independent frontier laboratory. Enormous training runs, an aggressive publication cadence and a chief executive who treats compute procurement as strategy.',
   'Dense scaling plus reasoning post-training reaches autonomous research first.',
   true, 1, 0.58, 0.44,
   '{"culture":"intense","publication_policy":"selective","open_weights":false}'::jsonb),

  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001',
   'Orbit Dynamics', 'ORB', 'applied_ai', 'public', 'major', 'active', false,
   '0a000000-0000-4000-8000-000000000001', 2020, 'Lakeshore',
   'Agents that finish the work.',
   'Enterprise agent platform. Weaker raw capability than Nexus, far better distribution, retention and services attach.',
   'Deployment surface beats benchmark leadership.',
   true, 1, 0.71, 0.62,
   '{"culture":"commercial","publication_policy":"rare","open_weights":false}'::jsonb),

  ('10000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001',
   'Helix Systems', 'HLX', 'infrastructure', 'public', 'major', 'active', false,
   '0a000000-0000-4000-8000-000000000001', 2016, 'Cascade Valley',
   'Capacity is the product.',
   'Datacentre and inference infrastructure operator. Sells capacity to everyone, including its competitors, and knows exactly how tight the market is before anyone else.',
   'Whoever owns power and cooling owns the margin in every AI cycle.',
   true, 1, 0.66, 0.51,
   '{"culture":"operational","publication_policy":"none","open_weights":false}'::jsonb),

  ('10000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001',
   'VectorWorks AI', 'VWA', 'vertical_ai', 'public', 'significant', 'active', false,
   '0a000000-0000-4000-8000-000000000002', 2021, 'Harbourgate',
   'Retrieval you can audit.',
   'Regulated-industry retrieval and reasoning. Excellent technology, deteriorating enterprise retention and a share price that has halved in three quarters.',
   'Verifiable retrieval wins the regulated half of the economy.',
   true, 1, 0.49, 0.74,
   '{"culture":"engineering","publication_policy":"open","open_weights":true}'::jsonb),

  ('10000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001',
   'Aurora Compute', 'ARC', 'semiconductor', 'public', 'major', 'active', false,
   '0a000000-0000-4000-8000-000000000003', 2014, 'Meridian Bay',
   'Silicon for the inference era.',
   'Designs specialised inference accelerators. Supply-constrained, politically exposed and the single largest determinant of everyone else''s training cost.',
   'Inference economics, not training records, decide the next decade.',
   true, 1, 0.63, 0.38,
   '{"culture":"hardware","publication_policy":"none","open_weights":false}'::jsonb),

  ('10000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000001',
   'Meridian Data', 'MRD', 'data_platform', 'public', 'significant', 'active', false,
   '0a000000-0000-4000-8000-000000000001', 2018, 'Old Quarter',
   'The corpus is the moat.',
   'Licensed corpora, synthetic data generation and evaluation infrastructure. Small revenue, disproportionate leverage over everyone''s training pipeline.',
   'Synthetic environments, not scraped text, produce the next capability jump.',
   true, 1, 0.55, 0.69,
   '{"culture":"research","publication_policy":"open","open_weights":true}'::jsonb);

-- ---------------------------------------------------------------------------
-- Government agencies
-- ---------------------------------------------------------------------------

insert into public.agencies (
  id, session_id, jurisdiction_id, code, name, mission, kind, annual_budget_usd,
  procurement_budget_usd, urgency, strictness, security_sensitivity,
  preferred_contract_type, priorities
) values
  ('60000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
   '0a000000-0000-4000-8000-000000000001', 'UFDOD', 'United Federation Department of Defence',
   'Sovereign capability, secure autonomy and assured access to frontier systems.',
   'defence', 780000000000, 61000000000, 0.82, 0.88, 0.95, 'cost_plus_incentive_fee',
   '["domestic_supply_chain","model_audit","data_sovereignty","assured_uptime"]'::jsonb),

  ('60000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001',
   '0a000000-0000-4000-8000-000000000001', 'UFBDM', 'Bureau of Digital Modernisation',
   'Replace legacy citizen-service systems without losing public trust.',
   'civil', 42000000000, 9400000000, 0.54, 0.61, 0.40, 'firm_fixed_price',
   '["cost_control","accessibility","transparency","vendor_diversity"]'::jsonb),

  ('60000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001',
   '0a000000-0000-4000-8000-000000000001', 'FAIOB', 'Federal AI Oversight Bureau',
   'Supervise frontier model deployment, incident reporting and concentration risk.',
   'regulator', 3100000000, 240000000, 0.66, 0.91, 0.72, 'other_transaction',
   '["incident_reporting","evaluation_standards","market_concentration"]'::jsonb);

-- ---------------------------------------------------------------------------
-- Characters — six chief executives, three investors, three directors,
-- one regulator, two journalists
-- ---------------------------------------------------------------------------

insert into public.characters (
  id, session_id, full_name, short_name, archetype, title, company_id, agency_id,
  organisation_label, bio, is_player_character, is_npc, connection_level,
  public_reputation, media_influence, personal_wealth_usd, status
) values
  ('20000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
   'Maya Chen', 'Maya', 'chief_executive', 'Chief Executive Officer',
   '10000000-0000-4000-8000-000000000001', null, 'Nexus Intelligence',
   'Founded Nexus after walking out of a research lab that would not fund her scaling plan. Brilliant, abrasive, and openly contemptuous of anyone who calls a training run reckless.',
   false, true, 86, 0.62, 0.71, 4100000000, 'active'),

  ('20000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001',
   'Daniel Okonkwo', 'Daniel', 'chief_executive', 'Chief Executive Officer',
   '10000000-0000-4000-8000-000000000002', null, 'Orbit Dynamics',
   'Career enterprise operator. Never claims the best model, always claims the shortest deployment. Boards find him restful; researchers find him unambitious.',
   false, true, 74, 0.70, 0.38, 890000000, 'active'),

  ('20000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001',
   'Priya Raghavan', 'Priya', 'chief_executive', 'Chief Executive Officer',
   '10000000-0000-4000-8000-000000000003', null, 'Helix Systems',
   'Ran power contracts before anyone thought power was interesting. Knows the real utilisation number of every laboratory that rents from her, and never says so.',
   false, true, 79, 0.64, 0.29, 1250000000, 'active'),

  ('20000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001',
   'Tomas Lindqvist', 'Tomas', 'chief_executive', 'Chief Executive Officer',
   '10000000-0000-4000-8000-000000000004', null, 'VectorWorks AI',
   'A researcher who became a chief executive by accident and is now two bad quarters from losing the job. Technically respected, commercially cornered.',
   false, true, 51, 0.47, 0.22, 96000000, 'active'),

  ('20000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001',
   'Rebecca Aldana', 'Rebecca', 'chief_executive', 'Chief Executive Officer',
   '10000000-0000-4000-8000-000000000005', null, 'Aurora Compute',
   'Runs the most supply-constrained business in the economy and allocates capacity the way a sovereign allocates favours.',
   false, true, 84, 0.58, 0.44, 2600000000, 'active'),

  ('20000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000001',
   'Kenji Watanabe', 'Kenji', 'chief_executive', 'Chief Executive Officer',
   '10000000-0000-4000-8000-000000000006', null, 'Meridian Data',
   'Believes the industry is scaling the wrong thing. Publishes constantly, monetises reluctantly, and is right often enough to be dangerous.',
   false, true, 62, 0.66, 0.51, 210000000, 'active'),

  ('20000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000001',
   'Eleanor Vance', 'Eleanor', 'investor', 'Managing Partner',
   null, null, 'Lattice Ventures',
   'Led the Nexus Series B and has never once let Maya forget the terms. Patient about returns, ruthless about governance.',
   false, true, 88, 0.72, 0.34, 780000000, 'active'),

  ('20000000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-000000000001',
   'Marcus Feld', 'Marcus', 'investor', 'Partner',
   null, null, 'Halberd Growth Partners',
   'Late-stage growth investor who prices optionality aggressively and exits without sentiment. Sits on four boards and reads none of the packets.',
   false, true, 76, 0.51, 0.27, 410000000, 'active'),

  ('20000000-0000-4000-8000-000000000009', '00000000-0000-4000-8000-000000000001',
   'Nadia Okafor', 'Nadia', 'investor', 'Chief Investment Officer',
   null, null, 'Al-Bahr Sovereign Fund',
   'Deploys sovereign capital at a scale that reprices whole sectors. Almost impossible to reach without an introduction, and entirely reachable once you have one.',
   false, true, 93, 0.68, 0.19, 0, 'active'),

  ('20000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000001',
   'Sarah Zhou', 'Sarah', 'director', 'Independent Director',
   null, null, 'Nexus Intelligence Board',
   'Former enterprise software chief executive. Reads the retention cohorts before the strategy deck and will say the uncomfortable number out loud in the meeting.',
   false, true, 69, 0.74, 0.23, 145000000, 'active'),

  ('20000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001',
   'Idris Bello', 'Idris', 'director', 'Independent Director',
   null, null, 'Nexus Intelligence Board',
   'Academic reasoning researcher on the Nexus board. The only director who can evaluate the science, and the least interested in the share price.',
   false, true, 64, 0.79, 0.36, 12000000, 'active'),

  ('20000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000001',
   'Grace Halloran', 'Grace', 'director', 'Independent Director',
   null, null, 'Orbit Dynamics Board',
   'Former chief financial officer of a public infrastructure group. Chairs audit committees and has ended two chief executives'' careers with a single question.',
   false, true, 71, 0.76, 0.18, 88000000, 'active'),

  ('20000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-000000000001',
   'Alan Prieto', 'Commissioner Prieto', 'regulator', 'Commissioner',
   null, '60000000-0000-4000-8000-000000000003', 'Federal AI Oversight Bureau',
   'Career civil servant with an unglamorous mandate and a very long memory. Concentration worries him more than capability does.',
   false, true, 81, 0.63, 0.42, 0, 'active'),

  ('20000000-0000-4000-8000-000000000014', '00000000-0000-4000-8000-000000000001',
   'Ines Duarte', 'Ines', 'journalist', 'Senior Correspondent',
   null, null, 'The Frontier Ledger',
   'Breaks the stories laboratories least want broken. Sources inside three of the six majors and a policy of never running a leak she cannot corroborate twice.',
   false, true, 72, 0.71, 0.83, 3000000, 'active'),

  ('20000000-0000-4000-8000-000000000015', '00000000-0000-4000-8000-000000000001',
   'Rowan Ellis', 'Rowan', 'journalist', 'Markets Editor',
   null, null, 'Capital Wire',
   'Covers the AI complex for people who trade it. Faster than Ines, less careful, and read by everyone with a position.',
   false, true, 66, 0.54, 0.77, 1800000, 'active');

-- ---------------------------------------------------------------------------
-- NPC founder seats
-- ---------------------------------------------------------------------------

insert into public.session_players (
  id, session_id, profile_id, character_id, company_id, is_human, seat_no, display_name, status
) values
  ('11000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
   null, '20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   false, 1, 'Maya Chen — Nexus Intelligence', 'active'),
  ('11000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001',
   null, '20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002',
   false, 2, 'Daniel Okonkwo — Orbit Dynamics', 'active'),
  ('11000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001',
   null, '20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003',
   false, 3, 'Priya Raghavan — Helix Systems', 'active'),
  ('11000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001',
   null, '20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000004',
   false, 4, 'Tomas Lindqvist — VectorWorks AI', 'active'),
  ('11000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001',
   null, '20000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000005',
   false, 5, 'Rebecca Aldana — Aurora Compute', 'active'),
  ('11000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000001',
   null, '20000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000006',
   false, 6, 'Kenji Watanabe — Meridian Data', 'active');

update public.companies c
set controlled_by_player_id = sp.id
from public.session_players sp
where sp.company_id = c.id
  and sp.session_id = '00000000-0000-4000-8000-000000000001'
  and c.session_id = '00000000-0000-4000-8000-000000000001';

-- ---------------------------------------------------------------------------
-- Character traits — stable dispositions and current beliefs
-- ---------------------------------------------------------------------------

insert into public.character_traits (
  id, session_id, character_id, trait_key, kind, value, is_public, updated_quarter
)
select
  ('d0000000-0000-4000-8000-' || lpad(t.n::text, 12, '0'))::uuid,
  '00000000-0000-4000-8000-000000000001'::uuid,
  t.character_id::uuid,
  t.trait_key,
  t.kind::public.trait_kind,
  t.value,
  t.is_public,
  1
from (values
  -- Maya Chen
  (1,  '20000000-0000-4000-8000-000000000001', 'risk_tolerance',        'stable', 89.0, false),
  (2,  '20000000-0000-4000-8000-000000000001', 'technical_orientation', 'stable', 96.0, true),
  (3,  '20000000-0000-4000-8000-000000000001', 'financial_conservatism','stable', 27.0, false),
  (4,  '20000000-0000-4000-8000-000000000001', 'aggressiveness',        'stable', 83.0, true),
  (5,  '20000000-0000-4000-8000-000000000001', 'status_sensitivity',    'stable', 66.0, false),
  (6,  '20000000-0000-4000-8000-000000000001', 'belief_compute_scarcity','belief', 82.0, false),
  (7,  '20000000-0000-4000-8000-000000000001', 'belief_regulation_risk','belief', 48.0, false),
  (8,  '20000000-0000-4000-8000-000000000001', 'loyalty_to_research',   'preference', 91.0, false),
  -- Daniel Okonkwo
  (9,  '20000000-0000-4000-8000-000000000002', 'risk_tolerance',        'stable', 41.0, false),
  (10, '20000000-0000-4000-8000-000000000002', 'technical_orientation', 'stable', 58.0, true),
  (11, '20000000-0000-4000-8000-000000000002', 'financial_conservatism','stable', 74.0, true),
  (12, '20000000-0000-4000-8000-000000000002', 'commercial_instinct',   'skill',  88.0, true),
  -- Priya Raghavan
  (13, '20000000-0000-4000-8000-000000000003', 'risk_tolerance',        'stable', 55.0, false),
  (14, '20000000-0000-4000-8000-000000000003', 'financial_conservatism','stable', 69.0, true),
  (15, '20000000-0000-4000-8000-000000000003', 'operational_discipline','skill',  93.0, true),
  (16, '20000000-0000-4000-8000-000000000003', 'information_advantage', 'skill',  86.0, false),
  -- Tomas Lindqvist
  (17, '20000000-0000-4000-8000-000000000004', 'risk_tolerance',        'stable', 34.0, false),
  (18, '20000000-0000-4000-8000-000000000004', 'technical_orientation', 'stable', 91.0, true),
  (19, '20000000-0000-4000-8000-000000000004', 'status_sensitivity',    'stable', 72.0, false),
  (20, '20000000-0000-4000-8000-000000000004', 'belief_own_survival',   'belief', 38.0, false),
  -- Rebecca Aldana
  (21, '20000000-0000-4000-8000-000000000005', 'risk_tolerance',        'stable', 62.0, false),
  (22, '20000000-0000-4000-8000-000000000005', 'aggressiveness',        'stable', 77.0, true),
  (23, '20000000-0000-4000-8000-000000000005', 'financial_conservatism','stable', 51.0, false),
  (24, '20000000-0000-4000-8000-000000000005', 'allocation_leverage',   'skill',  94.0, true),
  -- Kenji Watanabe
  (25, '20000000-0000-4000-8000-000000000006', 'risk_tolerance',        'stable', 68.0, false),
  (26, '20000000-0000-4000-8000-000000000006', 'technical_orientation', 'stable', 89.0, true),
  (27, '20000000-0000-4000-8000-000000000006', 'openness',              'stable', 92.0, true),
  (28, '20000000-0000-4000-8000-000000000006', 'belief_synthetic_data', 'belief', 88.0, true),
  -- Eleanor Vance
  (29, '20000000-0000-4000-8000-000000000007', 'governance_focus',      'stable', 91.0, true),
  (30, '20000000-0000-4000-8000-000000000007', 'risk_tolerance',        'stable', 57.0, false),
  (31, '20000000-0000-4000-8000-000000000007', 'patience',              'stable', 78.0, false),
  -- Marcus Feld
  (32, '20000000-0000-4000-8000-000000000008', 'risk_tolerance',        'stable', 71.0, false),
  (33, '20000000-0000-4000-8000-000000000008', 'financial_conservatism','stable', 33.0, false),
  (34, '20000000-0000-4000-8000-000000000008', 'attention',             'stable', 29.0, false),
  -- Nadia Okafor
  (35, '20000000-0000-4000-8000-000000000009', 'risk_tolerance',        'stable', 44.0, false),
  (36, '20000000-0000-4000-8000-000000000009', 'strategic_horizon',     'stable', 95.0, true),
  (37, '20000000-0000-4000-8000-000000000009', 'status_sensitivity',    'stable', 81.0, false),
  -- Sarah Zhou
  (38, '20000000-0000-4000-8000-000000000010', 'independence',          'stable', 88.0, true),
  (39, '20000000-0000-4000-8000-000000000010', 'financial_discipline',  'stable', 84.0, true),
  (40, '20000000-0000-4000-8000-000000000010', 'growth_preference',     'stable', 46.0, false),
  -- Idris Bello
  (41, '20000000-0000-4000-8000-000000000011', 'independence',          'stable', 92.0, true),
  (42, '20000000-0000-4000-8000-000000000011', 'technology_knowledge',  'stable', 95.0, true),
  (43, '20000000-0000-4000-8000-000000000011', 'safety_orientation',    'stable', 79.0, true),
  -- Grace Halloran
  (44, '20000000-0000-4000-8000-000000000012', 'independence',          'stable', 86.0, true),
  (45, '20000000-0000-4000-8000-000000000012', 'financial_discipline',  'stable', 96.0, true),
  (46, '20000000-0000-4000-8000-000000000012', 'risk_tolerance',        'stable', 28.0, false),
  -- Alan Prieto
  (47, '20000000-0000-4000-8000-000000000013', 'strictness',            'stable', 84.0, true),
  (48, '20000000-0000-4000-8000-000000000013', 'concentration_concern', 'belief', 77.0, true),
  (49, '20000000-0000-4000-8000-000000000013', 'political_exposure',    'stable', 63.0, false),
  -- Ines Duarte
  (50, '20000000-0000-4000-8000-000000000014', 'rigour',                'stable', 88.0, true),
  (51, '20000000-0000-4000-8000-000000000014', 'source_network',        'skill',  85.0, false),
  (52, '20000000-0000-4000-8000-000000000014', 'adversarial_stance',    'stable', 67.0, true),
  -- Rowan Ellis
  (53, '20000000-0000-4000-8000-000000000015', 'speed',                 'stable', 92.0, true),
  (54, '20000000-0000-4000-8000-000000000015', 'rigour',                'stable', 54.0, false),
  (55, '20000000-0000-4000-8000-000000000015', 'market_influence',      'skill',  81.0, true)
) as t(n, character_id, trait_key, kind, value, is_public);

-- ---------------------------------------------------------------------------
-- Relationships — directional, and mostly asymmetric on purpose
-- ---------------------------------------------------------------------------

insert into public.relationships (
  id, session_id, from_character_id, to_character_id,
  trust, respect, hostility, dependence, familiarity, access_override, last_interaction_quarter
)
select
  ('c0000000-0000-4000-8000-' || lpad(r.n::text, 12, '0'))::uuid,
  '00000000-0000-4000-8000-000000000001'::uuid,
  r.from_id::uuid, r.to_id::uuid,
  r.trust, r.respect, r.hostility, r.dependence, r.familiarity,
  r.access_override, 1
from (values
  (1,  '20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000007',
       46.0, 78.0, 34.0, 62.0, 88.0, 'shared_board'),
  (2,  '20000000-0000-4000-8000-000000000007', '20000000-0000-4000-8000-000000000001',
       58.0, 84.0, 21.0, 41.0, 88.0, 'shared_board'),
  (3,  '20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000010',
       39.0, 71.0, 44.0, 28.0, 74.0, 'shared_board'),
  (4,  '20000000-0000-4000-8000-000000000010', '20000000-0000-4000-8000-000000000001',
       42.0, 66.0, 31.0, 12.0, 74.0, 'shared_board'),
  (5,  '20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000005',
       31.0, 88.0, 52.0, 79.0, 61.0, null),
  (6,  '20000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000001',
       44.0, 72.0, 38.0, 24.0, 61.0, null),
  (7,  '20000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001',
       33.0, 69.0, 57.0, 18.0, 49.0, null),
  (8,  '20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002',
       36.0, 41.0, 48.0, 9.0,  49.0, null),
  (9,  '20000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000005',
       61.0, 74.0, 22.0, 71.0, 66.0, null),
  (10, '20000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000008',
       28.0, 44.0, 61.0, 83.0, 57.0, null),
  (11, '20000000-0000-4000-8000-000000000008', '20000000-0000-4000-8000-000000000004',
       31.0, 29.0, 22.0, 11.0, 57.0, null),
  (12, '20000000-0000-4000-8000-000000000007', '20000000-0000-4000-8000-000000000009',
       67.0, 81.0, 6.0,  38.0, 52.0, 'shared_investor'),
  (13, '20000000-0000-4000-8000-000000000006', '20000000-0000-4000-8000-000000000001',
       24.0, 52.0, 66.0, 31.0, 44.0, null),
  (14, '20000000-0000-4000-8000-000000000013', '20000000-0000-4000-8000-000000000001',
       29.0, 63.0, 54.0, 4.0,  38.0, null),
  (15, '20000000-0000-4000-8000-000000000014', '20000000-0000-4000-8000-000000000001',
       36.0, 68.0, 41.0, 22.0, 63.0, 'media'),
  (16, '20000000-0000-4000-8000-000000000011', '20000000-0000-4000-8000-000000000006',
       78.0, 89.0, 3.0,  8.0,  71.0, null)
) as r(n, from_id, to_id, trust, respect, hostility, dependence, familiarity, access_override);

-- ---------------------------------------------------------------------------
-- Connection scores for the opening quarter
-- ---------------------------------------------------------------------------

insert into public.connection_scores (
  id, session_id, character_id, player_id, quarter, score, components, rank
)
select
  ('13000000-0000-4000-8000-' || lpad((row_number() over (order by ch.connection_level desc, ch.id))::text, 12, '0'))::uuid,
  ch.session_id,
  ch.id,
  sp.id,
  1,
  ch.connection_level,
  jsonb_build_object(
    'founder_reputation', round(ch.public_reputation * 100, 2),
    'media_influence', round(ch.media_influence * 100, 2),
    'personal_wealth_usd', ch.personal_wealth_usd
  ),
  (row_number() over (order by ch.connection_level desc, ch.id))::integer
from public.characters ch
left join public.session_players sp
  on sp.character_id = ch.id and sp.session_id = ch.session_id
where ch.session_id = '00000000-0000-4000-8000-000000000001';

-- ---------------------------------------------------------------------------
-- Executives
-- ---------------------------------------------------------------------------

insert into public.executives (
  id, session_id, company_id, character_id, role, title, appointed_quarter,
  is_active, performance, loyalty, compensation
) values
  ('a0000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
   'ceo', 'Chief Executive Officer', 1, true, 0.78, 0.95,
   '{"base_usd":950000,"equity_percent":0.121,"performance_multiple":2.5}'::jsonb),
  ('a0000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002',
   'ceo', 'Chief Executive Officer', 1, true, 0.71, 0.82,
   '{"base_usd":1100000,"equity_percent":0.034,"performance_multiple":2.0}'::jsonb),
  ('a0000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000003',
   'ceo', 'Chief Executive Officer', 1, true, 0.84, 0.88,
   '{"base_usd":1250000,"equity_percent":0.058,"performance_multiple":1.8}'::jsonb),
  ('a0000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000004',
   'ceo', 'Chief Executive Officer', 1, true, 0.41, 0.63,
   '{"base_usd":720000,"equity_percent":0.089,"performance_multiple":2.2}'::jsonb),
  ('a0000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000005',
   'ceo', 'Chief Executive Officer', 1, true, 0.88, 0.79,
   '{"base_usd":1400000,"equity_percent":0.027,"performance_multiple":3.0}'::jsonb),
  ('a0000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000006', '20000000-0000-4000-8000-000000000006',
   'ceo', 'Chief Executive Officer', 1, true, 0.66, 0.91,
   '{"base_usd":540000,"equity_percent":0.187,"performance_multiple":1.5}'::jsonb);

-- ---------------------------------------------------------------------------
-- Flagship products
-- ---------------------------------------------------------------------------

insert into public.products (
  id, session_id, company_id, name, category, status, launched_quarter, price_usd,
  pricing_model, capability_score, quality_score, reliability, inference_cost_usd,
  seats, customers, arr_usd, churn_rate, unit_economics
) values
  ('15000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000001', 'Nexus Frontier API', 'model_api', 'launched', 1,
   0.000012, 'usage', 0.91, 0.84, 0.985, 0.0000041, 0, 4200, 7400000000, 0.07,
   '{"gross_margin":0.62,"cac_usd":41000,"payback_quarters":3.1}'::jsonb),
  ('15000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000002', 'Orbit Workbench', 'enterprise_agent', 'launched', 1,
   38.00, 'per_seat', 0.74, 0.89, 0.997, 0.31, 1840000, 2600, 4900000000, 0.04,
   '{"gross_margin":0.71,"cac_usd":18000,"payback_quarters":2.2}'::jsonb),
  ('15000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000003', 'Helix Reserved Capacity', 'infrastructure', 'launched', 1,
   2.85, 'usage', 0.55, 0.92, 0.9995, 1.44, 0, 310, 6100000000, 0.02,
   '{"gross_margin":0.38,"utilisation":0.91}'::jsonb),
  ('15000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000004', 'VectorWorks Ledger', 'retrieval', 'launched', 1,
   64.00, 'per_seat', 0.68, 0.81, 0.991, 0.22, 214000, 480, 690000000, 0.14,
   '{"gross_margin":0.66,"cac_usd":52000,"payback_quarters":5.8}'::jsonb),
  ('15000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000005', 'Aurora AX-7 Accelerator', 'silicon', 'launched', 1,
   28500.00, 'flat', 0.87, 0.94, 0.999, 0, 0, 92, 14800000000, 0.01,
   '{"gross_margin":0.57,"backlog_quarters":6}'::jsonb),
  ('15000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000006', 'Meridian Synthesis', 'data_platform', 'launched', 1,
   0.41, 'usage', 0.63, 0.86, 0.994, 0.09, 0, 140, 820000000, 0.06,
   '{"gross_margin":0.74,"corpus_licences":38}'::jsonb);

-- ---------------------------------------------------------------------------
-- Opening quarter financials
-- ---------------------------------------------------------------------------

insert into public.company_quarter_metrics (
  id, session_id, company_id, quarter,
  revenue_usd, cogs_usd, gross_profit_usd, rnd_usd, sales_marketing_usd, general_admin_usd,
  operating_income_usd, interest_expense_usd, tax_usd, net_income_usd, free_cash_flow_usd,
  cash_usd, debt_usd, total_assets_usd, total_liabilities_usd, equity_usd,
  burn_rate_usd, runway_quarters, headcount, compute_units, customers, arr_usd,
  net_revenue_retention, enterprise_value_usd, valuation_anchor_usd, valuation_method
) values
  ('b0000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000001', 1,
   1850000000, 703000000, 1147000000, 980000000, 260000000, 140000000,
   -233000000, 11000000, 0, -244000000, -312000000,
   9400000000, 500000000, 16800000000, 3100000000, 13700000000,
   312000000, 30.1, 3100, 220000, 4200, 7400000000,
   1.24, 51584000000, 44100000000, 'technology_option_value'),
  ('b0000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000002', 1,
   1225000000, 355000000, 870000000, 288000000, 341000000, 118000000,
   123000000, 6000000, 27000000, 90000000, 141000000,
   3900000000, 300000000, 7100000000, 1900000000, 5200000000,
   0, null, 4281, 34000, 2600, 4900000000,
   1.17, 22528800000, 24300000000, 'forward_revenue_multiple'),
  ('b0000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000003', 1,
   1525000000, 945000000, 580000000, 74000000, 61000000, 92000000,
   353000000, 148000000, 44000000, 161000000, 96000000,
   1800000000, 8600000000, 24500000000, 12100000000, 12400000000,
   0, null, 2140, 640000, 310, 6100000000,
   1.09, 23513500000, 26800000000, 'cash_flow_and_asset_value'),
  ('b0000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000004', 1,
   172500000, 58600000, 113900000, 96000000, 71000000, 34000000,
   -87100000, 4000000, 0, -91100000, -104000000,
   640000000, 220000000, 1350000000, 480000000, 870000000,
   104000000, 6.2, 1180, 9800, 480, 690000000,
   0.88, 5673000000, 7350000000, 'forward_revenue_multiple'),
  ('b0000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000005', 1,
   3700000000, 1591000000, 2109000000, 620000000, 210000000, 165000000,
   1114000000, 39000000, 231000000, 844000000, 712000000,
   12600000000, 2400000000, 31000000000, 7900000000, 23100000000,
   0, null, 6420, 0, 92, 14800000000,
   1.41, 100932000000, 84000000000, 'earnings_growth_balance_sheet'),
  ('b0000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000006', 1,
   205000000, 53300000, 151700000, 88000000, 41000000, 29000000,
   -6300000, 1000000, 0, -7300000, 4000000,
   410000000, 60000000, 980000000, 210000000, 770000000,
   0, null, 640, 12000, 140, 820000000,
   1.11, 6799000000, 7900000000, 'revenue_multiple_with_option_value');

-- ---------------------------------------------------------------------------
-- Compute and capacity commitments
-- ---------------------------------------------------------------------------

insert into public.company_resources (
  id, session_id, company_id, kind, provider, quantity, unit, unit_cost_usd,
  committed_from_quarter, committed_until_quarter, utilisation, is_cancellable, terms
) values
  ('16000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000001', 'accelerator_reservation', 'Helix Systems',
   180000, 'accelerator_equivalent', 2.85, 1, 8, 0.94, false,
   '{"take_or_pay":true,"penalty_percent":0.35}'::jsonb),
  ('16000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000002', 'accelerator_reservation', 'Helix Systems',
   34000, 'accelerator_equivalent', 2.91, 1, 5, 0.81, true,
   '{"take_or_pay":false}'::jsonb),
  ('16000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000003', 'energy_contract', 'Cascade Grid Authority',
   2400, 'megawatt', 41.20, 1, 24, 0.88, false,
   '{"indexation":"cpi","curtailment_risk":0.12}'::jsonb),
  ('16000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000004', 'accelerator_spot', 'Open market',
   9800, 'accelerator_equivalent', 4.15, 1, 2, 0.72, true,
   '{"price_exposure":"spot"}'::jsonb),
  ('16000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000006', 'data_licence', 'Consortium of publishers',
   38, 'corpus', 1400000.00, 1, 12, 1.00, false,
   '{"exclusive":false,"audit_rights":true}'::jsonb);

-- ---------------------------------------------------------------------------
-- Workforce
-- ---------------------------------------------------------------------------

insert into public.employees_agg (
  id, session_id, company_id, quarter, job_function, headcount, hired, departed,
  avg_salary_usd, avg_seniority, attrition_rate, morale, productivity, open_requisitions
)
select
  ('17000000-0000-4000-8000-' || lpad(e.n::text, 12, '0'))::uuid,
  '00000000-0000-4000-8000-000000000001'::uuid,
  e.company_id::uuid,
  1,
  e.job_function,
  e.headcount,
  e.hired,
  e.departed,
  e.avg_salary_usd,
  e.avg_seniority,
  e.attrition_rate,
  e.morale,
  e.productivity,
  e.open_requisitions
from (values
  (1,  '10000000-0000-4000-8000-000000000001', 'research',       740, 61, 22, 620000.0, 0.78, 0.03, 0.71, 1.22, 90),
  (2,  '10000000-0000-4000-8000-000000000001', 'engineering',   1180, 88, 47, 410000.0, 0.62, 0.04, 0.64, 1.08, 140),
  (3,  '10000000-0000-4000-8000-000000000001', 'infrastructure', 420, 24, 11, 380000.0, 0.66, 0.03, 0.69, 1.11, 40),
  (4,  '10000000-0000-4000-8000-000000000001', 'sales',          310, 18, 14, 290000.0, 0.51, 0.05, 0.58, 0.94, 55),
  (5,  '10000000-0000-4000-8000-000000000001', 'safety',          90,  9,  6, 440000.0, 0.72, 0.07, 0.42, 0.88, 24),
  (6,  '10000000-0000-4000-8000-000000000001', 'g_and_a',        360, 12,  9, 210000.0, 0.55, 0.04, 0.66, 1.00, 12),
  (7,  '10000000-0000-4000-8000-000000000002', 'engineering',   1420, 74, 41, 340000.0, 0.61, 0.03, 0.74, 1.09, 95),
  (8,  '10000000-0000-4000-8000-000000000002', 'sales',         1180, 92, 58, 260000.0, 0.58, 0.05, 0.71, 1.14, 130),
  (9,  '10000000-0000-4000-8000-000000000002', 'support',        810, 44, 39, 145000.0, 0.44, 0.06, 0.68, 0.97, 60),
  (10, '10000000-0000-4000-8000-000000000002', 'research',       270, 14,  9, 520000.0, 0.69, 0.04, 0.62, 1.02, 30),
  (11, '10000000-0000-4000-8000-000000000002', 'g_and_a',        601, 16, 12, 190000.0, 0.52, 0.03, 0.72, 1.00, 18),
  (12, '10000000-0000-4000-8000-000000000003', 'infrastructure', 1290, 51, 28, 285000.0, 0.64, 0.03, 0.77, 1.16, 70),
  (13, '10000000-0000-4000-8000-000000000003', 'operations',      520, 22, 15, 165000.0, 0.49, 0.04, 0.73, 1.05, 34),
  (14, '10000000-0000-4000-8000-000000000003', 'sales',           160, 11,  6, 310000.0, 0.61, 0.04, 0.70, 1.03, 12),
  (15, '10000000-0000-4000-8000-000000000003', 'g_and_a',         170,  6,  4, 195000.0, 0.53, 0.03, 0.75, 1.00, 8),
  (16, '10000000-0000-4000-8000-000000000004', 'engineering',     520, 12, 61, 320000.0, 0.67, 0.11, 0.38, 0.86, 6),
  (17, '10000000-0000-4000-8000-000000000004', 'research',        190,  4, 27, 480000.0, 0.74, 0.13, 0.33, 0.81, 0),
  (18, '10000000-0000-4000-8000-000000000004', 'sales',           310, 21, 34, 240000.0, 0.48, 0.10, 0.41, 0.79, 14),
  (19, '10000000-0000-4000-8000-000000000004', 'g_and_a',         160,  3,  9, 175000.0, 0.50, 0.06, 0.47, 0.95, 2),
  (20, '10000000-0000-4000-8000-000000000005', 'engineering',    3100, 128, 74, 365000.0, 0.71, 0.02, 0.79, 1.19, 210),
  (21, '10000000-0000-4000-8000-000000000005', 'operations',     2140, 96, 61, 128000.0, 0.42, 0.04, 0.68, 1.04, 140),
  (22, '10000000-0000-4000-8000-000000000005', 'sales',           620, 34, 18, 295000.0, 0.63, 0.03, 0.81, 1.22, 40),
  (23, '10000000-0000-4000-8000-000000000005', 'g_and_a',         560, 14, 11, 205000.0, 0.55, 0.03, 0.74, 1.00, 20),
  (24, '10000000-0000-4000-8000-000000000006', 'research',        280, 19,  7, 470000.0, 0.76, 0.02, 0.84, 1.27, 34),
  (25, '10000000-0000-4000-8000-000000000006', 'engineering',     240, 11,  8, 335000.0, 0.60, 0.03, 0.78, 1.09, 22),
  (26, '10000000-0000-4000-8000-000000000006', 'g_and_a',         120,  4,  3, 180000.0, 0.51, 0.03, 0.80, 1.00, 6)
) as e(n, company_id, job_function, headcount, hired, departed, avg_salary_usd,
       avg_seniority, attrition_rate, morale, productivity, open_requisitions);

-- ---------------------------------------------------------------------------
-- Cap tables
-- ---------------------------------------------------------------------------

insert into public.share_classes (
  id, session_id, company_id, code, name, votes_per_share, liquidation_preference,
  is_super_voting, seniority, authorized_shares, issued_shares, par_value_usd
) values
  ('30000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000001', 'common', 'Class A Common', 1, 1, false, 0,
   900000000, 620000000, 0.0001),
  ('30000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000002', 'common', 'Common Stock', 1, 1, false, 0,
   800000000, 540000000, 0.0001),
  ('30000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000003', 'common', 'Common Stock', 1, 1, false, 0,
   600000000, 410000000, 0.0001),
  ('30000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000004', 'common', 'Common Stock', 1, 1, false, 0,
   500000000, 300000000, 0.0001),
  ('30000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000005', 'common', 'Common Stock', 1, 1, false, 0,
   1000000000, 780000000, 0.0001),
  ('30000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000006', 'common', 'Common Stock', 1, 1, false, 0,
   400000000, 260000000, 0.0001),
  -- Maya Chen's founder super-voting class: 12% of the economics, 40% of the votes.
  ('30000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000001', 'founder_b', 'Class B Founder', 10, 1, true, 1,
   120000000, 75000000, 0.0001);

insert into public.securities (
  id, session_id, company_id, share_class_id, kind, symbol, name, is_listed,
  listed_quarter, currency
) values
  ('31000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001',
   'common_equity', 'NXS', 'Nexus Intelligence Class A Common', true, 1, 'USD'),
  ('31000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002',
   'common_equity', 'ORB', 'Orbit Dynamics Common', true, 1, 'USD'),
  ('31000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000003',
   'common_equity', 'HLX', 'Helix Systems Common', true, 1, 'USD'),
  ('31000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000004', '30000000-0000-4000-8000-000000000004',
   'common_equity', 'VWA', 'VectorWorks AI Common', true, 1, 'USD'),
  ('31000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000005', '30000000-0000-4000-8000-000000000005',
   'common_equity', 'ARC', 'Aurora Compute Common', true, 1, 'USD'),
  ('31000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000006', '30000000-0000-4000-8000-000000000006',
   'common_equity', 'MRD', 'Meridian Data Common', true, 1, 'USD'),
  ('31000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000007',
   'common_equity', null, 'Nexus Intelligence Class B Founder', false, null, 'USD');

insert into public.holdings (
  id, session_id, security_id, company_id, holder_kind, holder_player_id,
  holder_character_id, holder_company_id, holder_institution, shares,
  cost_basis_usd, acquired_quarter, is_disclosed, disclosed_quarter
) values
  -- Nexus founder bloc: economics small, votes decisive.
  ('32000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
   '31000000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000001',
   'character', null, '20000000-0000-4000-8000-000000000001', null, null,
   75000000, 7500, 1, true, 1),
  ('32000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001',
   '31000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'institution', null, null, null, 'Lattice Ventures',
   96000000, 1180000000, 1, true, 1),
  ('32000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001',
   '31000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'institution', null, null, null, 'Halberd Growth Partners',
   43000000, 940000000, 1, true, 1),
  ('32000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001',
   '31000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'public_float', null, null, null, 'Public float',
   481000000, 0, 1, true, 1),
  ('32000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001',
   '31000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002',
   'character', null, '20000000-0000-4000-8000-000000000002', null, null,
   18400000, 61000000, 1, true, 1),
  ('32000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000001',
   '31000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002',
   'public_float', null, null, null, 'Public float',
   521600000, 0, 1, true, 1),
  ('32000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000001',
   '31000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003',
   'character', null, '20000000-0000-4000-8000-000000000003', null, null,
   23800000, 94000000, 1, true, 1),
  ('32000000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-000000000001',
   '31000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003',
   'institution', null, null, null, 'Al-Bahr Sovereign Fund',
   61500000, 2900000000, 1, true, 1),
  ('32000000-0000-4000-8000-000000000009', '00000000-0000-4000-8000-000000000001',
   '31000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003',
   'public_float', null, null, null, 'Public float',
   324700000, 0, 1, true, 1),
  ('32000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000001',
   '31000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000004',
   'character', null, '20000000-0000-4000-8000-000000000004', null, null,
   26100000, 41000000, 1, true, 1),
  ('32000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001',
   '31000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000004',
   'institution', null, null, null, 'Halberd Growth Partners',
   58200000, 1640000000, 1, true, 1),
  ('32000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000001',
   '31000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000004',
   'public_float', null, null, null, 'Public float',
   215700000, 0, 1, true, 1),
  ('32000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-000000000001',
   '31000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000005',
   'character', null, '20000000-0000-4000-8000-000000000005', null, null,
   21060000, 118000000, 1, true, 1),
  ('32000000-0000-4000-8000-000000000014', '00000000-0000-4000-8000-000000000001',
   '31000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000005',
   'public_float', null, null, null, 'Public float',
   758940000, 0, 1, true, 1),
  ('32000000-0000-4000-8000-000000000015', '00000000-0000-4000-8000-000000000001',
   '31000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000006',
   'character', null, '20000000-0000-4000-8000-000000000006', null, null,
   48620000, 8100000, 1, true, 1),
  ('32000000-0000-4000-8000-000000000016', '00000000-0000-4000-8000-000000000001',
   '31000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000006',
   'public_float', null, null, null, 'Public float',
   199980000, 0, 1, true, 1),
  -- Nexus holds a strategic position in Meridian Data: below the disclosure
  -- threshold, so no other player can see it yet.
  ('32000000-0000-4000-8000-000000000017', '00000000-0000-4000-8000-000000000001',
   '31000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000006',
   'company', null, null, '10000000-0000-4000-8000-000000000001', null,
   11400000, 274000000, 1, false, null);

insert into public.funding_rounds (
  id, session_id, company_id, quarter, round_type, status, target_amount_usd,
  amount_usd, pre_money_usd, post_money_usd, price_per_share_usd, dilution,
  share_class_id, lead_investor, investors, board_seats_granted, is_announced,
  opened_quarter, closed_quarter
) values
  ('33000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000001', 1, 'ipo', 'closed',
   4000000000, 4400000000, 38000000000, 42400000000, 71.00, 0.104,
   '30000000-0000-4000-8000-000000000001', 'Lattice Ventures',
   '[{"name":"Lattice Ventures","amount_usd":900000000},{"name":"Al-Bahr Sovereign Fund","amount_usd":1200000000}]'::jsonb,
   1, true, 1, 1),
  ('33000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000004', 1, 'bridge', 'marketing',
   400000000, 0, 5100000000, null, null, null,
   '30000000-0000-4000-8000-000000000004', 'Halberd Growth Partners',
   '[{"name":"Halberd Growth Partners","amount_usd":250000000,"status":"soft_circled"}]'::jsonb,
   0, false, 1, null);

-- ---------------------------------------------------------------------------
-- The Nexus board: founder, two investors, two independents
-- ---------------------------------------------------------------------------

insert into public.boards (
  id, session_id, company_id, seats_total, quorum_rule, decision_rule, charter
) values (
  '50000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001', 5, 'majority', 'majority_of_quorum',
  '{"reserved_matters":["financing","acquisition","ipo","ceo_dismissal","major_model_release"],
    "supermajority_matters":["ceo_dismissal","bylaw_change"]}'::jsonb
);

insert into public.board_seats (
  id, session_id, board_id, company_id, character_id, seat_kind, seat_no, constituency,
  is_chair, voting_power, independence, risk_tolerance, growth_preference,
  financial_discipline, technology_knowledge, safety_orientation, appointed_quarter, is_active
) values
  ('51000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
   '50000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   '20000000-0000-4000-8000-000000000001', 'founder', 1, 'Founder and chief executive',
   true, 1, 0.05, 0.89, 0.94, 0.27, 0.96, 0.44, 1, true),
  ('51000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001',
   '50000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   '20000000-0000-4000-8000-000000000007', 'investor', 2, 'Lattice Ventures (Series B lead)',
   false, 1, 0.22, 0.57, 0.71, 0.74, 0.62, 0.58, 1, true),
  ('51000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001',
   '50000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   '20000000-0000-4000-8000-000000000008', 'investor', 3, 'Halberd Growth Partners',
   false, 1, 0.18, 0.71, 0.83, 0.33, 0.41, 0.24, 1, true),
  ('51000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001',
   '50000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   '20000000-0000-4000-8000-000000000011', 'independent', 4, 'Independent — research and safety',
   false, 1, 0.92, 0.44, 0.38, 0.55, 0.95, 0.79, 1, true),
  ('51000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001',
   '50000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   '20000000-0000-4000-8000-000000000010', 'independent', 5, 'Independent — enterprise operations',
   false, 1, 0.88, 0.36, 0.46, 0.84, 0.61, 0.52, 1, true);

update public.boards
set chair_seat_id = '51000000-0000-4000-8000-000000000001'
where id = '50000000-0000-4000-8000-000000000001';

-- ---------------------------------------------------------------------------
-- In-world exchange: six equities and two indices
-- ---------------------------------------------------------------------------

insert into public.market_instruments (
  id, session_id, kind, symbol, name, company_id, security_id, is_reference, sector,
  beta_market, beta_sector, idiosyncratic_vol, shares_outstanding, free_float,
  listed_quarter, metadata
) values
  ('40000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
   'equity', 'NXS', 'Nexus Intelligence', '10000000-0000-4000-8000-000000000001',
   '31000000-0000-4000-8000-000000000001', false, 'frontier_ai',
   1.34, 1.22, 0.28, 620000000, 0.78, 1, '{"index_member":["FCAI"]}'::jsonb),
  ('40000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001',
   'equity', 'ORB', 'Orbit Dynamics', '10000000-0000-4000-8000-000000000002',
   '31000000-0000-4000-8000-000000000002', false, 'applied_ai',
   1.05, 0.94, 0.18, 540000000, 0.97, 1, '{"index_member":["FCAI"]}'::jsonb),
  ('40000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001',
   'equity', 'HLX', 'Helix Systems', '10000000-0000-4000-8000-000000000003',
   '31000000-0000-4000-8000-000000000003', false, 'infrastructure',
   0.92, 1.11, 0.21, 410000000, 0.79, 1, '{"index_member":["FCAI","FCSC"]}'::jsonb),
  ('40000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001',
   'equity', 'VWA', 'VectorWorks AI', '10000000-0000-4000-8000-000000000004',
   '31000000-0000-4000-8000-000000000004', false, 'applied_ai',
   1.42, 1.08, 0.41, 300000000, 0.72, 1, '{"index_member":["FCAI"]}'::jsonb),
  ('40000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001',
   'equity', 'ARC', 'Aurora Compute', '10000000-0000-4000-8000-000000000005',
   '31000000-0000-4000-8000-000000000005', false, 'semiconductors',
   1.51, 1.38, 0.33, 780000000, 0.97, 1, '{"index_member":["FCAI","FCSC"]}'::jsonb),
  ('40000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000001',
   'equity', 'MRD', 'Meridian Data', '10000000-0000-4000-8000-000000000006',
   '31000000-0000-4000-8000-000000000006', false, 'data_platform',
   1.18, 0.87, 0.36, 260000000, 0.81, 1, '{"index_member":["FCAI"]}'::jsonb),
  ('40000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000001',
   'index', 'FCAI', 'Frontier Capital AI 50', null, null, false, 'broad_ai',
   1.00, 1.00, 0.11, null, null, 1,
   '{"base_level":1000,"constituents":["NXS","ORB","HLX","VWA","ARC","MRD"]}'::jsonb),
  ('40000000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-000000000001',
   'index', 'FCSC', 'Frontier Semiconductor & Compute Index', null, null, false, 'semiconductors',
   1.21, 1.00, 0.17, null, null, 1,
   '{"base_level":1000,"constituents":["ARC","HLX"]}'::jsonb);

insert into public.market_quotes (
  id, session_id, instrument_id, quarter, price, previous_price, log_return, return_pct,
  volume, market_cap_usd, fundamental_value, premium_to_fundamental, return_decomposition
) values
  ('41000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
   '40000000-0000-4000-8000-000000000001', 1, 83.20, 79.10, 0.05053, 0.0518,
   41200000, 51584000000, 74.10, 0.1228,
   '{"beta_market":0.021,"beta_sector":0.018,"alpha_fundamental":0.009,"public_information":0.011,"sentiment":0.008,"liquidity":-0.003,"idiosyncratic":-0.013}'::jsonb),
  ('41000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001',
   '40000000-0000-4000-8000-000000000002', 1, 41.72, 43.05, -0.03138, -0.0309,
   18600000, 22528800000, 45.30, -0.0790,
   '{"beta_market":0.016,"beta_sector":0.014,"alpha_fundamental":0.006,"public_information":-0.028,"sentiment":-0.022,"liquidity":-0.001,"idiosyncratic":-0.016}'::jsonb),
  ('41000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001',
   '40000000-0000-4000-8000-000000000003', 1, 57.35, 52.80, 0.08264, 0.0862,
   12400000, 23513500000, 51.00, 0.1245,
   '{"beta_market":0.014,"beta_sector":0.024,"alpha_fundamental":0.018,"public_information":0.021,"sentiment":0.014,"liquidity":0.002,"idiosyncratic":-0.011}'::jsonb),
  ('41000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001',
   '40000000-0000-4000-8000-000000000004', 1, 18.91, 22.40, -0.16938, -0.1558,
   26900000, 5673000000, 24.60, -0.2313,
   '{"beta_market":0.022,"beta_sector":0.017,"alpha_fundamental":-0.061,"public_information":-0.074,"sentiment":-0.048,"liquidity":-0.012,"idiosyncratic":-0.013}'::jsonb),
  ('41000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001',
   '40000000-0000-4000-8000-000000000005', 1, 129.40, 118.20, 0.09053, 0.0948,
   34800000, 100932000000, 108.00, 0.1981,
   '{"beta_market":0.024,"beta_sector":0.031,"alpha_fundamental":0.022,"public_information":0.014,"sentiment":0.011,"liquidity":0.001,"idiosyncratic":-0.013}'::jsonb),
  ('41000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000001',
   '40000000-0000-4000-8000-000000000006', 1, 26.15, 25.60, 0.02126, 0.0215,
   4100000, 6799000000, 29.40, -0.1105,
   '{"beta_market":0.018,"beta_sector":0.009,"alpha_fundamental":0.004,"public_information":0.002,"sentiment":-0.006,"liquidity":-0.004,"idiosyncratic":-0.002}'::jsonb),
  ('41000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000001',
   '40000000-0000-4000-8000-000000000007', 1, 1000.00, 962.40, 0.03832, 0.0391,
   0, null, null, null,
   '{"beta_market":0.018,"beta_sector":0.014,"alpha_fundamental":0.004,"public_information":0.003,"sentiment":0.002,"liquidity":0,"idiosyncratic":-0.003}'::jsonb),
  ('41000000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-000000000001',
   '40000000-0000-4000-8000-000000000008', 1, 1000.00, 934.10, 0.06817, 0.0706,
   0, null, null, null,
   '{"beta_market":0.021,"beta_sector":0.029,"alpha_fundamental":0.012,"public_information":0.006,"sentiment":0.004,"liquidity":0,"idiosyncratic":-0.004}'::jsonb);

insert into public.market_beliefs (
  id, session_id, quarter, instrument_id, company_id, held_by, topic, claim,
  probability, confidence, price_impact, evidence
) values
  ('42000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 1,
   '40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'market', 'frontier_model_schedule',
   'Nexus ships its next frontier model inside two quarters.',
   0.61, 0.44, 0.038,
   '["guidance_2027q1","hiring_velocity","reserved_capacity_180k"]'::jsonb),
  ('42000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 1,
   '40000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000004',
   'sell_side_analyst', 'going_concern',
   'VectorWorks raises a dilutive bridge round within three quarters.',
   0.72, 0.66, -0.091,
   '["cash_640m","burn_104m_per_quarter","nrr_0.88"]'::jsonb),
  ('42000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', 1,
   '40000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000005',
   'institutional', 'export_controls',
   'Export restrictions tighten on advanced accelerators within four quarters.',
   0.47, 0.51, -0.024,
   '["faiob_concentration_review","geopolitical_tension_index"]'::jsonb);

-- ---------------------------------------------------------------------------
-- Open procurements
-- ---------------------------------------------------------------------------

insert into public.procurement_opportunities (
  id, session_id, agency_id, code, title, programme, description, max_value_usd,
  contract_type, duration_quarters, evaluation_weights, requirements,
  allows_consortium, allows_subcontracting, min_past_performance,
  opened_quarter, closes_quarter, status, visibility
) values
  ('61000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
   '60000000-0000-4000-8000-000000000001', 'UFDOD-SIP-01',
   'Sovereign Intelligence Platform', 'Sovereign Intelligence Platform',
   'A sovereign-controlled reasoning and analysis platform operated entirely on domestic infrastructure, with full model audit and assured availability.',
   2400000000, 'cost_plus_incentive_fee', 20,
   '{"technical_capability":0.30,"security_reliability":0.20,"past_performance":0.15,"price_cost_realism":0.15,"delivery_schedule":0.10,"domestic_supply_chain":0.05,"responsible_ai":0.05}'::jsonb,
   '{"security_clearance":"level_iv","domestic_inference":true,"model_audit":true,"uptime":0.9999,"data_sovereignty":true,"incident_reporting_hours":24}'::jsonb,
   true, true, 55, 1, 3, 'open', 'public'),

  ('61000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001',
   '60000000-0000-4000-8000-000000000002', 'UFBDM-CSM-04',
   'National Civic Services Modernisation', 'Citizen Services Modernisation',
   'Replace the legacy citizen benefits and licensing stack with an assisted-service platform. Heavily scrutinised on cost and accessibility, lightly scrutinised on capability.',
   780000000, 'firm_fixed_price', 12,
   '{"technical_capability":0.25,"price_cost_realism":0.30,"past_performance":0.20,"delivery_schedule":0.15,"accessibility":0.10}'::jsonb,
   '{"security_clearance":"level_ii","accessibility_standard":"aa","domestic_inference":false,"uptime":0.999,"human_review":true}'::jsonb,
   true, true, 40, 1, 4, 'open', 'public');

insert into public.contractor_reputation (
  id, session_id, company_id, agency_id, quarter, past_performance, rating,
  on_time_rate, cost_variance, quality_index, incidents, clearance_level, notes
) values
  ('12000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000001', null, 1, 58, 'BBB',
   0.72, 0.19, 0.81, 2, 'level_iii',
   'Strong technical scores, repeated schedule slippage on classified deliveries.'),
  ('12000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000002', null, 1, 81, 'A',
   0.94, 0.04, 0.88, 0, 'level_iv',
   'Reliable civil delivery record. Preferred incumbent on modernisation work.'),
  ('12000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000003', null, 1, 74, 'A-',
   0.89, 0.07, 0.85, 1, 'level_iv',
   'Infrastructure delivery consistently on schedule; one grid-related outage.');

-- ---------------------------------------------------------------------------
-- The Frontier Map: sixteen nodes across the epistemic states
-- ---------------------------------------------------------------------------

insert into public.tech_graph_versions (
  id, session_id, version, quarter, graph, graph_hash, reason, created_by
) values (
  '70000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
  1, 1,
  '{"version":1,"generated_by":"seed","note":"Opening consensus view of the technological frontier. Node and edge rows are the queryable projection of this document."}'::jsonb,
  'seed-graph-v1',
  'Session opening state.',
  'seed'
);

insert into public.tech_nodes (
  id, session_id, graph_version_id, node_key, title, summary, epistemic_state,
  public_confidence, estimated_window_start, estimated_window_end,
  research_cost_min_usd, research_cost_max_usd, compute_intensity,
  talent_requirements, visibility, owner_company_id, origin, novelty, plausibility,
  achieved_quarter, achieved_by_company_id, layout
)
select
  ('71000000-0000-4000-8000-' || lpad(n.n::text, 12, '0'))::uuid,
  '00000000-0000-4000-8000-000000000001'::uuid,
  '70000000-0000-4000-8000-000000000001'::uuid,
  n.node_key, n.title, n.summary,
  n.epistemic_state::public.epistemic_state,
  n.public_confidence,
  n.window_start, n.window_end,
  n.cost_min, n.cost_max, n.compute_intensity,
  n.talent,
  n.visibility::public.visibility_scope,
  n.owner_company_id::uuid,
  'seed'::public.tech_node_origin,
  n.novelty, n.plausibility,
  n.achieved_quarter, n.achieved_by::uuid,
  jsonb_build_object('x', n.x, 'y', n.y)
from (values
  (1, 'transformer_scaling', 'Transformer Scaling',
   'Predictable capability gains from scaling parameters, data and training compute. The industry''s load-bearing assumption.',
   'established', 0.95, 2021, 2027, 200000000.0, 4000000000.0, 0.92,
   array['pretraining','systems','data'], 'public', null, null, null, 1,
   '10000000-0000-4000-8000-000000000001', 0, 0),
  (2, 'retrieval_grounding', 'Retrieval Grounding',
   'Anchoring generation in retrieved, attributable evidence. Now table stakes for regulated deployment.',
   'established', 0.90, 2022, 2026, 20000000.0, 180000000.0, 0.24,
   array['retrieval','evaluation'], 'public', null, null, null, 1,
   '10000000-0000-4000-8000-000000000004', -2, 1),
  (3, 'tool_learning', 'Tool Learning',
   'Models that reliably call external tools and act on the results.',
   'established', 0.86, 2023, 2027, 40000000.0, 320000000.0, 0.38,
   array['agents','evaluation'], 'public', null, null, null, 1,
   '10000000-0000-4000-8000-000000000002', -1, 2),
  (4, 'synthetic_data_curricula', 'Synthetic Data Curricula',
   'Deliberately constructed training curricula that outperform scraped corpora at equal token budgets.',
   'emerging', 0.72, 2027, 2029, 90000000.0, 600000000.0, 0.61,
   array['data','evaluation','pretraining'], 'public', null, 0.44, 0.78, null, null, -3, 3),
  (5, 'sparse_expert_reasoning', 'Sparse Expert Reasoning',
   'Conditional computation that routes reasoning through specialised experts, cutting inference cost at constant capability.',
   'emerging', 0.68, 2027, 2030, 150000000.0, 900000000.0, 0.71,
   array['architecture','systems','reasoning'], 'public', null, 0.51, 0.74, null, null, 1, 1),
  (6, 'recursive_tool_learning', 'Recursive Tool Learning',
   'Systems that build, evaluate and reuse their own tools across tasks.',
   'emerging', 0.61, 2028, 2031, 180000000.0, 850000000.0, 0.66,
   array['agents','reasoning','evaluation'], 'public', null, 0.58, 0.69, null, null, 0, 3),
  (7, 'long_horizon_planning', 'Long-Horizon Planning',
   'Reliable multi-week task decomposition and recovery without human checkpoints.',
   'forecast', 0.54, 2029, 2032, 240000000.0, 1100000000.0, 0.69,
   array['reasoning','agents','memory'], 'public', null, 0.62, 0.61, null, null, -1, 4),
  (8, 'efficient_sparse_inference', 'Efficient Sparse Inference',
   'Order-of-magnitude reductions in serving cost through sparsity, quantisation and speculative decoding.',
   'emerging', 0.47, 2028, 2030, 60000000.0, 420000000.0, 0.44,
   array['systems','architecture'], 'public', null, 0.39, 0.81, null, null, 3, 1),
  (9, 'specialised_accelerator_design', 'Specialised Accelerator Design',
   'Silicon designed around one inference regime rather than general matrix throughput.',
   'forecast', 0.58, 2029, 2032, 900000000.0, 4200000000.0, 0.35,
   array['hardware','systems'], 'public', null, 0.47, 0.72, null, null, 4, 2),
  (10, 'mechanistic_interpretability_at_scale', 'Mechanistic Interpretability at Scale',
   'Reading the computation of frontier-scale models well enough to certify behaviour.',
   'emerging', 0.49, 2029, 2033, 120000000.0, 700000000.0, 0.52,
   array['interpretability','evaluation','safety'], 'public', null, 0.55, 0.63, null, null, -2, 5),
  (11, 'autonomous_research', 'Autonomous Research Systems',
   'Systems that formulate hypotheses, run experiments and revise their own research agenda.',
   'forecast', 0.58, 2030, 2033, 400000000.0, 1100000000.0, 0.74,
   array['reasoning','agents','evaluation'], 'public', null, 0.71, 0.58, null, null, 0, 6),
  (12, 'automated_engineering', 'Automated Engineering',
   'End-to-end delivery of production software and hardware designs without human implementation.',
   'forecast', 0.44, 2031, 2035, 500000000.0, 1800000000.0, 0.68,
   array['agents','systems','evaluation'], 'public', null, 0.66, 0.52, null, null, -2, 8),
  (13, 'self_directed_science', 'Self-Directed Science',
   'Sustained, open-ended scientific programmes chosen and pursued by the system itself.',
   'speculative', 0.27, 2033, 2040, 1200000000.0, 6000000000.0, 0.88,
   array['reasoning','agents','evaluation','safety'], 'public', null, 0.84, 0.34, null, null, 2, 8),
  (14, 'continual_online_learning', 'Continual Online Learning',
   'Models that update from deployment experience without catastrophic forgetting or drift.',
   'speculative', 0.31, 2030, 2036, 200000000.0, 1400000000.0, 0.57,
   array['pretraining','memory','safety'], 'public', null, 0.69, 0.41, null, null, 3, 5),
  (15, 'neuromorphic_substrates', 'Neuromorphic Substrates',
   'Event-driven analogue hardware as a replacement for dense digital accelerators. Two failed commercialisations have drained conviction.',
   'discredited', 0.12, 2035, 2045, 2000000000.0, 9000000000.0, 0.29,
   array['hardware','architecture'], 'public', null, 0.77, 0.14, null, null, 6, 3),
  (16, 'persistent_agent_economies', 'Persistent Agent Economies',
   'Millions of agents learning economic behaviour together in persistent simulated environments. Meridian Data''s house thesis; almost nobody else believes it.',
   'company_thesis', 0.22, 2031, 2037, 280000000.0, 1600000000.0, 0.79,
   array['agent_simulation','reinforcement_learning','large_scale_compute'], 'public',
   '10000000-0000-4000-8000-000000000006', 0.82, 0.63, null, null, -4, 7)
) as n(n, node_key, title, summary, epistemic_state, public_confidence, window_start,
       window_end, cost_min, cost_max, compute_intensity, talent, visibility,
       owner_company_id, novelty, plausibility, achieved_quarter, achieved_by, x, y);

-- One secret node: Nexus believes a scaling wall exists and has not said so.
insert into public.tech_nodes (
  id, session_id, graph_version_id, node_key, title, summary, epistemic_state,
  public_confidence, estimated_window_start, estimated_window_end,
  research_cost_min_usd, research_cost_max_usd, compute_intensity,
  talent_requirements, visibility, owner_company_id, origin, novelty, plausibility, layout
) values (
  '71000000-0000-4000-8000-000000000017', '00000000-0000-4000-8000-000000000001',
  '70000000-0000-4000-8000-000000000001',
  'dense_scaling_saturation', 'Dense Scaling Saturation',
  'Internal Nexus evidence that dense pretraining returns fall off a cliff two generations ahead of the public consensus curve.',
  'secret', 0.04, 2028, 2029, 0, 0, 0.0,
  array['pretraining','evaluation'], 'company',
  '10000000-0000-4000-8000-000000000001', 'seed', 0.58, 0.81,
  '{"x":2,"y":0}'::jsonb
);

insert into public.tech_edges (
  id, session_id, graph_version_id, from_node_id, to_node_id, kind, weight, confidence,
  visibility, owner_company_id
)
select
  ('72000000-0000-4000-8000-' || lpad(e.n::text, 12, '0'))::uuid,
  '00000000-0000-4000-8000-000000000001'::uuid,
  '70000000-0000-4000-8000-000000000001'::uuid,
  ('71000000-0000-4000-8000-' || lpad(e.from_n::text, 12, '0'))::uuid,
  ('71000000-0000-4000-8000-' || lpad(e.to_n::text, 12, '0'))::uuid,
  e.kind::public.tech_edge_kind,
  e.weight, e.confidence,
  e.visibility::public.visibility_scope,
  e.owner_company_id::uuid
from (values
  (1,  1,  5,  'dependency', 1.0, 0.88, 'public', null),
  (2,  1,  6,  'dependency', 0.8, 0.74, 'public', null),
  (3,  3,  6,  'dependency', 1.0, 0.86, 'public', null),
  (4,  2,  3,  'enables',    0.7, 0.81, 'public', null),
  (5,  5,  8,  'unlock',     1.0, 0.72, 'public', null),
  (6,  8,  9,  'enables',    0.9, 0.64, 'public', null),
  (7,  4,  11, 'dependency', 0.9, 0.66, 'public', null),
  (8,  6,  11, 'dependency', 1.0, 0.71, 'public', null),
  (9,  7,  11, 'dependency', 1.0, 0.68, 'public', null),
  (10, 10, 11, 'dependency', 0.5, 0.41, 'public', null),
  (11, 11, 12, 'unlock',     1.0, 0.62, 'public', null),
  (12, 11, 13, 'unlock',     1.0, 0.44, 'public', null),
  (13, 1,  14, 'dependency', 0.6, 0.38, 'public', null),
  (14, 4,  16, 'dependency', 0.8, 0.52, 'public', null),
  (15, 16, 11, 'competes_with', 0.6, 0.31, 'public', null),
  (16, 9,  15, 'supersedes', 0.7, 0.58, 'public', null),
  -- The secret node's edge is company-visible only: a public edge would leak
  -- the existence of the node it points at.
  (17, 17, 1,  'competes_with', 1.0, 0.79, 'company',
   '10000000-0000-4000-8000-000000000001')
) as e(n, from_n, to_n, kind, weight, confidence, visibility, owner_company_id);

-- ---------------------------------------------------------------------------
-- Research programmes, including one secret
-- ---------------------------------------------------------------------------

insert into public.research_projects (
  id, session_id, company_id, node_id, name, hypothesis, is_secret, status,
  started_quarter, target_quarter, budget_usd, spent_usd, compute_allocated,
  headcount_allocated, progress, internal_confidence, risk, schedule_variance_quarters,
  cost_variance
) values
  ('14000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000005',
   'Programme Meridian-7', 'Sparse expert routing holds capability while halving serving cost.',
   false, 'active', 1, 5, 840000000, 61000000, 96000, 210, 0.08, 0.62, 0.44, 0, 0.0),
  ('14000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000017',
   'Project Lattice', 'Dense pretraining returns saturate two generations earlier than the published curves imply.',
   true, 'active', 1, 4, 190000000, 74000000, 21000, 46, 0.41, 0.79, 0.62, 2, 0.31),
  ('14000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000006', '71000000-0000-4000-8000-000000000016',
   'Agora', 'Persistent multi-agent economies produce transferable planning behaviour.',
   false, 'active', 1, 9, 280000000, 34000000, 12000, 88, 0.12, 0.71, 0.68, 0, 0.0);

insert into public.inventions (
  id, session_id, company_id, project_id, node_id, quarter, title, description, kind,
  significance, capability_delta, is_published, published_quarter, is_open_weight,
  patent_status, visibility
) values
  ('18000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000006', '14000000-0000-4000-8000-000000000003',
   '71000000-0000-4000-8000-000000000004', 1,
   'Curriculum Synthesis v2',
   'Open evaluation showing a 14% sample-efficiency gain from synthesised curricula at fixed token budgets.',
   'process', 0.44, 0.06, true, 1, true, 'none', 'public'),
  ('18000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000005', null,
   '71000000-0000-4000-8000-000000000009', 1,
   'AX-7 Sparse Datapath',
   'Silicon datapath tuned for conditional computation. Sampling only; not yet acknowledged publicly.',
   'infrastructure', 0.67, 0.11, false, null, false, 'filed', 'company');

-- ---------------------------------------------------------------------------
-- Social presence and the opening news cycle
-- ---------------------------------------------------------------------------

insert into public.social_accounts (
  id, session_id, network, handle, display_name, owner_character_id, owner_company_id,
  followers, credibility, audience_mix, is_verified, is_official
) values
  ('80000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
   'fast_feed', 'mayachen', 'Maya Chen', '20000000-0000-4000-8000-000000000001', null,
   2840000, 0.71, '{"developers":0.31,"investors":0.24,"media":0.18,"consumers":0.27}'::jsonb, true, false),
  ('80000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001',
   'professional', 'dokonkwo', 'Daniel Okonkwo', '20000000-0000-4000-8000-000000000002', null,
   410000, 0.78, '{"enterprise_buyers":0.52,"employees":0.21,"investors":0.27}'::jsonb, true, false),
  ('80000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001',
   'professional', 'praghavan', 'Priya Raghavan', '20000000-0000-4000-8000-000000000003', null,
   188000, 0.82, '{"enterprise_buyers":0.44,"investors":0.36,"media":0.20}'::jsonb, true, false),
  ('80000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001',
   'technical_forum', 'tlindqvist', 'Tomas Lindqvist', '20000000-0000-4000-8000-000000000004', null,
   96000, 0.69, '{"developers":0.58,"researchers":0.31,"media":0.11}'::jsonb, true, false),
  ('80000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001',
   'fast_feed', 'raldana', 'Rebecca Aldana', '20000000-0000-4000-8000-000000000005', null,
   740000, 0.66, '{"investors":0.46,"analysts":0.22,"media":0.32}'::jsonb, true, false),
  ('80000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000001',
   'technical_forum', 'kwatanabe', 'Kenji Watanabe', '20000000-0000-4000-8000-000000000006', null,
   312000, 0.88, '{"researchers":0.54,"developers":0.34,"open_source_community":0.12}'::jsonb, true, false),
  ('80000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000001',
   'fast_feed', 'inesduarte', 'Ines Duarte', '20000000-0000-4000-8000-000000000014', null,
   1120000, 0.91, '{"media":0.34,"investors":0.29,"developers":0.20,"regulators":0.17}'::jsonb, true, false),
  ('80000000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-000000000001',
   'finance_community', 'rowanellis', 'Rowan Ellis', '20000000-0000-4000-8000-000000000015', null,
   860000, 0.63, '{"investors":0.51,"analysts":0.28,"consumers":0.21}'::jsonb, true, false),
  ('80000000-0000-4000-8000-000000000009', '00000000-0000-4000-8000-000000000001',
   'fast_feed', 'nexusintelligence', 'Nexus Intelligence', null, '10000000-0000-4000-8000-000000000001',
   4210000, 0.64, '{"developers":0.38,"consumers":0.34,"investors":0.28}'::jsonb, true, true),
  ('80000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000001',
   'professional', 'orbitdynamics', 'Orbit Dynamics', null, '10000000-0000-4000-8000-000000000002',
   980000, 0.74, '{"enterprise_buyers":0.61,"employees":0.22,"investors":0.17}'::jsonb, true, true);

insert into public.social_posts (
  id, session_id, account_id, quarter, author_kind, body, topic, stance,
  subject_company_id, is_rumour, rumour_credibility, reach, novelty,
  sentiment_effects, visibility, moderation_status
) values
  ('81000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
   '80000000-0000-4000-8000-000000000006', 1, 'npc_character',
   'Releasing Curriculum Synthesis v2 openly, weights and evaluations together. 14% sample efficiency at fixed budget. The corpus was never the bottleneck — the curriculum was.',
   'open_weights', 0.6, '10000000-0000-4000-8000-000000000006', false, null,
   1840000, 0.72,
   '{"developers":12,"researchers":9,"open_source_community":16,"investors":-3}'::jsonb,
   'public', 'visible'),
  ('81000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001',
   '80000000-0000-4000-8000-000000000008', 1, 'npc_character',
   'VWA down 15% on the quarter. Six quarters of cash at current burn and a retention curve nobody wants to put on a slide. Bridge or buyer by year end.',
   'distress', -0.7, '10000000-0000-4000-8000-000000000004', true, 0.58,
   940000, 0.41,
   '{"investors":-14,"enterprise_buyers":-6,"employees":-11}'::jsonb,
   'public', 'visible'),
  ('81000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001',
   '80000000-0000-4000-8000-000000000001', 1, 'npc_character',
   'We reserved 180,000 accelerators through 2028. People calling that reckless in 2027 will be renting capacity from us in 2029.',
   'compute_strategy', 0.8, '10000000-0000-4000-8000-000000000001', false, null,
   2210000, 0.55,
   '{"developers":6,"investors":-4,"analysts":-7,"media":9}'::jsonb,
   'public', 'visible');

insert into public.engagement_events (
  id, session_id, post_id, quarter, audience, impressions, engagements, amplification,
  sentiment_delta, belief_delta
) values
  ('82000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
   '81000000-0000-4000-8000-000000000001', 1, 'developers', 1240000, 96000, 2.4, 0.12,
   '{"synthetic_data_curricula":0.06}'::jsonb),
  ('82000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001',
   '81000000-0000-4000-8000-000000000001', 1, 'researchers', 410000, 61000, 3.1, 0.09,
   '{"synthetic_data_curricula":0.08}'::jsonb),
  ('82000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001',
   '81000000-0000-4000-8000-000000000002', 1, 'investors', 690000, 88000, 4.2, -0.14,
   '{"vectorworks_going_concern":0.11}'::jsonb),
  ('82000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001',
   '81000000-0000-4000-8000-000000000003', 1, 'analysts', 520000, 34000, 1.6, -0.07,
   '{"nexus_capital_discipline":-0.05}'::jsonb);

insert into public.media_stories (
  id, session_id, quarter, outlet, journalist_character_id, headline, body, angle,
  subject_company_id, subject_character_id, source_post_id, credibility, prominence,
  sentiment, visibility
) values
  ('83000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 1,
   'The Frontier Ledger', '20000000-0000-4000-8000-000000000014',
   'Nexus locks up a fifth of independent capacity through 2028',
   'Reserved-capacity filings show Nexus Intelligence has committed to 180,000 accelerator-equivalents through the end of 2028, most of it from Helix Systems. Three smaller laboratories told the Ledger they were quoted spot pricing for the first time in two years.',
   'concentration', '10000000-0000-4000-8000-000000000001',
   '20000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000003',
   0.88, 0.74, -0.24, 'public');

insert into public.public_disclosures (
  id, session_id, company_id, quarter, kind, headline, body, figures, is_material,
  is_mandatory, credibility_weight, issued_by_character_id
) values
  ('84000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000001', 1, 'guidance',
   'Nexus Intelligence reaffirms frontier model timing for the first half of 2028',
   'The company confirmed that its next frontier system remains on schedule and that reserved capacity is fully committed to the training programme.',
   '{"revenue_usd":1850000000,"guidance":"on_schedule","reserved_accelerators":180000}'::jsonb,
   true, false, 1.00, '20000000-0000-4000-8000-000000000001'),
  ('84000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000004', 1, 'earnings',
   'VectorWorks AI reports Q1 2027 results: revenue $172.5m, net revenue retention 88%',
   'Management described the retention decline as concentrated in two regulated verticals and said a strategic review of financing options is under way.',
   '{"revenue_usd":172500000,"nrr":0.88,"cash_usd":640000000,"burn_usd":104000000}'::jsonb,
   true, true, 0.82, '20000000-0000-4000-8000-000000000004');

-- ---------------------------------------------------------------------------
-- Opening world events
-- ---------------------------------------------------------------------------

insert into public.world_events (
  id, session_id, quarter, event_family, event_type, title_key, headline, body,
  severity, visibility, duration_quarters, source, payload
) values
  ('e0000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 1,
   'compute_supply', 'advanced_packaging_constraint', 'advanced_packaging_constraint',
   'Advanced packaging capacity remains the binding constraint on accelerator supply',
   'Two packaging lines slipped qualification. Aurora Compute''s backlog extends to six quarters and spot pricing has moved above contract pricing for the first time since 2025.',
   0.41, 'public', 3, 'seed',
   '{"spot_premium":0.34,"backlog_quarters":6}'::jsonb),
  ('e0000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 1,
   'regulation', 'concentration_review_opened', 'concentration_review_opened',
   'Federal AI Oversight Bureau opens a market concentration review',
   'Commissioner Prieto confirmed the Bureau is examining reserved-capacity agreements between frontier laboratories and infrastructure operators. No enforcement action has been proposed.',
   0.28, 'public', 4, 'seed',
   '{"scope":["reserved_capacity","vertical_integration"],"enforcement_probability":0.22}'::jsonb);

-- ---------------------------------------------------------------------------
-- Agent roster
-- ---------------------------------------------------------------------------

insert into public.agent_profiles (
  id, session_id, agent_role, name, version, model_id, tier, system_prompt_key,
  character_id, company_id, config, fallback_strategy, is_active
) values
  ('f0000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
   'world_director', 'World Director', '1', 'claude-opus-5', 'major', 'world_director.v1',
   null, null, '{"impact_budget_per_quarter":1.0,"max_modifiers_per_event":4}'::jsonb,
   'scripted_template', true),
  ('f0000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001',
   'chief_of_staff', 'Chief of Staff', '1', 'claude-opus-5', 'major', 'chief_of_staff.v1',
   null, null, '{"confirm_high_risk":true}'::jsonb, 'no_action', true),
  ('f0000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001',
   'innovation_interpreter', 'Innovation Interpreter', '1', 'claude-opus-5', 'major',
   'innovation_interpreter.v1', null, null,
   '{"max_new_nodes_per_quarter":2,"plausibility_floor":0.25}'::jsonb, 'no_action', true),
  ('f0000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001',
   'npc_strategist', 'Nexus Strategist', '1', 'claude-opus-5', 'major', 'npc_strategist.v1',
   '20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   '{"strategy_bias":"secure_compute","aggression":0.83}'::jsonb, 'deterministic_archetype', true),
  ('f0000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001',
   'npc_strategist', 'Orbit Strategist', '1', 'claude-opus-5', 'major', 'npc_strategist.v1',
   '20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002',
   '{"strategy_bias":"land_and_expand","aggression":0.41}'::jsonb, 'deterministic_archetype', true),
  ('f0000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000001',
   'npc_strategist', 'Helix Strategist', '1', 'claude-opus-5', 'major', 'npc_strategist.v1',
   '20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003',
   '{"strategy_bias":"capacity_arbitrage","aggression":0.52}'::jsonb, 'deterministic_archetype', true),
  ('f0000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000001',
   'npc_strategist', 'VectorWorks Strategist', '1', 'claude-opus-5', 'significant',
   'npc_strategist.v1',
   '20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000004',
   '{"strategy_bias":"survive_and_partner","aggression":0.29}'::jsonb, 'rule_strategy', true),
  ('f0000000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-000000000001',
   'npc_strategist', 'Aurora Strategist', '1', 'claude-opus-5', 'major', 'npc_strategist.v1',
   '20000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000005',
   '{"strategy_bias":"allocate_scarcity","aggression":0.77}'::jsonb, 'deterministic_archetype', true),
  ('f0000000-0000-4000-8000-000000000009', '00000000-0000-4000-8000-000000000001',
   'npc_strategist', 'Meridian Strategist', '1', 'claude-opus-5', 'significant',
   'npc_strategist.v1',
   '20000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000006',
   '{"strategy_bias":"publish_and_license","aggression":0.44}'::jsonb, 'rule_strategy', true),
  ('f0000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000001',
   'character_dialogue', 'Character Dialogue', '1', 'claude-opus-5', 'significant',
   'character_dialogue.v1', null, null,
   '{"memory_window_quarters":8,"max_memories":24}'::jsonb, 'scripted_template', true),
  ('f0000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001',
   'media', 'Newsroom', '1', 'claude-opus-5', 'background', 'media.v1', null, null,
   '{"stories_per_quarter":3}'::jsonb, 'scripted_template', true);

-- ---------------------------------------------------------------------------
-- Opening leaderboard
-- ---------------------------------------------------------------------------

insert into public.leaderboard_snapshots (
  id, session_id, quarter, board, entries, methodology_version, weights
) values (
  '90000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 1,
  'company_value',
  '[
     {"rank":1,"previous_rank":1,"company_id":"10000000-0000-4000-8000-000000000005",
      "label":"Aurora Compute","value":100932000000,"percentile":1.00,"delta":0.0948},
     {"rank":2,"previous_rank":2,"company_id":"10000000-0000-4000-8000-000000000001",
      "label":"Nexus Intelligence","value":51584000000,"percentile":0.83,"delta":0.0518},
     {"rank":3,"previous_rank":4,"company_id":"10000000-0000-4000-8000-000000000003",
      "label":"Helix Systems","value":23513500000,"percentile":0.67,"delta":0.0862},
     {"rank":4,"previous_rank":3,"company_id":"10000000-0000-4000-8000-000000000002",
      "label":"Orbit Dynamics","value":22528800000,"percentile":0.50,"delta":-0.0309},
     {"rank":5,"previous_rank":5,"company_id":"10000000-0000-4000-8000-000000000006",
      "label":"Meridian Data","value":6799000000,"percentile":0.33,"delta":0.0215},
     {"rank":6,"previous_rank":6,"company_id":"10000000-0000-4000-8000-000000000004",
      "label":"VectorWorks AI","value":5673000000,"percentile":0.17,"delta":-0.1558}
   ]'::jsonb,
  '1',
  '{"basis":"controlled_enterprise_value"}'::jsonb
);
