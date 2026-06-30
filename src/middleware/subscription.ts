import { queryOne } from '../db';
import { sendWhatsAppMessage } from '../services/zapi';

const STRIPE_PAYMENT_URL = 'https://buy.stripe.com/5kQfZi2yRfAoeTT0Kq7ss05';

interface User {
  id: string;
  phone: string;
  name: string | null;
  stripe_customer_id: string | null;
}

interface Subscription {
  id: string;
  user_id: string;
  status: string;
  current_period_end: Date | null;
}

export async function getOrCreateUser(phone: string, name?: string): Promise<User> {
  let user = await queryOne<User>(
    `SELECT * FROM users WHERE phone = $1`,
    [phone]
  );

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
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId]
  );
}

export async function hasActiveSubscription(userId: string): Promise<boolean> {
  const sub = await getUserSubscription(userId);
  return sub !== null;
}

export async function sendSubscriptionGate(phone: string): Promise<void> {
  const url = STRIPE_PAYMENT_URL;
  const message = `👋 Olá! Sou o *Scout X*, seu assistente de apostas esportivas com IA.

Para acessar as análises, você precisa de uma assinatura ativa.

💎 *Plano Scout X* — R$47/mês
✅ Análises ilimitadas via WhatsApp
✅ Cobertura de 7+ esportes
✅ Value bets diários
✅ Suporte 24/7 via IA

📲 *Assine agora:*
` + url + `

Após o pagamento, envie qualquer mensagem para começar! 🚀`;

  await sendWhatsAppMessage(phone, message);
}

export async function checkSubscriptionAndNotify(phone: string, userName?: string): Promise<{ user: User; hasAccess: boolean }> {
  const user = await getOrCreateUser(phone, userName);
  const hasAccess = await hasActiveSubscription(user.id);

  if (!hasAccess) {
    await sendSubscriptionGate(phone);
  }

  return { user, hasAccess };
}
