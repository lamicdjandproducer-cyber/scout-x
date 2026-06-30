import express from 'express';
import { initDB } from './db';
import zapiWebhook from './webhooks/zapi';
import stripeWebhook from './webhooks/stripe';
import { startDailyScanner } from './services/scanner';
import { getInstanceStatus } from './services/zapi';

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// ─── Stripe webhook needs raw body BEFORE express.json() ───────────────────
app.use('/webhook/stripe', express.raw({ type: 'application/json' }));

// ─── General JSON parsing ───────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Health check ───────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'scout-x',
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
  });
});

// ─── Routes ─────────────────────────────────────────────────────────────────
app.use('/webhook/whatsapp', zapiWebhook);
app.use('/webhook/stripe', stripeWebhook);

// ─── Root ───────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({
    name: 'Scout X',
    description: 'Sports Betting AI Platform via WhatsApp',
    version: '1.0.0',
    status: 'running',
  });
});

// ─── 404 ────────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ─── Error handler ──────────────────────────────────────────────────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Start ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 Starting Scout X...');

  try {
    await initDB();
  } catch (err) {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  }

  app.listen(PORT, '0.0.0.0', async () => {
    console.log(`✅ Scout X running on port ${PORT}`);
    console.log(`📡 WhatsApp webhook: POST /webhook/whatsapp`);
    console.log(`💳 Stripe webhook:   POST /webhook/stripe`);
    console.log(`❤️  Health check:    GET  /health`);

    const zapiStatus = await getInstanceStatus();
    if (zapiStatus) {
      console.log(`📱 Z-API status: ${zapiStatus.connected ? '✅ Connected' : '⚠️ Disconnected'}`);
    }

    startDailyScanner();
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

export default app;
