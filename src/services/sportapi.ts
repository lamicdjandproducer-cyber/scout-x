import axios from 'axios';

/**
 * SportAPI via RapidAPI — broad multi-sport coverage:
 * live events, scheduled matches, team/player search, odds,
 * transfer news, rankings. Complements API-Sports data.
 *
 * Host: sportapi7.p.rapidapi.com
 * Env:  SPORTAPI_KEY
 */

const SPORT_API_BASE = 'https://sportapi7.p.rapidapi.com/api/v1';

// Category IDs (SportAPI uses Sofascore-style IDs)
export const SPORT_CATEGORY = {
  FOOTBALL: 1,
  TENNIS: 2,
  BASKETBALL: 3,
  ICE_HOCKEY: 4,
  AMERICAN_FOOTBALL: 6,
  BASEBALL: 7,
  HANDBALL: 8,
  VOLLEYBALL: 9,
  MMA: 117,
  ESPORTS: 123,
  TABLE_TENNIS: 13,
  BOXING: 109,
};

function getHeaders() {
  return {
    'x-rapidapi-host': 'sportapi7.p.rapidapi.com',
    'x-rapidapi-key': process.env.SPORTAPI_KEY || '',
    'Content-Type': 'application/json',
  };
}

async function apiGet(path: string, params: Record<string, any> = {}): Promise<any> {
  if (!process.env.SPORTAPI_KEY) {
    console.warn('SPORTAPI_KEY not set');
    return null;
  }
  try {
    const response = await axios.get(`${SPORT_API_BASE}${path}`, {
      params,
      headers: getHeaders(),
      timeout: 10000,
    });
    return response.data;
  } catch (err: any) {
    console.error(`SportAPI ${path} error:`, err?.response?.data || err.message);
    return null;
  }
}

// ─── Live Events ──────────────────────────────────────────────────────────────

/** Get all current live events across all sports */
export async function getLiveEvents(categoryId?: number): Promise<any[]> {
  const path = categoryId
    ? `/sport/${categoryId}/events/live`
    : '/sport/0/events/live'; // 0 = all sports
  const data = await apiGet(path);
  const events = data?.events || data?.data || [];
  return events.slice(0, 20).map((e: any) => ({
    id: e.id,
    sport: e.tournament?.category?.sport?.name,
    tournament: e.tournament?.name,
    home: e.homeTeam?.name,
    away: e.awayTeam?.name,
    score: e.homeScore
      ? `${e.homeScore.current ?? 0}-${e.awayScore?.current ?? 0}`
      : 'Not started',
    status: e.status?.description || e.statusCode,
    start_time: e.startTimestamp
      ? new Date(e.startTimestamp * 1000).toISOString()
      : null,
  }));
}

// ─── Scheduled Events ─────────────────────────────────────────────────────────

/** Get scheduled events for a specific sport category on a given date */
export async function getScheduledEvents(
  categoryId: number,
  date?: string // YYYY-MM-DD
): Promise<any[]> {
  const dateStr = date || new Date().toISOString().split('T')[0];
  const data = await apiGet(`/category/${categoryId}/scheduled-events/${dateStr}`);
  const events = data?.events || data?.data || [];
  return events.slice(0, 30).map((e: any) => ({
    id: e.id,
    tournament: e.tournament?.name,
    country: e.tournament?.category?.name,
    home: e.homeTeam?.name,
    away: e.awayTeam?.name,
    start_time: e.startTimestamp
      ? new Date(e.startTimestamp * 1000).toISOString()
      : null,
    round: e.roundInfo?.round,
  }));
}

// ─── Odds ─────────────────────────────────────────────────────────────────────

/** Get odds for a specific event */
export async function getEventOdds(eventId: number): Promise<any> {
  const data = await apiGet(`/event/${eventId}/odds/all`);
  if (!data) return null;
  const markets = data?.markets || data?.data?.markets || [];
  return markets.slice(0, 5).map((m: any) => ({
    market: m.marketName,
    choices: (m.choices || []).map((c: any) => ({
      name: c.name,
      fractionalValue: c.fractionalValue,
      // Convert fractional to decimal
      decimal: c.fractionalValue
        ? (() => {
            const parts = c.fractionalValue.toString().split('/');
            return parts.length === 2
              ? Math.round((parseInt(parts[0]) / parseInt(parts[1]) + 1) * 100) / 100
              : parseFloat(c.fractionalValue) + 1;
          })()
        : c.decimalValue,
    })),
  }));
}

// ─── Team ─────────────────────────────────────────────────────────────────────

/** Search for a team by name */
export async function searchSportAPITeam(name: string): Promise<any[]> {
  const data = await apiGet('/search', { query: name, type: 'team' });
  const results = data?.results || data?.data || [];
  return results.slice(0, 5).map((r: any) => ({
    id: r.entity?.id,
    name: r.entity?.name,
    sport: r.entity?.sport?.name,
    country: r.entity?.country?.name,
    tournament: r.entity?.tournament?.name,
  }));
}

/** Get team form (recent events) */
export async function getTeamForm(teamId: number): Promise<any[]> {
  const data = await apiGet(`/team/${teamId}/events/last/0`);
  const events = data?.events || data?.data || [];
  return events.slice(0, 5).map((e: any) => {
    const isHome = e.homeTeam?.id === teamId;
    const myScore = isHome ? e.homeScore?.current : e.awayScore?.current;
    const oppScore = isHome ? e.awayScore?.current : e.homeScore?.current;
    const result = myScore === undefined || oppScore === undefined ? '?'
      : myScore > oppScore ? 'W'
      : myScore < oppScore ? 'L' : 'D';
    return {
      opponent: isHome ? e.awayTeam?.name : e.homeTeam?.name,
      result,
      score: `${myScore ?? '?'}-${oppScore ?? '?'}`,
      home_away: isHome ? 'H' : 'A',
      tournament: e.tournament?.name,
      date: e.startTimestamp ? new Date(e.startTimestamp * 1000).toISOString().split('T')[0] : null,
    };
  });
}

/** Get team's upcoming scheduled events */
export async function getTeamNextEvents(teamId: number): Promise<any[]> {
  const data = await apiGet(`/team/${teamId}/events/next/0`);
  const events = data?.events || data?.data || [];
  return events.slice(0, 5).map((e: any) => ({
    home: e.homeTeam?.name,
    away: e.awayTeam?.name,
    tournament: e.tournament?.name,
    date: e.startTimestamp ? new Date(e.startTimestamp * 1000).toISOString().split('T')[0] : null,
    round: e.roundInfo?.round,
  }));
}

// ─── Player ───────────────────────────────────────────────────────────────────

/** Search for a player by name */
export async function searchSportAPIPlayer(name: string): Promise<any[]> {
  const data = await apiGet('/search', { query: name, type: 'player' });
  const results = data?.results || data?.data || [];
  return results.slice(0, 5).map((r: any) => ({
    id: r.entity?.id,
    name: r.entity?.name,
    team: r.entity?.team?.name,
    sport: r.entity?.sport?.name,
    nationality: r.entity?.country?.name,
    position: r.entity?.position,
  }));
}

/** Get player season statistics */
export async function getPlayerSeasonStats(playerId: number): Promise<any> {
  const data = await apiGet(`/player/${playerId}/statistics/seasons`);
  const seasons = data?.seasons || data?.data || [];
  if (!seasons.length) return null;
  // Return latest season stats
  const latest = seasons[0];
  return {
    season: latest.season?.name,
    team: latest.team?.name,
    rating: latest.statistics?.rating,
    goals: latest.statistics?.goals,
    assists: latest.statistics?.assists,
    appearances: latest.statistics?.appearances,
    yellow_cards: latest.statistics?.yellowCards,
    red_cards: latest.statistics?.redCards,
    minutes_played: latest.statistics?.minutesPlayed,
  };
}

// ─── Transfer News ────────────────────────────────────────────────────────────

/** Get recent transfer news — key for detecting undervalued/overvalued teams */
export async function getTransferNews(teamId?: number): Promise<any[]> {
  const path = teamId ? `/team/${teamId}/transfers` : '/transfers';
  const data = await apiGet(path);
  const transfers = data?.transferHistory || data?.data || data?.transfers || [];
  return transfers.slice(0, 10).map((t: any) => ({
    player: t.player?.name,
    from: t.transferFrom?.name,
    to: t.transferTo?.name,
    type: t.type === 1 ? 'Loan' : t.type === 0 ? 'Transfer' : 'Free',
    date: t.transferDateTimestamp
      ? new Date(t.transferDateTimestamp * 1000).toISOString().split('T')[0]
      : null,
    fee: t.transferFee || 'N/A',
  }));
}

// ─── Rankings ─────────────────────────────────────────────────────────────────

/** Get tennis or sport-specific player rankings */
export async function getPlayerRankings(type: 'atp' | 'wta' | 'nba' = 'atp'): Promise<any[]> {
  const rankingType = type === 'atp' ? 1 : type === 'wta' ? 2 : 3;
  const data = await apiGet(`/rankings/type/${rankingType}`);
  const rows = data?.rows || data?.data || [];
  return rows.slice(0, 20).map((r: any) => ({
    rank: r.rowIndex,
    name: r.team?.name || r.player?.name,
    points: r.points,
    country: r.team?.country?.name || r.player?.country?.name,
  }));
}
