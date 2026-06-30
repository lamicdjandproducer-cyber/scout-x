import { Router, Request, Response } from 'express';
import { query, queryOne } from '../db';
import { sendWhatsAppMessage } from '../services/zapi';

const router = Router();

function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, '');
}

router.post('/signup', async (req: Request, res: Response) => {
  try {
    const { phone, name } = req.body;
    if (!phone) return res.status(400).json({ error: 'Telefone obrigatório' });

    const normalizedPhone = normalizePhone(phone);
    if (normalizedPhone.length < 10) return res.status(400).json({ error: 'Telefone inválido' });

    const trialEnd = new Date();
    trialEnd.setDate(trialEnd.getDate() + 7);

    const existing = await queryOne<{ id: string; trial_expires_at: Date | null }>(
      `SELECT id, trial_expires_at FROM users WHERE phone = $1`, [normalizedPhone]
    );

    if (existing) {
      if (existing.trial_expires_at) {
        return res.json({ success: false, message: 'Este número já utilizou o teste gratuito.', buy_url: 'https://buy.stripe.com/5kQfZi2yRfAoeTT0Kq7ss05' });
      }
      await query(`UPDATE users SET trial_expires_at = $1, name = COALESCE($2, name), updated_at = NOW() WHERE id = $3`, [trialEnd, name || null, existing.id]);
    } else {
      await query(`INSERT INTO users (phone, name, trial_expires_at) VALUES ($1, $2, $3)`, [normalizedPhone, name || null, trialEnd]);
    }

    const firstName = (name || '').split(' ')[0];
    const greeting = firstName ? `*${firstName}*` : 'você';

    await sendWhatsAppMessage(normalizedPhone,
      `👋 Olá, ${greeting}! Seja bem-vindo ao *Scout X*! 🏆\n\nSua semana de teste gratuita começou agora. Você tem *7 dias de acesso ilimitado* às nossas análises de apostas esportivas com IA.\n\n✅ Análises de futebol, basquete, tênis e mais\n✅ Value bets identificadas por IA\n✅ Suporte via chat 24/7\n\nMe manda uma pergunta sobre qualquer partida ou esporte para começar! ⚽🏀🎾\n\n_Digite /ajuda para ver os comandos disponíveis._`
    );

    console.log(`🎁 Trial started for ${normalizedPhone} (${name}), expires ${trialEnd.toISOString()}`);
    res.json({ success: true, message: 'Acesso liberado! Verifique seu WhatsApp.', trial_expires_at: trialEnd });
  } catch (err) {
    console.error('Trial signup error:', err);
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

export default router;
