import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { query, queryOne } from '../db';
import { sendWhatsAppMessage } from '../services/zapi';

const router = Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2023-10-16' });

interface User { id: string; phone: string; name: string | null; }

async function getUserByStripeCustomerId(customerId: string): Promise<User | null> {
  return queryOne<User>(`SELECT u.* FROM users u WHERE u.stripe_customer_id = $1`, [customerId]);
}

async function upsertSubscription(userId: string, stripeSubscriptionId: string, customerId: string, status: string, priceId: string | null, periodStart: Date | null, periodEnd: Date | null, cancelAtPeriodEnd: boolean): Promise<void> {
  await query(
    `INSERT INTO subscriptions (user_id, stripe_subscription_id, stripe_customer_id, status, price_id, current_period_start, current_period_end, cancel_at_period_end)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (stripe_subscription_id) DO UPDATE SET status = EXCLUDED.status, current_period_start = EXCLUDED.current_period_start, current_period_end = EXCLUDED.current_period_end, cancel_at_period_end = EXCLUDED.cancel_at_period_end, updated_at = NOW()`,
    [userId, stripeSubscriptionId, customerId, status, priceId, periodStart, periodEnd, cancelAtPeriodEnd]
  );
}

router.post('/', async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string;
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch (err: any) {
    console.error('Stripe webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`Stripe event: ${event.type}`);
  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const customerId = session.customer as string;
        const subscriptionId = session.subscription as string;

        // Phone comes from customer_details (Payment Link with phone required)
        // or from metadata (custom checkout sessions)
        const phone = session.customer_details?.phone || session.metadata?.phone;
        const name = session.customer_details?.name || session.metadata?.name;

        if (!phone) {
          console.warn('No phone found in session — cannot activate subscription');
          break;
        }

        // Normalize phone: remove non-digits
        const normalizedPhone = phone.replace(/\D/g, '');

        let user = await queryOne<User>(`SELECT * FROM users WHERE phone = $1`, [normalizedPhone]);
        if (!user) {
          user = await queryOne<User>(`INSERT INTO users (phone, name, stripe_customer_id) VALUES ($1, $2, $3) RETURNING *`, [normalizedPhone, name || null, customerId]);
        } else {
          await query(`UPDATE users SET stripe_customer_id = $1, updated_at = NOW() WHERE id = $2`, [customerId, user!.id]);
        }

        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        await upsertSubscription(user!.id, subscriptionId, customerId, 'active', sub.items.data[0]?.price?.id ?? null, new Date(sub.current_period_start * 1000), new Date(sub.current_period_end * 1000), sub.cancel_at_period_end);
        await sendWhatsAppMessage(normalizedPhone, `Pagamento confirmado! Bem-vindo ao Scout X!\n\nSua assinatura esta ativa. Analises ilimitadas, 7+ esportes, value bets diarios.\n\nMe faca qualquer pergunta sobre esportes ou apostas!`);
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const user = await getUserByStripeCustomerId(sub.customer as string);
        await query(`UPDATE subscriptions SET status = 'canceled', updated_at = NOW() WHERE stripe_subscription_id = $1`, [sub.id]);
        if (user) await sendWhatsAppMessage(user.phone, `Sua assinatura do Scout X foi cancelada. Se mudar de ideia, pode assinar novamente a qualquer momento.`);
        break;
      }
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice;
        if (invoice.billing_reason === 'subscription_cycle') {
          const user = await getUserByStripeCustomerId(invoice.customer as string);
          await query(`UPDATE subscriptions SET status = 'active', updated_at = NOW() WHERE stripe_subscription_id = $1`, [invoice.subscription as string]);
          if (user) await sendWhatsAppMessage(user.phone, `Renovacao confirmada! Sua assinatura Scout X esta ativa por mais um mes.`);
        }
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const user = await getUserByStripeCustomerId(invoice.customer as string);
        await query(`UPDATE subscriptions SET status = 'past_due', updated_at = NOW() WHERE stripe_subscription_id = $1`, [invoice.subscription as string]);
        if (user) await sendWhatsAppMessage(user.phone, `Falha no pagamento da sua assinatura Scout X. Por favor, atualize seu metodo de pagamento.`);
        break;
      }
      default: console.log(`Unhandled Stripe event: ${event.type}`);
    }
  } catch (err) { console.error(`Error handling Stripe event ${event.type}:`, err); }

  res.status(200).json({ received: true });
});

export default router;
