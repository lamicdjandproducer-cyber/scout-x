import axios from 'axios';

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';

interface OddsEvent {
  id: string; sport_key: string; sport_title: string; commence_time: string;
  home_team: string; away_team: string;
  bookmakers: Array<{ key: string; title: string; markets: Array<{ key: string; outcomes: Array<{ name: string; price: number }> }> }>;
}

export async function getOdds(sportKey: string, regions = 'eu', markets = 'h2h'): Promise<OddsEvent[]> {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) { console.warn('ODDS_API_KEY not set'); return []; }
  try {
    const response = await axios.get(`${ODDS_API_BASE}/sports/${sportKey}/odds`, {
      params: { apiKey, regions, markets, oddsFormat: 'decimal' },
      timeout: 10000,
    });
    return response.data || [];
  } catch (err: any) {
    console.error('Odds API error:', err?.response?.data || err.message);
    return [];
  }
}

export function findValueBets(events: OddsEvent[], minEdge = 0.05): Array<{
  event: string; market: string; outcome: string; avgOdds: number; bestOdds: number; impliedProb: number; edge: number;
}> {
  const valueBets = [];
  for (const event of events) {
    for (const bookmaker of event.bookmakers) {
      for (const market of bookmaker.markets) {
        for (const outcome of market.outcomes) {
          const impliedProb = 1 / outcome.price;
          const edge = 1 - impliedProb;
          if (edge >= minEdge) {
            valueBets.push({
              event: `${event.home_team} vs ${event.away_team}`,
              market: market.key, outcome: outcome.name,
              avgOdds: outcome.price, bestOdds: outcome.price,
              impliedProb: Math.round(impliedProb * 100) / 100,
              edge: Math.round(edge * 100) / 100,
            });
          }
        }
      }
    }
  }
  return valueBets.sort((a, b) => b.edge - a.edge);
}

export const SPORT_KEYS = {
  SOCCER_BRAZIL_CAMPEONATO: 'soccer_brazil_campeonato',
  SOCCER_UEFA_CHAMPS_LEAGUE: 'soccer_uefa_champs_league',
  SOCCER_EPL: 'soccer_epl',
  SOCCER_SPAIN_LA_LIGA: 'soccer_spain_la_liga',
  BASKETBALL_NBA: 'basketball_nba',
  TENNIS_ATP: 'tennis_atp',
  MMA_MIXED_MARTIAL_ARTS: 'mma_mixed_martial_arts',
  AMERICANFOOTBALL_NFL: 'americanfootball_nfl',
};
