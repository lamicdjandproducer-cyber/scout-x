import axios from 'axios';

const NBA_BASE = 'https://v2.nba.api-sports.io';
const BASKETBALL_BASE = 'https://v1.basketball.api-sports.io';

function getHeaders() {
  return { 'x-apisports-key': process.env.API_SPORTS_KEY || '' };
}

async function apiGet(base: string, path: string, params: Record<string, any> = {}): Promise<any> {
  if (!process.env.API_SPORTS_KEY) {
    console.warn('API_SPORTS_KEY not set');
    return null;
  }
  try {
    const response = await axios.get(`${base}${path}`, {
      params,
      headers: getHeaders(),
      timeout: 10000,
    });
    return response.data.response;
  } catch (err: any) {
    console.error(`Basketball API ${path} error:`, err?.response?.data || err.message);
    return null;
  }
}

export async function getNBAGamesToday(): Promise<any[]> {
  const today = new Date().toISOString().split('T')[0];
  return getNBAGamesByDate(today);
}

export async function getNBAGamesByDate(date: string): Promise<any[]> {
  const result = await apiGet(NBA_BASE, '/games', { date });
  return (result || []).map((g: any) => ({
    id: g.id,
    date: g.date?.start,
    home: g.teams?.home?.name,
    away: g.teams?.visitors?.name,
    score_home: g.scores?.home?.points,
    score_away: g.scores?.visitors?.points,
    status: g.status?.long,
    quarter: g.periods?.current,
  }));
}

export async function searchNBATeam(name: string): Promise<any[]> {
  const result = await apiGet(NBA_BASE, '/teams', { search: name });
  return (result || []).slice(0, 5).map((t: any) => ({
    id: t.id,
    name: t.name,
    city: t.city,
    conference: t.leagues?.standard?.conference,
    division: t.leagues?.standard?.division,
  }));
}

export async function getNBAStandings(season: string): Promise<any[]> {
  const east = await apiGet(NBA_BASE, '/standings', { league: 'standard', season, conference: 'east' }) || [];
  const west = await apiGet(NBA_BASE, '/standings', { league: 'standard', season, conference: 'west' }) || [];
  return [...east, ...west].slice(0, 16).map((s: any) => ({
    team: s.team?.name,
    conference: s.conference?.name,
    wins: s.win?.total,
    losses: s.loss?.total,
    pct: s.win?.percentage,
    home: `${s.win?.home}W-${s.loss?.home}L`,
    away: `${s.win?.away}W-${s.loss?.away}L`,
  }));
}

export async function getBasketballGamesToday(leagueId?: number, season?: string): Promise<any[]> {
  const today = new Date().toISOString().split('T')[0];
  const params: Record<string, any> = { date: today };
  if (leagueId) params.league = leagueId;
  if (season) params.season = season;
  const result = await apiGet(BASKETBALL_BASE, '/games', params);
  return (result || []).map((g: any) => ({
    id: g.id,
    date: g.date,
    home: g.teams?.home?.name,
    away: g.teams?.away?.name,
    score_home: g.scores?.home?.total,
    score_away: g.scores?.away?.total,
    status: g.status?.long,
    league: g.league?.name,
  }));
}

export const BASKETBALL_LEAGUES = {
  NBA: 12,
  NBB: 25,
  EUROLEAGUE: 120,
};
