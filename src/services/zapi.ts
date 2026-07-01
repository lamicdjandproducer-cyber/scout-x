import axios from 'axios';

const ZAPI_BASE_URL = `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE_ID}/token/${process.env.ZAPI_TOKEN}`;
const CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;

interface SendTextResponse {
  zaapId: string;
  messageId: string;
  id: string;
}

export async function sendWhatsAppMessage(phone: string, message: string): Promise<SendTextResponse | null> {
  try {
    const normalizedPhone = phone.replace(/\D/g, '');
    const response = await axios.post<SendTextResponse>(
      `${ZAPI_BASE_URL}/send-text`,
      { phone: normalizedPhone, message },
      {
        headers: { 'Content-Type': 'application/json', 'Client-Token': CLIENT_TOKEN! },
        timeout: 15000,
      }
    );
    console.log(`Message sent to ${phone}: ${response.data.messageId}`);
    return response.data;
  } catch (err: any) {
    console.error(`Failed to send WhatsApp message to ${phone}:`, err?.response?.data || err.message);
    return null;
  }
}

export async function sendTyping(phone: string): Promise<void> {
  try {
    const normalizedPhone = phone.replace(/\D/g, '');
    await axios.post(
      `${ZAPI_BASE_URL}/send-presence`,
      { phone: normalizedPhone, presence: 'composing' },
      { headers: { 'Content-Type': 'application/json', 'Client-Token': CLIENT_TOKEN! }, timeout: 5000 }
    );
  } catch { /* Non-critical */ }
}

export async function getInstanceStatus(): Promise<any> {
  try {
    const response = await axios.get(`${ZAPI_BASE_URL}/status`, {
      headers: { 'Client-Token': CLIENT_TOKEN! },
      timeout: 5000,
    });
    return response.data;
  } catch (err: any) {
    console.error('Error getting Z-API status:', err?.response?.data || err.message);
    return null;
  }
}

export async function registerWebhook(webhookUrl: string): Promise<boolean> {
  try {
    const response = await axios.put(
      `${ZAPI_BASE_URL}/update-webhook-received`,
      { value: webhookUrl },
      {
        headers: { 'Content-Type': 'application/json', 'Client-Token': CLIENT_TOKEN! },
        timeout: 10000,
      }
    );
    console.log(`✅ Z-API webhook registered: ${webhookUrl}`);
    return response.data?.value === true;
  } catch (err: any) {
    console.error('❌ Failed to register Z-API webhook:', err?.response?.data || err.message);
    return false;
  }
}
