import cron from 'node-cron';
import { getTodayFixtures, LEAGUES } from './sports';
import { getOdds, findValueBets, SPORT_KEYS } from './odds';
import { sendWhatsAppMessage } from './zapi';
import { query } from '../db';

async function getActiveSubscribers(): Promise<Array<{ phone: string; user_id: string }>> {
  return query<{ phone: string; user_id: string }>(
    `SELECT u.phone, u.id as user_id FROM users u
     INNER JOIN subscriptions s ON s.user_id = u.id
     WHERE s.status = 'active' AND (s.current_period_end IS NULL OR s.current_period_end > NOW())`
  );
}

async function buildDailyScannerMessage(): Promise<string> {
  const lines: string[] = [];
  lines.push('Scout X — Scan Diario');
  lines.push(`Data: ${new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })}`);
  lines.push('');

  try {
    const fixtures = await getTodayFixtures();
    const brFixtures = fixtures.filter(f =>
      [LEAGUES.BRASILEIRAO_A, LEAGUES.BRASILEIRAO_B, LEAGUES.LIBERTADORES, LEAGUES.SUL_AMERICANA].includes(f.league.id)
    );
    if (brFixtures.length > 0) {
      lines.push('Jogos de Hoje (Brasil)');
      brFixtures.slice(0, 5).forEach(f => {
        const time = new Date(f.fixture.date).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
        lines.push(`* ${f.teams.home.name} vs ${f.teams.away.name} - ${time}`);
      });
      lines.push('');
    }
  } catch (err) { console.error('Scanner: error fetching fixtures', err); }

  try {
    const odds = await getOdds(SPORT_KEYS.SOCCER_BRAZIL_CAMPEONATO);
    const valueBets = findValueBets(odds, 0.08);
    if (valueBets.length > 0) {
      lines.push('Value Bets Detectadas');
      valueBets.slice(0, 3).forEach(vb => {
        lines.push(`* ${vb.event}`);
        lines.push(`  ${vb.outcome} @ ${vb.bestOdds.toFixed(2)} (edge: ${(vb.edge * 100).toFixed(1)}%)`);
      });
      lines.push('');
    }
  } catch (err) { console.error('Scanner: error fetching odds', err); }

  lines.push('Me pergunte sobre qualquer jogo para analise detalhada!');
  lines.push('Apostas envolvem risco. Jogue com responsabilidade.');
  return lines.join('\n');
}

export function startDailyScanner(): void {
  cron.schedule('0 13 * * *', async () => {
    console.log('Starting daily scanner...');
    try {
      const subscribers = await getActiveSubscribers();
      if (subscribers.length === 0) { console.log('No active subscribers'); return; }
      const message = await buildDailyScannerMessage();
      for (const sub of subscribers) {
        await sendWhatsAppMessage(sub.phone, message);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      console.log('Daily scanner completed');
    } catch (err) { console.error('Daily scanner error:', err); }
  }, { timezone: 'America/Sao_Paulo' });
  console.log('Daily scanner scheduled for 10:00 AM Sao Paulo time');
}
