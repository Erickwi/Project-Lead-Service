const cron = require('node-cron');
const pool = require('../config/db');
const { broadcastMessage } = require('../lib/telegram');
const logger = require('../lib/logger');

// CHAT IDs can be configured via env var TELEGRAM_CHAT_ID (comma-separated)
const CHAT_IDS = (process.env.TELEGRAM_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean);

// Send window (HH:MM). Can be overridden with env vars if needed.
const SEND_WINDOW_START = process.env.TELEGRAM_SEND_WINDOW_START || '08:30';
const SEND_WINDOW_END = process.env.TELEGRAM_SEND_WINDOW_END || '17:30';
function parseHM(s) {
  if (!s || typeof s !== 'string') return null;
  const parts = s.split(':').map(p => Number(p));
  if (parts.length !== 2 || parts.some(isNaN)) return null;
  return parts[0] * 60 + parts[1];
}
const START_MIN = parseHM(SEND_WINDOW_START);
const END_MIN = parseHM(SEND_WINDOW_END);

async function sendDueReminders() {
  if (!CHAT_IDS.length) return; // nothing configured
  // check send window (local server time)
  try {
    const now = new Date();
    const day = now.getDay(); // 0 = Domingo, 6 = Sábado
    if (day === 0 || day === 6) {
      logger.info(`Fin de semana, no se enviarán recordatorios. Hoy: ${now.toLocaleDateString()}`);
      return;
    }
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    if (START_MIN !== null && END_MIN !== null) {
      // allow sending when START_MIN <= nowMinutes <= END_MIN
      if (nowMinutes < START_MIN || nowMinutes > END_MIN) {
        logger.info(`Fuera de horario de envío (${SEND_WINDOW_START}-${SEND_WINDOW_END}), no se enviarán recordatorios. Ahora: ${now.toLocaleTimeString()}`);
        return;
      }
    }
  } catch (e) {
    logger.warn('Error comprobando horario de envío:', e.message);
    // If we can't determine time, be conservative and don't send.
    return;
  }
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
        logger.info('Recordatorio enviado id=' + r.id);
      } catch (err) {
        logger.error('Error enviando recordatorio id=' + r.id + ':', err.message);
      }
    }
  } catch (err) {
    logger.error('Error leyendo recordatorios para Telegram:', err.message);
  }
}

function startCron() {
  // Ejecutar cada 30 minutos; ajustar según necesidad
  cron.schedule('*/30 * * * *', () => {
    sendDueReminders().catch(err => logger.error('cron error:', err.message));
  });

  // NOTA: no ejecutar `sendDueReminders` inmediatamente al arrancar
  // para evitar reenvíos al reiniciar la aplicación. El cron se encargará
  // de ejecutar periódicamente y `sendDueReminders` internamente verificará
  // la ventana de envío (por defecto 08:30-17:30).
}

module.exports = { startCron };
