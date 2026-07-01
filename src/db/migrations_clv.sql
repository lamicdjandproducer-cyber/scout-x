-- CLV (Closing Line Value) Tracking Table
-- Logs every Scout X recommendation for model validation.
-- closing_odds filled retroactively after match kickoff.

CREATE TABLE IF NOT EXISTS bet_recommendations (
  id                BIGSERIAL PRIMARY KEY,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Match identification
  home_team         TEXT NOT NULL,
  away_team         TEXT NOT NULL,
  match_datetime    TIMESTAMPTZ,
  sport_key         TEXT,                        -- The Odds API sport key

  -- Our recommendation
  outcome           TEXT NOT NULL,               -- 'home' | 'draw' | 'away'
  recommended_odds  NUMERIC(6,3) NOT NULL,       -- odds at time of recommendation
  fair_prob         NUMERIC(5,4) NOT NULL,       -- market no-vig probability (0-1)
  adj_prob          NUMERIC(5,4) NOT NULL,       -- our adjusted probability (0-1)
  edge              NUMERIC(5,4) NOT NULL,       -- (odds * adj_prob) - 1

  -- Closing line (filled after kickoff)
  closing_odds      NUMERIC(6,3),               -- Pinnacle closing line
  clv               NUMERIC(5,4),               -- (rec_odds / closing_odds) - 1
  
  -- Result tracking (filled after match)
  result            TEXT CHECK (result IN ('WIN','LOSS','VOID')),
  
  -- Meta
  confidence_score  SMALLINT,                   -- 0-100
  model_version     TEXT DEFAULT 'v1'
);

-- Indexes for analysis queries
CREATE INDEX IF NOT EXISTS idx_bet_rec_created   ON bet_recommendations (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bet_rec_sport      ON bet_recommendations (sport_key);
CREATE INDEX IF NOT EXISTS idx_bet_rec_outcome    ON bet_recommendations (outcome);
CREATE INDEX IF NOT EXISTS idx_bet_rec_edge       ON bet_recommendations (edge DESC);

-- View: CLV performance summary
CREATE OR REPLACE VIEW clv_performance AS
SELECT
  DATE_TRUNC('week', created_at)          AS week,
  COUNT(*)                                AS total_bets,
  ROUND(AVG(edge) * 100, 2)              AS avg_edge_pct,
  COUNT(closing_odds)                     AS with_closing_line,
  ROUND(AVG(clv) * 100, 2)              AS avg_clv_pct,
  COUNT(CASE WHEN clv > 0 THEN 1 END)    AS positive_clv_count,
  COUNT(CASE WHEN result = 'WIN' THEN 1 END) AS wins,
  COUNT(CASE WHEN result = 'LOSS' THEN 1 END) AS losses
FROM bet_recommendations
GROUP BY 1
ORDER BY 1 DESC;

-- View: ROI by sport
CREATE OR REPLACE VIEW roi_by_sport AS
SELECT
  sport_key,
  COUNT(*) AS bets,
  ROUND(AVG(edge) * 100, 2) AS avg_edge_pct,
  ROUND(AVG(clv) * 100, 2) AS avg_clv_pct,
  COUNT(CASE WHEN result = 'WIN' THEN 1 END) * 100.0 / 
    NULLIF(COUNT(CASE WHEN result IN ('WIN','LOSS') THEN 1 END), 0) AS win_rate_pct
FROM bet_recommendations
GROUP BY sport_key
ORDER BY avg_clv_pct DESC NULLS LAST;
