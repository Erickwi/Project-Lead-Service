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
    // helper to escape HTML special chars for Telegram HTML parse_mode
    function escapeHtml(s) {
      if (s == null) return '';
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    for (const r of rows) {
      const isDue = r.fecha !== null && new Date(r.fecha) <= new Date();
      const isNote = !r.fecha && Number(r.enviar_telegram) === 1;
      const headerEmoji = isDue ? '⏰' : isNote ? '📝' : '🔔';

      const prioridad = (r.prioridad || '').toString();
      let prioridadEmoji = '⚪';
      if (/alta|high|urgent/i.test(prioridad)) prioridadEmoji = '🔴';
      else if (/media|medium|normal/i.test(prioridad)) prioridadEmoji = '🟠';
      else if (/baja|low/i.test(prioridad)) prioridadEmoji = '🟢';

      const dateText = r.fecha ? `<b>Fecha:</b> ${escapeHtml(new Date(r.fecha).toLocaleString('es-ES'))}` : '';
      const descripcion = escapeHtml((r.descripcion || '').slice(0, 2000));

      const text = `
${headerEmoji} <b>${isNote ? 'Nota' : 'Recordatorio'}</b>
<i>${descripcion}</i>

<b>Prioridad:</b> ${prioridadEmoji} ${escapeHtml(prioridad || 'N/A')}
${dateText}

— Enviado por Project Lead ⚙️
`;

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
