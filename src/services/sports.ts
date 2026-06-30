import axios from 'axios';

const API_FOOTBALL_BASE = 'https://v3.football.api-sports.io';

interface Fixture {
  fixture: { id: number; date: string; status: { short: string; long: string } };
  league: { id: number; name: string; country: string };
  teams: { home: { id: number; name: string }; away: { id: number; name: string } };
  goals: { home: number | null; away: number | null };
}

export async function getTodayFixtures(leagueId?: number): Promise<Fixture[]> {
  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey) { console.warn('API_FOOTBALL_KEY not set'); return []; }
  try {
    const today = new Date().toISOString().split('T')[0];
    const params: Record<string, any> = { date: today };
    if (leagueId) params.league = leagueId;
    const response = await axios.get(`${API_FOOTBALL_BASE}/fixtures`, {
      params,
      headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': 'v3.football.api-sports.io' },
      timeout: 10000,
    });
    return response.data.response || [];
  } catch (err: any) {
    console.error('API-Football error:', err?.response?.data || err.message);
    return [];
  }
}

export async function getTeamStats(teamId: number, leagueId: number, season: number): Promise<any> {
  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey) return null;
  try {
    const response = await axios.get(`${API_FOOTBALL_BASE}/teams/statistics`, {
      params: { team: teamId, league: leagueId, season },
      headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': 'v3.football.api-sports.io' },
      timeout: 10000,
    });
    return response.data.response;
  } catch (err: any) {
    console.error('API-Football team stats error:', err?.response?.data || err.message);
    return null;
  }
}

export const LEAGUES = {
  BRASILEIRAO_A: 71, BRASILEIRAO_B: 72, COPA_DO_BRASIL: 73,
  LIBERTADORES: 13, SUL_AMERICANA: 11, CHAMPIONS_LEAGUE: 2,
  PREMIER_LEAGUE: 39, LA_LIGA: 140, SERIE_A: 135, BUNDESLIGA: 78, LIGUE_1: 61,
};
