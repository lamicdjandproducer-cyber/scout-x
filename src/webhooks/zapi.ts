import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { checkSubscriptionAndNotify, getOrCreateUser } from '../middleware/subscription';
import { runAgent, runAgentWithImage, transcribeAudio, clearConversationHistory } from '../services/agent';
import { sendWhatsAppMessage, sendTyping } from '../services/zapi';
import { query, queryOne } from '../db';

const router = Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16',
});

interface ZAPIMessage {
  instanceId?: string;
  messageId?: string;
  phone?: string;
  fromMe?: boolean;
  momment?: number;
  status?: string;
  chatName?: string;
  senderPhoto?: string;
  senderName?: string;
  participantPhone?: string | null;
  photo?: string;
  broadcast?: boolean;
  referenceMessageId?: string | null;
  forwarded?: boolean;
  type?: string;
  text?: {
    message?: string;
  };
  image?: { imageUrl?: string; caption?: string; mimeType?: string };
  audio?: { audioUrl?: string; mimeType?: string };
  document?: { fileName?: string };
  isGroup?: boolean;
  isStatusReply?: boolean;
  isNewsletter?: boolean;
}

const COMMANDS: Record<string, string> = {
  '/limpar': 'clear_history',
  '/clear': 'clear_history',
  '/start': 'start',
  '/ajuda': 'help',
  '/help': 'help',
  '/status': 'status',
  '/cancelar': 'cancel',
  '/cancel': 'cancel',
};

// In-memory map for pending cancellation confirmations (phone -> expires at ms)
const pendingCancellations = new Map<string, number>();
const CANCEL_TTL_MS = 5 * 60 * 1000; // 5 minutes to confirm

function hasPendingCancellation(phone: string): boolean {
  const expiresAt = pendingCancellations.get(phone);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    pendingCancellations.delete(phone);
    return false;
  }
  return true;
}

async function handleCancelConfirm(phone: string): Promise<void> {
  pendingCancellations.delete(phone);

  const user = await queryOne<{ id: string; stripe_customer_id: string | null }>(
    `SELECT id, stripe_customer_id FROM users WHERE phone = $1`, [phone]
  );

  if (!user) {
    await sendWhatsAppMessage(phone, '❌ Não encontrei sua conta. Entre em contato com o suporte.');
    return;
  }

  const sub = await queryOne<{ stripe_subscription_id: string; current_period_end: Date | null }>(
    `SELECT stripe_subscription_id, current_period_end FROM subscriptions
     WHERE user_id = $1 AND status = 'active'
     ORDER BY created_at DESC LIMIT 1`,
    [user.id]
  );

  if (!sub) {
    await sendWhatsAppMessage(phone, '⚠️ Você não tem uma assinatura ativa para cancelar.');
    return;
  }

  try {
    // Cancel at period end — user keeps access until paid period ends
    await stripe.subscriptions.update(sub.stripe_subscription_id, {
      cancel_at_period_end: true,
    });

    await query(
      `UPDATE subscriptions SET cancel_at_period_end = true, updated_at = NOW()
       WHERE stripe_subscription_id = $1`,
      [sub.stripe_subscription_id]
    );

    const accessUntil = sub.current_period_end
      ? new Date(sub.current_period_end).toLocaleDateString('pt-BR')
      : 'fim do período atual';

    await sendWhatsAppMessage(phone,
      `✅ Cancelamento confirmado.\n\nVocê continua com acesso até *${accessUntil}*. Após essa data a assinatura não renova.\n\nSe mudar de ideia, é só assinar novamente:\nhttps://buy.stripe.com/5kQfZi2yRfAoeTT0Kq7ss05\n\nObrigado por ter usado o Scout X! 🙏`
    );
    console.log(`❌ Subscription cancel_at_period_end set for ${phone}: ${sub.stripe_subscription_id}`);
  } catch (err) {
    console.error('Error cancelling subscription:', err);
    await sendWhatsAppMessage(phone, '❌ Erro ao cancelar. Tente novamente ou entre em contato com o suporte.');
  }
}

async function logInboundMessage(phone: string, message: string, messageId?: string): Promise<void> {
  try {
    await query(
      `INSERT INTO whatsapp_logs (phone, direction, message, message_id, status) VALUES ($1, $2, $3, $4, $5)`,
      [phone, 'inbound', message, messageId || null, 'received']
    );
  } catch (err) {
    console.error('Error logging inbound message:', err);
  }
}

async function logOutboundMessage(phone: string, message: string, messageId?: string): Promise<void> {
  try {
    await query(
      `INSERT INTO whatsapp_logs (phone, direction, message, message_id, status) VALUES ($1, $2, $3, $4, $5)`,
      [phone, 'outbound', message, messageId || null, 'sent']
    );
  } catch (err) {
    console.error('Error logging outbound message:', err);
  }
}

router.post('/', async (req: Request, res: Response) => {
  // Acknowledge immediately
  res.status(200).json({ success: true });

  try {
    const body: ZAPIMessage = req.body;

    if (body.fromMe || body.isGroup || body.isStatusReply || body.isNewsletter) return;
    if (body.type !== 'ReceivedCallback') return;

    const isText = !!body.text?.message;
    const isAudio = !!body.audio?.audioUrl;
    const isImage = !!body.image?.imageUrl;
    if (!isText && !isAudio && !isImage) return;

    const phone = body.phone!;
    const senderName = body.senderName || body.chatName;
    const messageId = body.messageId;

    // Determine user message text
    let userMessage = isText ? body.text!.message!.trim() : isAudio ? '[áudio]' : '[imagem]';

    console.log(`📩 ${isAudio ? '🎤' : isImage ? '🖼️' : '💬'} From ${phone}: ${userMessage.substring(0, 50)}`);
    await logInboundMessage(phone, userMessage, messageId);

    const upperMsg = userMessage.toUpperCase();

    // Handle pending cancellation confirmation
    if (hasPendingCancellation(phone)) {
      if (upperMsg === 'SIM' || upperMsg === 'CANCELAR') {
        await handleCancelConfirm(phone);
      } else {
        pendingCancellations.delete(phone);
        await sendWhatsAppMessage(phone, '✅ Cancelamento abortado. Sua assinatura continua ativa!');
      }
      return;
    }

    // Handle commands
    const command = COMMANDS[userMessage.toLowerCase()];

    if (command === 'clear_history') {
      await clearConversationHistory(phone);
      await sendWhatsAppMessage(phone, '🗑️ Histórico de conversa limpo! Pode começar uma nova análise.');
      return;
    }

    if (command === 'help') {
      await sendWhatsAppMessage(phone, `🤖 *Scout X — Comandos*

📝 *Análise*: Envie qualquer pergunta sobre esportes, jogos ou apostas

⚡ *Comandos especiais:*
• /limpar — Limpa o histórico da conversa
• /status — Verifica sua assinatura
• /cancelar — Cancela sua assinatura
• /ajuda — Este menu

💡 *Exemplos:*
• "Analisa Flamengo x Palmeiras"
• "Tem value bet hoje no Brasileirão?"
• "Como está a forma do Real Madrid?"
• "Quais as odds do Corinthians?"`);
      return;
    }

    if (command === 'start') {
      const { user, hasAccess } = await checkSubscriptionAndNotify(phone, senderName);
      if (hasAccess) {
        await sendWhatsAppMessage(phone, `🏆 Bem-vindo de volta ao *Scout X*!\n\nSua assinatura está ativa. Me pergunte sobre qualquer partida ou esporte! ⚽🏀🎾`);
      }
      return;
    }

    if (command === 'status') {
      const { user, hasAccess } = await checkSubscriptionAndNotify(phone, senderName);
      if (hasAccess) {
        const sub = await queryOne<{ current_period_end: Date | null; cancel_at_period_end: boolean }>(
          `SELECT current_period_end, cancel_at_period_end FROM subscriptions
           WHERE user_id = $1 AND status = 'active'
           ORDER BY created_at DESC LIMIT 1`,
          [user.id]
        );
        const until = sub?.current_period_end
          ? new Date(sub.current_period_end).toLocaleDateString('pt-BR')
          : '—';
        const note = sub?.cancel_at_period_end
          ? `\n⚠️ Cancelamento agendado. Acesso até ${until}.`
          : `\n📅 Próxima renovação: ${until}`;
        await sendWhatsAppMessage(phone, `✅ Sua assinatura está *ativa*.${note}`);
      }
      return;
    }

    if (command === 'cancel') {
      const { user, hasAccess } = await checkSubscriptionAndNotify(phone, senderName);
      if (!hasAccess) return;

      const sub = await queryOne<{ current_period_end: Date | null }>(
        `SELECT current_period_end FROM subscriptions
         WHERE user_id = $1 AND status = 'active'
         ORDER BY created_at DESC LIMIT 1`,
        [user.id]
      );

      const until = sub?.current_period_end
        ? new Date(sub.current_period_end).toLocaleDateString('pt-BR')
        : 'fim do período atual';

      pendingCancellations.set(phone, Date.now() + CANCEL_TTL_MS);

      await sendWhatsAppMessage(phone,
        `⚠️ *Cancelar assinatura Scout X?*\n\nVocê ainda terá acesso até *${until}* — sem cobranças após essa data.\n\nDigite *SIM* para confirmar.\nQualquer outra mensagem irá abortar o cancelamento.`
      );
      return;
    }

    // Subscription gate for regular messages
    const { user, hasAccess } = await checkSubscriptionAndNotify(phone, senderName);
    if (!hasAccess) return;

    await sendTyping(phone);

    // Handle audio: transcribe then run agent
    if (isAudio && body.audio?.audioUrl) {
      try {
        const transcript = await transcribeAudio(body.audio.audioUrl);
        console.log(`🎤 Transcribed: ${transcript.substring(0, 60)}`);
        await sendWhatsAppMessage(phone, `_🎤 Ouvi:_ "${transcript}"\n\nAnalisando...`);
        const response = await runAgent(phone, transcript, user.id);
        const result = await sendWhatsAppMessage(phone, response);
        await logOutboundMessage(phone, response, result?.messageId);
      } catch (err) {
        console.error('Audio transcription error:', err);
        await sendWhatsAppMessage(phone, '❌ Não consegui transcrever o áudio. Tente enviar como texto.');
      }
      return;
    }

    // Handle image: GPT-4o Vision
    if (isImage && body.image?.imageUrl) {
      try {
        const response = await runAgentWithImage(phone, body.image.imageUrl, body.image.caption || '', user.id);
        const result = await sendWhatsAppMessage(phone, response);
        await logOutboundMessage(phone, response, result?.messageId);
      } catch (err) {
        console.error('Image analysis error:', err);
        await sendWhatsAppMessage(phone, '❌ Não consegui analisar a imagem. Tente enviar uma foto mais clara.');
      }
      return;
    }

    // Handle text
    try {
      const response = await runAgent(phone, userMessage, user.id);
      const result = await sendWhatsAppMessage(phone, response);
      await logOutboundMessage(phone, response, result?.messageId);
    } catch (agentErr: any) {
      console.error('❌ Text agent error:', agentErr);
      const isQuota = agentErr?.status === 429 || agentErr?.code === 'insufficient_quota';
      await sendWhatsAppMessage(phone, isQuota
        ? '⚠️ IA indisponível. Tente novamente em minutos.'
        : '❌ Erro ao processar. Tente novamente.');
    }

  } catch (err) {
    console.error('❌ Webhook error:', err);
  }
});

export default router;
