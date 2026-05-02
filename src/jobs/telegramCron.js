const cron = require('node-cron');
const pool = require('../config/db');
const { broadcastMessage } = require('../lib/telegram');

// CHAT IDs can be configured via env var TELEGRAM_CHAT_ID (comma-separated)
const CHAT_IDS = (process.env.TELEGRAM_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean);

async function sendDueReminders() {
  if (!CHAT_IDS.length) return; // nothing configured
  try {
    // Enviar mientras el checkbox `enviar_telegram` esté activo.
    // No marcamos como "enviado" para permitir reenvío hasta que se desmarque.
    const [rows] = await pool.query(`
      SELECT * FROM recordatorios
      WHERE enviar_telegram = 1
    `);
    for (const r of rows) {
      const isDue = r.fecha !== null && new Date(r.fecha) <= new Date();
      const isNote = !r.fecha && Number(r.enviar_telegram) === 1;
      const header = isDue ? '*Recordatorio*' : isNote ? '*Nota*' : '*Recordatorio*';
      const dateText = r.fecha ? `Fecha: ${new Date(r.fecha).toLocaleDateString('es-ES')}` : '';
      const text = `${header}\n${(r.descripcion||'').slice(0,1000)}\n\nPrioridad: ${r.prioridad || 'N/A'}${dateText ? '\n' + dateText : ''}`;
      try {
        await broadcastMessage(CHAT_IDS, text);
      } catch (err) {
        console.error('Error enviando recordatorio id=' + r.id + ':', err.message);
      }
    }
  } catch (err) {
    console.error('Error leyendo recordatorios para Telegram:', err.message);
  }
}

function startCron() {
  // Ejecutar cada 30 minutos; ajustar según necesidad
  cron.schedule('*/30 * * * *', () => {
    sendDueReminders().catch(err => console.error('cron error:', err.message));
  });

  // Ejecutar inmediatamente al arrancar
  sendDueReminders().catch(err => console.error('initial telegram run error:', err.message));
}

module.exports = { startCron };
