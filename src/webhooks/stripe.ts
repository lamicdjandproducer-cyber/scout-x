import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { query, queryOne } from '../db';
import { sendWhatsAppMessage } from '../services/zapi';

const router = Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16',
});

interface User {
  id: string;
  phone: string;
  name: string | null;
}

// Normalize phone: strip everything except digits
function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, '');
}

async function getUserByStripeCustomerId(customerId: string): Promise<User | null> {
  return queryOne<User>(
    `SELECT u.* FROM users u WHERE u.stripe_customer_id = $1`,
    [customerId]
  );
}

async function upsertSubscription(
  userId: string,
  stripeSubscriptionId: string,
  customerId: string,
  status: string,
  priceId: string | null,
  periodStart: Date | null,
  periodEnd: Date | null,
  cancelAtPeriodEnd: boolean
): Promise<void> {
  await query(
    `INSERT INTO subscriptions (user_id, stripe_subscription_id, stripe_customer_id, status, price_id, current_period_start, current_period_end, cancel_at_period_end)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (stripe_subscription_id) DO UPDATE SET
       status = EXCLUDED.status,
       current_period_start = EXCLUDED.current_period_start,
       current_period_end = EXCLUDED.current_period_end,
       cancel_at_period_end = EXCLUDED.cancel_at_period_end,
       updated_at = NOW()`,
    [userId, stripeSubscriptionId, customerId, status, priceId, periodStart, periodEnd, cancelAtPeriodEnd]
  );
}

function buildWelcomeMessage(firstName: string): string {
  const greeting = firstName ? `*${firstName}*, sua` : 'Sua';
  return `🎉 *Pagamento confirmado! Bem-vindo ao Scout X!*

${greeting} assinatura está ativa. Agora você tem acesso completo a:
✅ Análises ilimitadas via IA
✅ Cobertura de 7+ esportes
✅ Value bets diários
✅ Suporte 24/7

Me faça qualquer pergunta sobre esportes ou apostas! ⚽🏀🎾🥊

_Digite /ajuda para ver os comandos disponíveis._`;
}

// Raw body required for Stripe signature verification
router.post('/', async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string;

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err: any) {
    console.error('Stripe webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`🔔 Stripe event: ${event.type}`);

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const customerId = session.customer as string;
        const subscriptionId = session.subscription as string;

        // Get phone: prefer metadata, fall back to customer_details (collected at checkout)
        const rawPhone =
          session.metadata?.phone ||
          session.customer_details?.phone ||
          null;

        // Get name: prefer metadata, fall back to customer_details
        const name =
          session.metadata?.name ||
          session.customer_details?.name ||
          null;

        if (!rawPhone) {
          console.warn('checkout.session.completed: no phone found — trying stripe_customer_id fallback');
          const existingUser = await getUserByStripeCustomerId(customerId);
          if (!existingUser) {
            console.warn('No user found for customer:', customerId);
            break;
          }
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          await upsertSubscription(
            existingUser.id, subscriptionId, customerId, 'active',
            subscription.items.data[0]?.price?.id ?? null,
            new Date(subscription.current_period_start * 1000),
            new Date(subscription.current_period_end * 1000),
            subscription.cancel_at_period_end
          );
          const firstName = existingUser.name?.split(' ')[0] || '';
          await sendWhatsAppMessage(existingUser.phone, buildWelcomeMessage(firstName));
          break;
        }

        const phone = normalizePhone(rawPhone);

        // Create or update user
        let user = await queryOne<User>(`SELECT * FROM users WHERE phone = $1`, [phone]);
        if (!user) {
          user = await queryOne<User>(
            `INSERT INTO users (phone, name, stripe_customer_id) VALUES ($1, $2, $3) RETURNING *`,
            [phone, name || null, customerId]
          );
        } else {
          await query(
            `UPDATE users SET stripe_customer_id = $1, name = COALESCE($2, name), updated_at = NOW() WHERE id = $3`,
            [customerId, name || null, user.id]
          );
        }

        // Activate subscription
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        await upsertSubscription(
          user!.id, subscriptionId, customerId, 'active',
          subscription.items.data[0]?.price?.id ?? null,
          new Date(subscription.current_period_start * 1000),
          new Date(subscription.current_period_end * 1000),
          subscription.cancel_at_period_end
        );

        // Personalized welcome
        const firstName = (name || user!.name || '').split(' ')[0];
        await sendWhatsAppMessage(phone, buildWelcomeMessage(firstName));

        console.log(`✅ New subscriber: ${phone} (customer: ${customerId}, name: ${name})`);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = subscription.customer as string;
        const user = await getUserByStripeCustomerId(customerId);

        await query(
          `UPDATE subscriptions SET status = 'canceled', updated_at = NOW() WHERE stripe_subscription_id = $1`,
          [subscription.id]
        );

        if (user) {
          const firstName = user.name?.split(' ')[0] || '';
          await sendWhatsAppMessage(user.phone, `😔 ${firstName ? `*${firstName}*, sua` : 'Sua'} assinatura do Scout X foi *cancelada*.

Esperamos que tenha gostado! Se mudar de ideia, pode assinar novamente:
https://buy.stripe.com/5kQfZi2yRfAoeTT0Kq7ss05

Obrigado por ter sido nosso assinante! 🙏`);
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice;
        if (invoice.billing_reason === 'subscription_cycle') {
          const customerId = invoice.customer as string;
          const subscriptionId = invoice.subscription as string;
          const user = await getUserByStripeCustomerId(customerId);

          await query(
            `UPDATE subscriptions SET status = 'active', updated_at = NOW() WHERE stripe_subscription_id = $1`,
            [subscriptionId]
          );

          if (user) {
            const firstName = user.name?.split(' ')[0] || '';
            await sendWhatsAppMessage(user.phone, `✅ ${firstName ? `*${firstName}*, r` : 'R'}enovação confirmada! Sua assinatura Scout X está ativa por mais um mês. ⚽`);
          }
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = invoice.customer as string;
        const subscriptionId = invoice.subscription as string;
        const user = await getUserByStripeCustomerId(customerId);

        await query(
          `UPDATE subscriptions SET status = 'past_due', updated_at = NOW() WHERE stripe_subscription_id = $1`,
          [subscriptionId]
        );

        if (user) {
          await sendWhatsAppMessage(user.phone, `⚠️ *Falha no pagamento* da sua assinatura Scout X.

Por favor, atualize seu método de pagamento para continuar tendo acesso às análises.

💳 Atualizar pagamento: https://billing.stripe.com/p/login/scoutx

Se precisar de ajuda, responda esta mensagem.`);
        }
        break;
      }

      default:
        console.log(`Unhandled Stripe event: ${event.type}`);
    }
  } catch (err) {
    console.error(`Error handling Stripe event ${event.type}:`, err);
  }

  res.status(200).json({ received: true });
});

export default router;
