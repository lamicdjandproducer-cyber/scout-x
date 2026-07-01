import cron from 'node-cron';
import { getTodayFixtures, LEAGUES } from './sports';
import { getOdds, findValueBets, SPORT_KEYS } from './odds';
import { sendWhatsAppMessage } from './zapi';
import { query } from '../db';

const PAYMENT_URL = 'https://buy.stripe.com/5kQfZi2yRfAoeTT0Kq7ss05';

async function getActiveUsers(): Promise<Array<{ phone: string; user_id: string }>> {
  return query<{ phone: string; user_id: string }>(
    `SELECT u.phone, u.id as user_id FROM users u
     WHERE (
       EXISTS (
         SELECT 1 FROM subscriptions s
         WHERE s.user_id = u.id AND s.status = 'active'
           AND (s.current_period_end IS NULL OR s.current_period_end > NOW())
       )
       OR (u.trial_expires_at IS NOT NULL AND u.trial_expires_at > NOW())
     )`
  );
}

async function buildDailyScannerMessage(): Promise<string> {
  const lines: string[] = [];
  lines.push('🔍 *Scout X — Scan Diário*');
  lines.push(`📅 ${new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })}`);
  lines.push('');

  try {
    const fixtures = await getTodayFixtures();
    const brazilianFixtures = fixtures.filter(f =>
      [LEAGUES.BRASILEIRAO_A, LEAGUES.BRASILEIRAO_B, LEAGUES.LIBERTADORES, LEAGUES.SUL_AMERICANA].includes(f.league.id)
    );
    if (brazilianFixtures.length > 0) {
      lines.push('⚽ *Jogos de Hoje (Brasil)*');
      brazilianFixtures.slice(0, 5).forEach(f => {
        const time = new Date(f.fixture.date).toLocaleTimeString('pt-BR', {
          hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo'
        });
        lines.push(`• ${f.teams.home.name} vs ${f.teams.away.name} — ${time}`);
      });
      if (brazilianFixtures.length > 5) lines.push(`  _(${brazilianFixtures.length - 5} jogos)`);
      lines.push('');
    }
  } catch (err) { console.error('Scanner: fixtures error', err); }

  try {
    const odds = await getOdds(SPORT_KEYS.SOCCER_BRAZIL_CAMPEONATO);
    const valueBets = findValueBets(odds, 0.08);
    if (valueBets.length > 0) {
      lines.push('💰 *Value Bets Detectadas*');
      valueBets.slice(0, 3).forEach(vb => {
        lines.push(`• *${vb.event}*`);
        lines.push(`  ${vb.outcome} @ ${vb.odds.toFixed(2)} (edge: ${(vb.edge * 100).toFixed(1)}%)`);
      });
      lines.push('');
    }
  } catch (err) { console.error('Scanner: odds error', err); }

  lines.push('💬 Me pergunte sobre qualquer jogo para análise detalhada!');
  lines.push('⚠️ _Apostas envolvem risco. Jogue com responsabilidade._');
  return lines.join('\n');
}

async function runTrialExpiryCheck(): Promise<void> {
  try {
    const expired = await query<{ id: string; phone: string; name: string | null }>(
      `SELECT id, phone, name FROM users
       WHERE trial_expires_at IS NOT NULL
         AND trial_expires_at < NOW()
         AND trial_expires_at > NOW() - INTERVAL '24 hours'
         AND trial_upsell_sent_at IS NULL`
    );
    if (expired.length === 0) return;
    console.log(`⏰ Sending trial expiry to ${expired.length} users`);

    for (const user of expired) {
      const firstName = user.name?.split(' ')[0] || '';
      const greeting = firstName ? `*${firstName}*, sua` : 'Sua';
      await sendWhatsAppMessage(user.phone,
        `⏰ ${greeting} semana de teste gratuito do *Scout X* terminou!\n\nEspero que tenha curtido as análises! 🏆\n\nPara continuar com acesso ilimitado:\n\n💎 *Scout X* — R$47/mês\n✅ Análises ilimitadas via WhatsApp\n✅ Value bets diários\n✅ Suporte 24/7 via IA\n\n📲 ${PAYMENT_URL}\n\nQualquer dúvida é só responder aqui! 🚀`
      );
      await query(`UPDATE users SET trial_upsell_sent_at = NOW() WHERE id = $1`, [user.id]);
      await new Promise(r => setTimeout(r, 500));
    }
  } catch (err) { console.error('❌ Trial expiry check error:', err); }
}

export function startDailyScanner(): void {
  // Daily scan at 10:00 AM São Paulo
  cron.schedule('0 13 * * *', async () => {
    console.log('🔍 Starting daily scanner...');
    try {
      const users = await getActiveUsers();
      if (users.length === 0) return;
      const message = await buildDailyScannerMessage();
      for (const u of users) {
        await sendWhatsAppMessage(u.phone, message);
        await new Promise(r => setTimeout(r, 500));
      }
      console.log(`✅ Daily scan sent to ${users.length} users`);
    } catch (err) { console.error('❌ Daily scanner error:', err); }
  }, { timezone: 'America/Sao_Paulo' });

  // Trial expiry check — every hour
  cron.schedule('0 * * * *', runTrialExpiryCheck, { timezone: 'America/Sao_Paulo' });

  console.log('⏰ Daily scanner: 10:00 AM | Trial expiry check: every hour');
}
