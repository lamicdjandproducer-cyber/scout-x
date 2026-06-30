import axios from 'axios';

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';

interface OddsEvent {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: Array<{
    key: string;
    title: string;
    markets: Array<{
      key: string;
      outcomes: Array<{ name: string; price: number }>;
    }>;
  }>;
}

export async function getOdds(sportKey: string, regions = 'eu', markets = 'h2h'): Promise<OddsEvent[]> {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    console.warn('ODDS_API_KEY not set, skipping odds fetch');
    return [];
  }

  try {
    const response = await axios.get(`${ODDS_API_BASE}/sports/${sportKey}/odds`, {
      params: {
        apiKey,
        regions,
        markets,
        oddsFormat: 'decimal',
      },
      timeout: 10000,
    });

    return response.data || [];
  } catch (err: any) {
    console.error('Odds API error:', err?.response?.data || err.message);
    return [];
  }
}

export async function getSports(): Promise<any[]> {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return [];

  try {
    const response = await axios.get(`${ODDS_API_BASE}/sports`, {
      params: { apiKey },
      timeout: 10000,
    });
    return response.data || [];
  } catch (err: any) {
    console.error('Odds API sports error:', err?.response?.data || err.message);
    return [];
  }
}

/**
 * Proper value bet detection using no-vig (fair) probability.
 *
 * Algorithm:
 * 1. For each event + market, collect all bookmakers' odds per outcome
 * 2. Use the BEST available odds across all books as the "sharpest signal"
 * 3. Calculate no-vig fair probability by normalizing the best odds
 *    (removes the overround so probabilities sum to 100%)
 * 4. For each bookmaker, compare their odds to the fair probability:
 *    edge = (their_odds × fair_prob) - 1
 *    If edge > 0 → they're offering more value than the fair price
 * 5. Return bets sorted by edge, filtered by minEdge
 */
export function findValueBets(
  events: OddsEvent[],
  minEdge = 0.05
): Array<{
  event: string;
  commence_time: string;
  market: string;
  outcome: string;
  bookmaker: string;
  odds: number;
  fair_prob: number;
  implied_prob: number;
  edge: number;
  overround: number;
}> {
  const valueBets: ReturnType<typeof findValueBets> = [];

  for (const event of events) {
    // Group by market key
    const marketMap: Record<string, Record<string, number[]>> = {};

    for (const bm of event.bookmakers) {
      for (const market of bm.markets) {
        if (!marketMap[market.key]) marketMap[market.key] = {};
        for (const outcome of market.outcomes) {
          if (!marketMap[market.key][outcome.name]) {
            marketMap[market.key][outcome.name] = [];
          }
          marketMap[market.key][outcome.name].push(outcome.price);
        }
      }
    }

    for (const [marketKey, outcomeOdds] of Object.entries(marketMap)) {
      // Best (highest) odds available for each outcome across all books
      const bestOdds: Record<string, number> = {};
      for (const [outcomeName, oddsList] of Object.entries(outcomeOdds)) {
        bestOdds[outcomeName] = Math.max(...oddsList);
      }

      // Calculate overround of best odds
      const sumImplied = Object.values(bestOdds).reduce((sum, o) => sum + 1 / o, 0);
      const overround = sumImplied; // > 1 means house edge still present

      // No-vig (fair) probability for each outcome
      const fairProb: Record<string, number> = {};
      for (const [outcomeName, odds] of Object.entries(bestOdds)) {
        fairProb[outcomeName] = (1 / odds) / sumImplied;
      }

      // Now check each individual bookmaker's odds vs fair probability
      for (const bm of event.bookmakers) {
        for (const market of bm.markets) {
          if (market.key !== marketKey) continue;
          for (const outcome of market.outcomes) {
            const fp = fairProb[outcome.name];
            if (!fp) continue;

            const edge = outcome.price * fp - 1;

            if (edge >= minEdge) {
              valueBets.push({
                event: `${event.home_team} vs ${event.away_team}`,
                commence_time: event.commence_time,
                market: marketKey,
                outcome: outcome.name,
                bookmaker: bm.title,
                odds: Math.round(outcome.price * 100) / 100,
                fair_prob: Math.round(fp * 1000) / 10, // as percentage
                implied_prob: Math.round((1 / outcome.price) * 1000) / 10,
                edge: Math.round(edge * 1000) / 10, // as percentage
                overround: Math.round((overround - 1) * 1000) / 10,
              });
            }
          }
        }
      }
    }
  }

  // Sort by edge descending, deduplicate (same event+outcome, keep best edge)
  const seen = new Set<string>();
  return valueBets
    .sort((a, b) => b.edge - a.edge)
    .filter(vb => {
      const key = `${vb.event}|${vb.market}|${vb.outcome}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20);
}

// Sport keys for The Odds API
export const SPORT_KEYS = {
  SOCCER_BRAZIL_CAMPEONATO: 'soccer_brazil_campeonato',
  SOCCER_UEFA_CHAMPS_LEAGUE: 'soccer_uefa_champs_league',
  SOCCER_EPL: 'soccer_epl',
  SOCCER_SPAIN_LA_LIGA: 'soccer_spain_la_liga',
  SOCCER_ITALY_SERIE_A: 'soccer_italy_serie_a',
  SOCCER_GERMANY_BUNDESLIGA: 'soccer_germany_bundesliga',
  BASKETBALL_NBA: 'basketball_nba',
  TENNIS_ATP: 'tennis_atp',
  MMA_MIXED_MARTIAL_ARTS: 'mma_mixed_martial_arts',
  AMERICANFOOTBALL_NFL: 'americanfootball_nfl',
};
