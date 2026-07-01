import { getTeamRecentFixtures, getH2H, getFixtureInjuries, getStandings } from './sports';
import { getOdds } from './odds';
import { getTeamForm } from './sportapi';
import { query } from '../db';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AdjustmentFactor {
  name: string;
  description: string;
  homeImpact: number;  // positive = helps home team probability
  awayImpact: number;  // positive = helps away team probability
}

export interface ValueBet {
  outcome: 'home' | 'draw' | 'away';
  outcomeName: string;
  bookmaker: string;
  odds: number;
  marketFairProb: number;  // % — no-vig from best odds
  adjFairProb: number;     // % — after situational adjustments
  edge: number;            // % — positive = value exists
  kellyFraction: number;   // % of bankroll recommended
  signal: 'FORTE' | 'MODERADO' | 'MARGINAL';
}

export interface FullMatchAnalysis {
  homeTeam: string;
  awayTeam: string;
  datetime?: string;

  // Step 1 — Market consensus (no-vig)
  marketProb: { home: number; draw: number; away: number };
  overround: number;

  // Step 2 — Poisson model (statistical)
  poissonProb?: { home: number; draw: number; away: number };
  homeExpectedGoals?: number;
  awayExpectedGoals?: number;

  // Step 3 — Situational factors
  factors: AdjustmentFactor[];

  // Step 4 — Final blended probability
  finalProb: { home: number; draw: number; away: number };

  // Step 5 — Value bets found
  valueBets: ValueBet[];

  // Step 6 — Confidence and recommendation
  confidenceScore: number;         // 0–100
  confidenceLabel: 'ALTA' | 'MÉDIA' | 'BAIXA';
  topPick?: ValueBet;
  summary: string;

  // Context
  homeForm: string;
  awayForm: string;
  h2hSummary: string;
  keyInjuries: string[];
}

// ─── Poisson Model ────────────────────────────────────────────────────────────

/** P(X = k) for Poisson distribution with mean lambda */
function poissonProb(lambda: number, k: number): number {
  if (k < 0) return 0;
  let result = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) result *= lambda / i;
  return result;
}

/** Full match probability matrix from expected goals */
export function poissonMatchProbs(
  lambdaHome: number,
  lambdaAway: number
): { home: number; draw: number; away: number } {
  const MAX_GOALS = 8;
  let home = 0, draw = 0, away = 0;
  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      const p = poissonProb(lambdaHome, h) * poissonProb(lambdaAway, a);
      if (h > a) home += p;
      else if (h === a) draw += p;
      else away += p;
    }
  }
  // Normalize to account for truncation at MAX_GOALS
  const total = home + draw + away;
  return {
    home: home / total,
    draw: draw / total,
    away: away / total,
  };
}

// ─── No-Vig Fair Probability ──────────────────────────────────────────────────

interface OddsLine { home: number; draw: number; away: number }

export function removeVig(odds: OddsLine): { home: number; draw: number; away: number; overround: number } {
  const sumImplied = 1/odds.home + 1/odds.draw + 1/odds.away;
  return {
    home: (1/odds.home) / sumImplied,
    draw: (1/odds.draw) / sumImplied,
    away: (1/odds.away) / sumImplied,
    overround: Math.round((sumImplied - 1) * 1000) / 10,
  };
}

/** Get best (highest) odds per outcome across all bookmakers */
export function getBestOdds(events: any[]): { home: number; draw: number; away: number } | null {
  let bestHome = 0, bestDraw = 0, bestAway = 0;
  for (const event of events) {
    for (const bm of (event.bookmakers || [])) {
      const h2h = bm.markets?.find((m: any) => m.key === 'h2h');
      if (!h2h) continue;
      for (const o of h2h.outcomes) {
        if (o.name === event.home_team) bestHome = Math.max(bestHome, o.price);
        else if (o.name === event.away_team) bestAway = Math.max(bestAway, o.price);
        else bestDraw = Math.max(bestDraw, o.price);
      }
    }
  }
  if (!bestHome || !bestAway) return null;
  if (!bestDraw) {
    // 2-way market (no draw, e.g. NBA, tennis)
    return { home: bestHome, draw: 0, away: bestAway };
  }
  return { home: bestHome, draw: bestDraw, away: bestAway };
}

// ─── Form Analysis ────────────────────────────────────────────────────────────

interface FixtureResult { result: 'W' | 'D' | 'L'; goalsFor: number; goalsAgainst: number }

function parseForm(fixtures: any[], teamId: number): { form: string; avgGoalsFor: number; avgGoalsAgainst: number; points: number } {
  const results: FixtureResult[] = [];
  for (const f of (fixtures || []).slice(0, 5)) {
    const isHome = f.teams?.home?.id === teamId;
    const homeGoals = f.goals?.home ?? 0;
    const awayGoals = f.goals?.away ?? 0;
    const gf = isHome ? homeGoals : awayGoals;
    const ga = isHome ? awayGoals : homeGoals;
    const won = gf > ga;
    const drew = gf === ga;
    results.push({ result: won ? 'W' : drew ? 'D' : 'L', goalsFor: gf, goalsAgainst: ga });
  }
  const form = results.map(r => r.result).join('');
  const points = results.reduce((s, r) => s + (r.result === 'W' ? 3 : r.result === 'D' ? 1 : 0), 0);
  const n = results.length || 1;
  return {
    form,
    avgGoalsFor: results.reduce((s, r) => s + r.goalsFor, 0) / n,
    avgGoalsAgainst: results.reduce((s, r) => s + r.goalsAgainst, 0) / n,
    points,
  };
}

/** Form factor: deviation from neutral (7.5 pts in 5 games = 50%)
 *  Returns impact on home probability: +0.06 (hot) to -0.06 (cold) */
function formFactor(points: number): number {
  // Max = 15 pts, neutral = 7.5
  return ((points - 7.5) / 7.5) * 0.06;
}

// ─── H2H Analysis ─────────────────────────────────────────────────────────────

function parseH2H(h2hFixtures: any[], homeTeamId: number): { summary: string; homeDominance: number } {
  let homeWins = 0, draws = 0, awayWins = 0;
  for (const f of (h2hFixtures || []).slice(0, 10)) {
    const homeScore = f.goals?.home ?? 0;
    const awayScore = f.goals?.away ?? 0;
    const fixtureHome = f.teams?.home?.id;
    if (fixtureHome === homeTeamId) {
      if (homeScore > awayScore) homeWins++;
      else if (homeScore === awayScore) draws++;
      else awayWins++;
    } else {
      if (awayScore > homeScore) homeWins++;
      else if (homeScore === awayScore) draws++;
      else awayWins++;
    }
  }
  const total = homeWins + draws + awayWins || 1;
  const summary = `${homeWins}V ${draws}E ${awayWins}D (últimos ${total})`;
  // Dominance: +1 = home always wins, -1 = away always wins, 0 = neutral
  const dominance = (homeWins - awayWins) / total;
  return { summary, homeDominance: dominance };
}

// ─── Injury Factor ────────────────────────────────────────────────────────────

function parseInjuries(injuryData: any[], homeTeamId: number): { list: string[]; homeImpact: number; awayImpact: number } {
  const list: string[] = [];
  let homeImpact = 0;
  let awayImpact = 0;

  for (const inj of (injuryData || [])) {
    const player = inj.player?.name || 'Unknown';
    const team = inj.team?.id;
    const reason = inj.player?.reason || 'Lesão';
    const isHome = team === homeTeamId;

    list.push(`${player} (${isHome ? 'Casa' : 'Fora'}) — ${reason}`);

    // Rough positional impact (goalkeeper/defender = bigger impact than midfielder/striker)
    const type = inj.player?.type?.toLowerCase() || '';
    const impact = type.includes('goal') ? 0.08 : type.includes('defend') ? 0.06 : 0.04;

    if (isHome) homeImpact -= impact;
    else awayImpact -= impact;
  }

  return { list, homeImpact, awayImpact };
}

// ─── League Home Advantage ───────────────────────────────────────────────────

// Historical home advantage by league (based on win rate data)
const HOME_ADVANTAGE_BY_LEAGUE: Record<number, number> = {
  71: 0.07,   // Brasileirão A — strong home advantage (~55% home win rate)
  72: 0.06,   // Brasileirão B
  73: 0.05,   // Copa do Brasil
  13: 0.05,   // Libertadores
  2:  0.04,   // Champions League
  39: 0.04,   // Premier League
  140: 0.05,  // La Liga
  135: 0.06,  // Serie A
  78: 0.05,   // Bundesliga
  61: 0.05,   // Ligue 1
};

// ─── Blend Probabilities ─────────────────────────────────────────────────────

/** Weighted blend of market probability and Poisson model.
 *  Market = 60% (captures sharp money), Poisson = 40% (our statistical model) */
function blendProbs(
  market: { home: number; draw: number; away: number },
  poisson?: { home: number; draw: number; away: number }
): { home: number; draw: number; away: number } {
  if (!poisson) return market;
  return {
    home: market.home * 0.6 + poisson.home * 0.4,
    draw: market.draw * 0.6 + poisson.draw * 0.4,
    away: market.away * 0.6 + poisson.away * 0.4,
  };
}

/** Apply adjustment factors to blended probability */
function applyFactors(
  base: { home: number; draw: number; away: number },
  factors: AdjustmentFactor[]
): { home: number; draw: number; away: number } {
  let { home, draw, away } = base;

  for (const f of factors) {
    home = Math.max(0.02, Math.min(0.96, home + f.homeImpact));
    away = Math.max(0.02, Math.min(0.96, away + f.awayImpact));
    draw = Math.max(0.01, Math.min(0.90, draw - (f.homeImpact + f.awayImpact) * 0.5));
  }

  // Re-normalize to sum to 1
  const total = home + draw + away;
  return { home: home / total, draw: draw / total, away: away / total };
}

// ─── Value Bet Detection ──────────────────────────────────────────────────────

function detectValueBets(
  finalProb: { home: number; draw: number; away: number },
  marketFairProb: { home: number; draw: number; away: number },
  oddsEvents: any[],
  minEdge = 0.04
): ValueBet[] {
  const bets: ValueBet[] = [];

  const outcomes: Array<{ key: 'home' | 'draw' | 'away'; marketProb: number; adjProb: number }> = [
    { key: 'home', marketProb: marketFairProb.home, adjProb: finalProb.home },
    { key: 'draw', marketProb: marketFairProb.draw, adjProb: finalProb.draw },
    { key: 'away', marketProb: marketFairProb.away, adjProb: finalProb.away },
  ];

  for (const event of oddsEvents) {
    for (const bm of (event.bookmakers || [])) {
      const h2h = bm.markets?.find((m: any) => m.key === 'h2h');
      if (!h2h) continue;

      for (const o of h2h.outcomes) {
        let outcomeKey: 'home' | 'draw' | 'away';
        if (o.name === event.home_team) outcomeKey = 'home';
        else if (o.name === event.away_team) outcomeKey = 'away';
        else outcomeKey = 'draw';

        const outcomeData = outcomes.find(x => x.key === outcomeKey);
        if (!outcomeData) continue;

        const adjProb = outcomeData.adjProb;
        const edge = o.price * adjProb - 1;

        if (edge >= minEdge) {
          const kelly = Math.min(
            (edge / (o.price - 1)) * 0.25, // fractional Kelly (25%)
            0.05 // cap at 5% of bankroll
          );
          bets.push({
            outcome: outcomeKey,
            outcomeName: o.name,
            bookmaker: bm.title,
            odds: Math.round(o.price * 100) / 100,
            marketFairProb: Math.round(outcomeData.marketProb * 1000) / 10,
            adjFairProb: Math.round(adjProb * 1000) / 10,
            edge: Math.round(edge * 1000) / 10,
            kellyFraction: Math.round(kelly * 1000) / 10,
            signal: edge >= 0.10 ? 'FORTE' : edge >= 0.06 ? 'MODERADO' : 'MARGINAL',
          });
        }
      }
    }
  }

  // Deduplicate: same outcome, keep highest edge
  const seen = new Map<string, ValueBet>();
  for (const b of bets.sort((a, z) => z.edge - a.edge)) {
    const key = b.outcome;
    if (!seen.has(key)) seen.set(key, b);
  }
  return [...seen.values()].sort((a, z) => z.edge - a.edge);
}

// ─── Confidence Score ─────────────────────────────────────────────────────────

function calcConfidence(
  factors: AdjustmentFactor[],
  valueBets: ValueBet[],
  dataQuality: { hasOdds: boolean; hasForm: boolean; hasH2H: boolean; hasInjuries: boolean }
): { score: number; label: 'ALTA' | 'MÉDIA' | 'BAIXA' } {
  let score = 40; // base

  // Data quality
  if (dataQuality.hasOdds) score += 15;
  if (dataQuality.hasForm) score += 10;
  if (dataQuality.hasH2H) score += 10;
  if (dataQuality.hasInjuries) score += 5;

  // Factor alignment (are multiple factors pointing same way?)
  const totalHomeImpact = factors.reduce((s, f) => s + f.homeImpact, 0);
  const totalAwayImpact = factors.reduce((s, f) => s + f.awayImpact, 0);
  const maxImpact = Math.max(Math.abs(totalHomeImpact), Math.abs(totalAwayImpact));
  if (maxImpact > 0.10) score += 15;
  else if (maxImpact > 0.05) score += 8;

  // Value bet quality
  const strongBets = valueBets.filter(v => v.signal === 'FORTE').length;
  const modBets = valueBets.filter(v => v.signal === 'MODERADO').length;
  score += strongBets * 5 + modBets * 2;

  score = Math.min(95, Math.max(20, score));
  return {
    score,
    label: score >= 70 ? 'ALTA' : score >= 50 ? 'MÉDIA' : 'BAIXA',
  };
}

// ─── CLV Tracking ────────────────────────────────────────────────────────────

export async function logRecommendation(
  homeTeam: string,
  awayTeam: string,
  outcome: string,
  odds: number,
  fairProb: number,
  adjProb: number,
  edge: number,
  sportKey?: string
): Promise<void> {
  try {
    await query(
      `INSERT INTO bet_recommendations
       (home_team, away_team, outcome, recommended_odds, fair_prob, adj_prob, edge, sport_key, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
       ON CONFLICT DO NOTHING`,
      [homeTeam, awayTeam, outcome, odds, fairProb, adjProb, edge, sportKey || null]
    );
  } catch {
    // Table might not exist yet — safe to ignore
  }
}

// ─── MAIN ANALYSIS FUNCTION ───────────────────────────────────────────────────

export interface MatchAnalysisInput {
  homeTeamId: number;
  awayTeamId: number;
  homeTeamName: string;
  awayTeamName: string;
  fixtureId?: number;
  leagueId?: number;
  sportKey?: string;
  datetime?: string;
}

export async function fullMatchAnalysis(input: MatchAnalysisInput): Promise<FullMatchAnalysis> {
  const {
    homeTeamId, awayTeamId, homeTeamName, awayTeamName,
    fixtureId, leagueId, sportKey, datetime
  } = input;

  // ── Fetch all data in parallel ─────────────────────────────────────────────
  const [homeFixtures, awayFixtures, h2hFixtures, injuryData, oddsData] = await Promise.allSettled([
    getTeamRecentFixtures(homeTeamId, 8),
    getTeamRecentFixtures(awayTeamId, 8),
    getH2H(homeTeamId, awayTeamId, 10),
    fixtureId ? getFixtureInjuries(fixtureId) : Promise.resolve([]),
    sportKey ? getOdds(sportKey, 'eu', 'h2h') : Promise.resolve([]),
  ]);

  const homeF = homeFixtures.status === 'fulfilled' ? homeFixtures.value : [];
  const awayF = awayFixtures.status === 'fulfilled' ? awayFixtures.value : [];
  const h2hF  = h2hFixtures.status  === 'fulfilled' ? h2hFixtures.value  : [];
  const injF  = injuryData.status   === 'fulfilled' ? injuryData.value   : [];
  const oddsF = oddsData.status     === 'fulfilled' ? oddsData.value     : [];

  // ── Step 1: Form Analysis ──────────────────────────────────────────────────
  const homeFormData = parseForm(homeF, homeTeamId);
  const awayFormData = parseForm(awayF, awayTeamId);

  // ── Step 2: H2H Analysis ──────────────────────────────────────────────────
  const h2hData = parseH2H(h2hF, homeTeamId);

  // ── Step 3: Injury Analysis ───────────────────────────────────────────────
  const injuryAnalysis = parseInjuries(injF, homeTeamId);

  // ── Step 4: Market Fair Probability ──────────────────────────────────────
  // Find odds for this specific match
  const matchOddsEvents = oddsF.filter((e: any) =>
    (e.home_team?.toLowerCase().includes(homeTeamName.toLowerCase().slice(0, 4)) ||
     e.away_team?.toLowerCase().includes(awayTeamName.toLowerCase().slice(0, 4)))
  );

  const bestOdds = matchOddsEvents.length > 0 ? getBestOdds(matchOddsEvents) : null;
  let marketProb = { home: 0.4, draw: 0.25, away: 0.35 }; // fallback
  let overround = 0;
  if (bestOdds && bestOdds.home && bestOdds.away) {
    const noVig = bestOdds.draw
      ? removeVig({ home: bestOdds.home, draw: bestOdds.draw, away: bestOdds.away })
      : { home: bestOdds.home / (bestOdds.home + bestOdds.away), draw: 0, away: bestOdds.away / (bestOdds.home + bestOdds.away), overround: 0 };
    marketProb = { home: noVig.home, draw: noVig.draw, away: noVig.away };
    overround = noVig.overround;
  }

  // ── Step 5: Poisson Model ─────────────────────────────────────────────────
  const LEAGUE_AVG_GOALS = 1.45; // goals per team per game
  const homeAttack = homeFormData.avgGoalsFor / LEAGUE_AVG_GOALS;
  const homeDefense = homeFormData.avgGoalsAgainst / LEAGUE_AVG_GOALS;
  const awayAttack = awayFormData.avgGoalsFor / LEAGUE_AVG_GOALS;
  const awayDefense = awayFormData.avgGoalsAgainst / LEAGUE_AVG_GOALS;

  let poissonProb: { home: number; draw: number; away: number } | undefined;
  let homeXG: number | undefined;
  let awayXG: number | undefined;

  if (homeFormData.form.length > 0 && awayFormData.form.length > 0) {
    homeXG = Math.max(0.4, homeAttack * awayDefense * LEAGUE_AVG_GOALS * 1.1); // +10% home advantage
    awayXG = Math.max(0.3, awayAttack * homeDefense * LEAGUE_AVG_GOALS);
    poissonProb = poissonMatchProbs(homeXG, awayXG);
  }

  // ── Step 6: Build Adjustment Factors ─────────────────────────────────────
  const factors: AdjustmentFactor[] = [];

  // Form factor
  const homeFormImpact = formFactor(homeFormData.points);
  const awayFormImpact = formFactor(awayFormData.points);
  if (Math.abs(homeFormImpact - awayFormImpact) > 0.01) {
    factors.push({
      name: '📊 Forma Recente',
      description: `${homeTeamName}: ${homeFormData.form || 'N/A'} | ${awayTeamName}: ${awayFormData.form || 'N/A'}`,
      homeImpact: homeFormImpact,
      awayImpact: awayFormImpact,
    });
  }

  // H2H factor
  if (h2hData.homeDominance !== 0 && Math.abs(h2hData.homeDominance) > 0.1) {
    const h2hImpact = h2hData.homeDominance * 0.04;
    factors.push({
      name: '🤝 Histórico H2H',
      description: h2hData.summary,
      homeImpact: h2hImpact,
      awayImpact: -h2hImpact * 0.5,
    });
  }

  // Injury factor
  if (injuryAnalysis.homeImpact !== 0 || injuryAnalysis.awayImpact !== 0) {
    factors.push({
      name: '🏥 Desfalques',
      description: injuryAnalysis.list.slice(0, 3).join(', ') || 'Nenhum confirmado',
      homeImpact: injuryAnalysis.homeImpact,
      awayImpact: injuryAnalysis.awayImpact,
    });
  }

  // League home advantage
  const leagueHomeAdv = leagueId ? (HOME_ADVANTAGE_BY_LEAGUE[leagueId] || 0.04) : 0.04;
  factors.push({
    name: '🏟️ Mando de Campo',
    description: `Vantagem histórica de campo (${Math.round(leagueHomeAdv * 100)}%)`,
    homeImpact: leagueHomeAdv,
    awayImpact: -leagueHomeAdv * 0.3,
  });

  // ── Step 7: Final Blended + Adjusted Probability ──────────────────────────
  const blended = blendProbs(marketProb, poissonProb);
  const finalProb = applyFactors(blended, factors);

  // ── Step 8: Value Bet Detection ───────────────────────────────────────────
  const valueBets = matchOddsEvents.length > 0
    ? detectValueBets(finalProb, marketProb, matchOddsEvents)
    : [];

  // ── Step 9: Confidence Score ──────────────────────────────────────────────
  const dataQuality = {
    hasOdds: matchOddsEvents.length > 0,
    hasForm: homeFormData.form.length > 0,
    hasH2H: h2hF.length > 0,
    hasInjuries: injF.length > 0,
  };
  const { score: confidenceScore, label: confidenceLabel } = calcConfidence(factors, valueBets, dataQuality);

  // ── Step 10: Top Pick ─────────────────────────────────────────────────────
  const topPick = valueBets.find(v => v.signal === 'FORTE') || valueBets[0];

  // ── Step 11: Log for CLV Tracking ─────────────────────────────────────────
  if (topPick) {
    await logRecommendation(
      homeTeamName, awayTeamName, topPick.outcome,
      topPick.odds, topPick.marketFairProb / 100,
      topPick.adjFairProb / 100, topPick.edge / 100, sportKey
    );
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const homeProb = Math.round(finalProb.home * 100);
  const drawProb = Math.round(finalProb.draw * 100);
  const awayProb = Math.round(finalProb.away * 100);
  const summary = topPick
    ? `Nossa análise aponta ${homeProb}% de chance para ${homeTeamName}, ${drawProb}% empate, ${awayProb}% ${awayTeamName}. Melhor aposta: ${topPick.outcomeName} @ ${topPick.odds} (${topPick.bookmaker}) — edge de ${topPick.edge}%, Kelly: ${topPick.kellyFraction}% da banca. Confiança: ${confidenceLabel}.`
    : `Probabilidades: ${homeTeamName} ${homeProb}% | Empate ${drawProb}% | ${awayTeamName} ${awayProb}%. Nenhum value bet acima de 4% identificado neste mercado.`;

  return {
    homeTeam: homeTeamName,
    awayTeam: awayTeamName,
    datetime,
    marketProb: {
      home: Math.round(marketProb.home * 1000) / 10,
      draw: Math.round(marketProb.draw * 1000) / 10,
      away: Math.round(marketProb.away * 1000) / 10,
    },
    overround,
    poissonProb: poissonProb ? {
      home: Math.round(poissonProb.home * 1000) / 10,
      draw: Math.round(poissonProb.draw * 1000) / 10,
      away: Math.round(poissonProb.away * 1000) / 10,
    } : undefined,
    homeExpectedGoals: homeXG ? Math.round(homeXG * 100) / 100 : undefined,
    awayExpectedGoals: awayXG ? Math.round(awayXG * 100) / 100 : undefined,
    factors,
    finalProb: {
      home: Math.round(finalProb.home * 1000) / 10,
      draw: Math.round(finalProb.draw * 1000) / 10,
      away: Math.round(finalProb.away * 1000) / 10,
    },
    valueBets,
    confidenceScore,
    confidenceLabel,
    topPick,
    summary,
    homeForm: homeFormData.form || 'N/A',
    awayForm: awayFormData.form || 'N/A',
    h2hSummary: h2hData.summary,
    keyInjuries: injuryAnalysis.list,
  };
}
