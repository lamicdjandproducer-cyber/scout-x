import axios from 'axios';

const API_FOOTBALL_BASE = 'https://v3.football.api-sports.io';

function getHeaders() {
  return {
    'x-apisports-key': process.env.API_SPORTS_KEY || '',
  };
}

async function apiGet(path: string, params: Record<string, any> = {}): Promise<any> {
  if (!process.env.API_SPORTS_KEY) {
    console.warn('API_SPORTS_KEY not set, skipping API-Football fetch');
    return null;
  }
  try {
    const response = await axios.get(`${API_FOOTBALL_BASE}${path}`, {
      params,
      headers: getHeaders(),
      timeout: 10000,
    });
    return response.data.response;
  } catch (err: any) {
    console.error(`API-Football ${path} error:`, err?.response?.data || err.message);
    return null;
  }
}

export interface Fixture {
  fixture: {
    id: number;
    date: string;
    status: { short: string; long: string };
  };
  league: { id: number; name: string; country: string };
  teams: {
    home: { id: number; name: string; logo: string };
    away: { id: number; name: string; logo: string };
  };
  goals: { home: number | null; away: number | null };
}

export async function getTodayFixtures(leagueId?: number): Promise<Fixture[]> {
  const today = new Date().toISOString().split('T')[0];
  const params: Record<string, any> = { date: today };
  if (leagueId) params.league = leagueId;
  const result = await apiGet('/fixtures', params);
  return result || [];
}

export async function searchTeam(name: string): Promise<any[]> {
  const result = await apiGet('/teams', { search: name });
  return (result || []).slice(0, 5).map((t: any) => ({
    id: t.team.id,
    name: t.team.name,
    country: t.team.country,
  }));
}

export async function getTeamRecentFixtures(teamId: number, last = 5): Promise<any[]> {
  const result = await apiGet('/fixtures', { team: teamId, last });
  return (result || []).map((f: any) => ({
    date: f.fixture.date,
    home: f.teams.home.name,
    away: f.teams.away.name,
    score: `${f.goals.home ?? '?'}-${f.goals.away ?? '?'}`,
    status: f.fixture.status.short,
    winner: f.teams.home.winner ? f.teams.home.name : f.teams.away.winner ? f.teams.away.name : 'Draw',
  }));
}

export async function getTeamNextFixtures(teamId: number, next = 3): Promise<any[]> {
  const result = await apiGet('/fixtures', { team: teamId, next });
  return (result || []).map((f: any) => ({
    date: f.fixture.date,
    home: f.teams.home.name,
    away: f.teams.away.name,
    league: f.league.name,
  }));
}

export async function getH2H(teamId1: number, teamId2: number, last = 10): Promise<any[]> {
  const result = await apiGet('/fixtures/headtohead', {
    h2h: `${teamId1}-${teamId2}`,
    last,
  });
  return (result || []).map((f: any) => ({
    date: f.fixture.date,
    home: f.teams.home.name,
    away: f.teams.away.name,
    score: `${f.goals.home ?? '?'}-${f.goals.away ?? '?'}`,
    winner: f.teams.home.winner ? f.teams.home.name : f.teams.away.winner ? f.teams.away.name : 'Draw',
  }));
}

export async function getFixtureInjuries(fixtureId: number): Promise<any[]> {
  const result = await apiGet('/injuries', { fixture: fixtureId });
  return (result || []).map((i: any) => ({
    player: i.player.name,
    team: i.team.name,
    type: i.player.type,
    reason: i.player.reason,
  }));
}

export async function getStandings(leagueId: number, season: number): Promise<any[]> {
  const result = await apiGet('/standings', { league: leagueId, season });
  const standings = result?.[0]?.league?.standings?.[0] || [];
  return standings.slice(0, 10).map((s: any) => ({
    rank: s.rank,
    team: s.team.name,
    played: s.all.played,
    won: s.all.win,
    drawn: s.all.draw,
    lost: s.all.lose,
    gf: s.all.goals.for,
    ga: s.all.goals.against,
    points: s.points,
    form: s.form,
  }));
}

export async function searchPlayer(name: string): Promise<any[]> {
  const result = await apiGet('/players/profiles', { search: name });
  return (result || []).slice(0, 5).map((p: any) => ({
    id: p.player.id,
    name: p.player.name,
    nationality: p.player.nationality,
    age: p.player.age,
    position: p.player.position,
  }));
}

export async function getPlayerStatistics(
  playerId: number,
  leagueId: number,
  season: number
): Promise<any> {
  const result = await apiGet('/players', { id: playerId, league: leagueId, season });
  if (!result?.[0]) return null;
  const p = result[0];
  return {
    player: p.player.name,
    season,
    stats: p.statistics.map((s: any) => ({
      league: s.league.name,
      team: s.team.name,
      games: s.games.appearences,
      goals: s.goals.total,
      assists: s.goals.assists,
      shots_on_target: s.shots?.on,
      key_passes: s.passes?.key,
      rating: s.games.rating,
    })),
  };
}

export async function getFixturesByLeague(leagueId: number, season: number): Promise<Fixture[]> {
  const result = await apiGet('/fixtures', { league: leagueId, season });
  return result || [];
}

export async function getTeamStats(teamId: number, leagueId: number, season: number): Promise<any> {
  return apiGet('/teams/statistics', { team: teamId, league: leagueId, season });
}

export const LEAGUES = {
  BRASILEIRAO_A: 71,
  BRASILEIRAO_B: 72,
  COPA_DO_BRASIL: 73,
  LIBERTADORES: 13,
  SUL_AMERICANA: 11,
  CHAMPIONS_LEAGUE: 2,
  PREMIER_LEAGUE: 39,
  LA_LIGA: 140,
  SERIE_A: 135,
  BUNDESLIGA: 78,
  LIGUE_1: 61,
  WORLD_CUP: 1,
};
