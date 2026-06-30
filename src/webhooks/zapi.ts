import { Router, Request, Response } from 'express';
import { checkSubscriptionAndNotify } from '../middleware/subscription';
import { runAgent, clearConversationHistory } from '../services/agent';
import { sendWhatsAppMessage, sendTyping } from '../services/zapi';
import { query } from '../db';

const router = Router();

interface ZAPIMessage {
  instanceId?: string; messageId?: string; phone?: string; fromMe?: boolean;
  momment?: number; status?: string; chatName?: string; senderName?: string;
  participantPhone?: string | null; broadcast?: boolean; forwarded?: boolean;
  type?: string; text?: { message?: string }; isGroup?: boolean;
  isStatusReply?: boolean; isNewsletter?: boolean;
}

const COMMANDS: Record<string, string> = {
  '/limpar': 'clear_history', '/clear': 'clear_history',
  '/start': 'start', '/ajuda': 'help', '/help': 'help', '/status': 'status',
};

async function logMessage(phone: string, direction: string, message: string, messageId?: string): Promise<void> {
  try {
    await query(
      `INSERT INTO whatsapp_logs (phone, direction, message, message_id, status) VALUES ($1, $2, $3, $4, $5)`,
      [phone, direction, message, messageId || null, direction === 'inbound' ? 'received' : 'sent']
    );
  } catch (err) { console.error('Error logging message:', err); }
}

router.post('/', async (req: Request, res: Response) => {
  res.status(200).json({ success: true });
  try {
    const body: ZAPIMessage = req.body;
    if (body.fromMe || body.isGroup || body.isStatusReply || body.isNewsletter) return;
    if (body.type !== 'ReceivedCallback' || !body.text?.message) return;

    const phone = body.phone!;
    const userMessage = body.text.message.trim();
    const senderName = body.senderName || body.chatName;
    const messageId = body.messageId;

    console.log(`Message from ${phone}: ${userMessage.substring(0, 50)}`);
    await logMessage(phone, 'inbound', userMessage, messageId);

    const command = COMMANDS[userMessage.toLowerCase()];

    if (command === 'clear_history') {
      await clearConversationHistory(phone);
      await sendWhatsAppMessage(phone, 'Historico de conversa limpo! Pode comecar uma nova analise.');
      return;
    }
    if (command === 'help') {
      await sendWhatsAppMessage(phone, `*Scout X — Comandos*\n\n/limpar — Limpa o historico\n/status — Verifica assinatura\n/ajuda — Este menu\n\nExemplos:\n"Analisa Flamengo x Palmeiras"\n"Tem value bet hoje no Brasileirao?"`);
      return;
    }
    if (command === 'start') {
      const { hasAccess } = await checkSubscriptionAndNotify(phone, senderName);
      if (hasAccess) await sendWhatsAppMessage(phone, 'Bem-vindo de volta ao *Scout X*! Sua assinatura esta ativa. Me pergunte sobre qualquer partida ou esporte!');
      return;
    }
    if (command === 'status') {
      const { hasAccess } = await checkSubscriptionAndNotify(phone, senderName);
      if (hasAccess) await sendWhatsAppMessage(phone, 'Sua assinatura esta *ativa*. Voce tem acesso completo ao Scout X!');
      return;
    }

    const { user, hasAccess } = await checkSubscriptionAndNotify(phone, senderName);
    if (!hasAccess) return;

    await sendTyping(phone);
    const response = await runAgent(phone, userMessage, user.id);
    const result = await sendWhatsAppMessage(phone, response);
    await logMessage(phone, 'outbound', response, result?.messageId);
  } catch (err) { console.error('Error processing WhatsApp webhook:', err); }
});

export default router;
