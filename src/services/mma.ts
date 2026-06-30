import axios from 'axios';

const MMA_BASE = 'https://v1.mma.api-sports.io';

function getHeaders() {
  return { 'x-apisports-key': process.env.API_SPORTS_KEY || '' };
}

async function apiGet(path: string, params: Record<string, any> = {}): Promise<any> {
  if (!process.env.API_SPORTS_KEY) { console.warn('API_SPORTS_KEY not set'); return null; }
  try {
    const response = await axios.get(`${MMA_BASE}${path}`, { params, headers: getHeaders(), timeout: 10000 });
    return response.data.response;
  } catch (err: any) {
    console.error(`MMA API ${path} error:`, err?.response?.data || err.message);
    return null;
  }
}

export async function getUpcomingEvents(): Promise<any[]> {
  const result = await apiGet('/events');
  return (result || []).slice(0, 10).map((e: any) => ({
    id: e.id,
    name: e.name,
    date: e.date,
    location: e.location,
    fights: e.fights_count,
  }));
}

export async function getEventFights(eventId: number): Promise<any[]> {
  const result = await apiGet('/fights', { event: eventId });
  return (result || []).map((f: any) => ({
    id: f.id,
    fighter1: `${f.fighters?.first?.name} (${f.fighters?.first?.record || 'N/A'})`,
    fighter2: `${f.fighters?.second?.name} (${f.fighters?.second?.record || 'N/A'})`,
    weight_class: f.categories?.[0]?.name,
    winner: f.winner?.name || 'TBD',
    method: f.result?.method,
    round: f.result?.round,
  }));
}

export async function searchFighter(name: string): Promise<any[]> {
  const result = await apiGet('/fighters', { search: name });
  return (result || []).slice(0, 5).map((f: any) => ({
    id: f.id,
    name: f.name,
    record: `${f.record?.wins || 0}W-${f.record?.losses || 0}L-${f.record?.draws || 0}D`,
    weight_class: f.weight_class,
    nationality: f.nationality,
    age: f.age,
  }));
}

export async function getFighterStats(fighterId: number): Promise<any> {
  const result = await apiGet('/fighters/statistics', { id: fighterId });
  if (!result?.[0]) return null;
  const s = result[0];
  return {
    name: s.name,
    record: `${s.record?.wins || 0}W-${s.record?.losses || 0}L-${s.record?.draws || 0}D`,
    weight_class: s.weight_class,
    wins_by_ko: s.record?.wins_by_ko,
    wins_by_sub: s.record?.wins_by_submission,
    wins_by_decision: s.record?.wins_by_decision,
  };
}
