import OpenAI from 'openai';
import { query } from '../db';
import { SYSTEM_PROMPT } from '../prompts/system';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MAX_HISTORY = 20;

interface Message { role: 'user' | 'assistant' | 'system'; content: string; }

export async function getConversationHistory(phone: string): Promise<Message[]> {
  const rows = await query<{ role: string; content: string }>(
    `SELECT role, content FROM conversations WHERE phone = $1 ORDER BY created_at DESC LIMIT $2`,
    [phone, MAX_HISTORY]
  );
  return rows.reverse() as Message[];
}

export async function saveMessage(phone: string, userId: string | null, role: 'user' | 'assistant', content: string): Promise<void> {
  await query(
    `INSERT INTO conversations (user_id, phone, role, content) VALUES ($1, $2, $3, $4)`,
    [userId, phone, role, content]
  );
}

export async function runAgent(phone: string, userMessage: string, userId: string | null): Promise<string> {
  await saveMessage(phone, userId, 'user', userMessage);
  const history = await getConversationHistory(phone);

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.map((h) => ({ role: h.role as 'user' | 'assistant', content: h.content })),
  ];

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages,
      max_tokens: 1000,
      temperature: 0.7,
    });

    const assistantMessage = response.choices[0]?.message?.content || 'Desculpe, nao consegui processar sua mensagem.';
    await saveMessage(phone, userId, 'assistant', assistantMessage);
    console.log(`GPT-4o tokens: ${response.usage?.total_tokens}`);
    return assistantMessage;
  } catch (err: any) {
    console.error('OpenAI error:', err?.message || err);
    if (err?.status === 429) return 'Muitas solicitacoes no momento. Aguarde e tente novamente.';
    return 'Ocorreu um erro ao processar sua mensagem. Tente novamente em instantes.';
  }
}

export async function clearConversationHistory(phone: string): Promise<void> {
  await query(`DELETE FROM conversations WHERE phone = $1`, [phone]);
}
