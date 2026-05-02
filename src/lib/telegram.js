const axios = require('axios');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const BASE_URL = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;

async function sendMessage(chatId, text) {
  if (!BASE_URL) throw new Error('TELEGRAM_BOT_TOKEN not configured');
  // Use HTML parse mode to allow richer formatting (bold, italics, links)
  return axios.post(`${BASE_URL}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

async function broadcastMessage(chatIds, text) {
  if (!Array.isArray(chatIds) || chatIds.length === 0) {
    throw new Error('No chatIds provided');
  }
  const results = [];
  for (const id of chatIds) {
    try {
      // best-effort
      const res = await sendMessage(id, text);
      results.push({ chatId: id, ok: true, data: res.data });
    } catch (err) {
      results.push({ chatId: id, ok: false, error: err.message });
    }
  }
  return results;
}

module.exports = { sendMessage, broadcastMessage };
