import { queryOne } from '../db';
import { sendWhatsAppMessage } from '../services/zapi';

const PAYMENT_URL = 'https://buy.stripe.com/5kQfZi2yRfAoeTT0Kq7ss05';

interface User {
  id: string;
  phone: string;
  name: string | null;
  stripe_customer_id: string | null;
  trial_expires_at: Date | null;
}

interface Subscription {
  id: string;
  user_id: string;
  status: string;
  current_period_end: Date | null;
}

export type AccessStatus = 'active' | 'trial_active' | 'trial_expired' | 'no_access';

export async function getOrCreateUser(phone: string, name?: string): Promise<User> {
  let user = await queryOne<User>(`SELECT * FROM users WHERE phone = $1`, [phone]);
  if (!user) {
    user = await queryOne<User>(
      `INSERT INTO users (phone, name) VALUES ($1, $2) RETURNING *`,
      [phone, name || null]
    );
  }
  return user!;
}

export async function getUserSubscription(userId: string): Promise<Subscription | null> {
  return queryOne<Subscription>(
    `SELECT * FROM subscriptions
     WHERE user_id = $1
       AND status = 'active'
       AND (current_period_end IS NULL OR current_period_end > NOW())
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
}

export async function getAccessStatus(user: User): Promise<AccessStatus> {
  const sub = await getUserSubscription(user.id);
  if (sub) return 'active';
  if (user.trial_expires_at) {
    return new Date(user.trial_expires_at) > new Date() ? 'trial_active' : 'trial_expired';
  }
  return 'no_access';
}

export async function hasActiveSubscription(userId: string): Promise<boolean> {
  const sub = await getUserSubscription(userId);
  if (sub) return true;
  const user = await queryOne<{ trial_expires_at: Date | null }>(
    `SELECT trial_expires_at FROM users WHERE id = $1`, [userId]
  );
  return !!(user?.trial_expires_at && new Date(user.trial_expires_at) > new Date());
}

async function sendTrialExpiredMessage(phone: string, name: string | null): Promise<void> {
  const firstName = name?.split(' ')[0] || '';
  const greeting = firstName ? `*${firstName}*, sua` : 'Sua';
  await sendWhatsAppMessage(phone,
    `⏰ ${greeting} semana de teste gratuito do *Scout X* terminou!\n\nEspero que tenha gostado das análises! 🏆\n\nPara continuar tendo acesso ilimitado:\n\n💎 *Plano Scout X* — R$47/mês\n✅ Análises ilimitadas via WhatsApp\n✅ Cobertura de 7+ esportes\n✅ Value bets diários\n✅ Suporte 24/7 via IA\n\n📲 *Assine agora:*\n${PAYMENT_URL}\n\nQualquer dúvida, é só responder aqui! 🚀`
  );
}

async function sendNoAccessMessage(phone: string): Promise<void> {
  await sendWhatsAppMessage(phone,
    `👋 Olá! Sou o *Scout X*, seu assistente de apostas esportivas com IA.\n\n💎 *Plano Scout X* — R$47/mês\n✅ Análises ilimitadas via WhatsApp\n✅ Cobertura de 7+ esportes\n✅ Value bets diários\n✅ Suporte 24/7 via IA\n\n📲 *Assine agora:*\n${PAYMENT_URL}\n\nApós o pagamento, envie qualquer mensagem para começar! 🚀`
  );
}

export async function checkSubscriptionAndNotify(
  phone: string,
  userName?: string
): Promise<{ user: User; hasAccess: boolean }> {
  const user = await getOrCreateUser(phone, userName);
  const status = await getAccessStatus(user);

  if (status === 'active' || status === 'trial_active') {
    return { user, hasAccess: true };
  }

  if (status === 'trial_expired') {
    await sendTrialExpiredMessage(phone, user.name);
  } else {
    await sendNoAccessMessage(phone);
  }

  return { user, hasAccess: false };
}
