require('dotenv').config();
const express = require('express');
const cors = require('cors');
const pool = require('./config/db');

const app = express();

// Soporta CORS_ORIGIN como string simple o lista separada por comas.
const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:5173';
let corsOptions = { origin: corsOrigin };
if (corsOrigin && corsOrigin.includes(',')) {
  const allowed = corsOrigin.split(',').map(s => s.trim()).filter(Boolean);
  corsOptions = {
    origin: function(origin, callback) {
      // permitir llamadas sin origin (postman/server-to-server)
      if (!origin) return callback(null, true);
      if (allowed.indexOf(origin) !== -1) return callback(null, true);
      return callback(new Error('CORS not allowed by server'), false);
    }
  };
}
app.use(cors(corsOptions));
app.use(express.json());

// Rutas
app.use('/api/tickets',      require('./routes/tickets'));
app.use('/api/ticket-info',  require('./routes/ticketInfo'));
app.use('/api/recordatorios', require('./routes/recordatorios'));
app.use('/api/deploy-plan',  require('./routes/deployPlan'));
app.use('/api/reporte',      require('./routes/reporte'));

// Health check
app.get('/api/health', (_req, res) => res.json({ status: 'ok', ts: new Date() }));

// Diagnóstico: devuelve todos los customfields de un issue para identificar IDs
app.get('/api/debug/fields/:issueKey', async (_req, res) => {
  const { jiraClient } = require('./config/jira');
  try {
    const { data } = await jiraClient.get(`/issue/${_req.params.issueKey}`, {
      params: { fields: '*all' },
    });
    const custom = Object.entries(data.fields)
      .filter(([k]) => k.startsWith('customfield_'))
      .map(([k, v]) => ({ id: k, value: v }))
      .filter(({ value }) => value !== null && value !== undefined)
      .sort((a, b) => a.id.localeCompare(b.id));
    res.json({ issueKey: _req.params.issueKey, customFields: custom });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Migración automática: añadir columnas nuevas si no existen
async function safeAddColumn(table, column, sql) {
  try {
    await pool.query(`DESCRIBE ${table}`);
    const [cols] = await pool.query(`DESCRIBE ${table}`);
    if (!cols.some(c => c.Field === column)) {
      await pool.query(sql);
      return true;
    }
  } catch (err) {
    if (!err.message.includes('Duplicate column name')) {
      console.warn(`⚠️ Migración ${column}:`, err.message);
    }
  }
  return false;
}

async function runMigrations() {
  const added1 = await safeAddColumn('tickets_info', 'deploy_status',
    `ALTER TABLE tickets_info ADD COLUMN deploy_status ENUM('notificado','confirmado') NULL`);
  if (added1) console.log('✅ Migración DB: deploy_status');

  const added2 = await safeAddColumn('recordatorios', 'posicion',
    `ALTER TABLE recordatorios ADD COLUMN posicion INT DEFAULT 0`);
  if (added2) console.log('✅ Migración DB: posicion');
  
  const added5 = await safeAddColumn('recordatorios', 'enviado_telegram',
    `ALTER TABLE recordatorios ADD COLUMN enviado_telegram TINYINT(1) DEFAULT 0`);
  if (added5) console.log('✅ Migración DB: enviado_telegram');

  const added6 = await safeAddColumn('recordatorios', 'enviar_telegram',
    `ALTER TABLE recordatorios ADD COLUMN enviar_telegram TINYINT(1) DEFAULT 0`);
  if (added6) console.log('✅ Migración DB: enviar_telegram');

  const added3 = await safeAddColumn('tickets_info', 'otrasVersiones',
    `ALTER TABLE tickets_info ADD COLUMN otrasVersiones VARCHAR(255)`);
  if (added3) console.log('✅ Migración DB: otrasVersiones');

  const added4 = await safeAddColumn('tickets_info', 'mostrarClienteDespliegue',
    `ALTER TABLE tickets_info ADD COLUMN mostrarClienteDespliegue TINYINT(1) DEFAULT 1`);
  if (added4) console.log('✅ Migración DB: mostrarClienteDespliegue');

  // Tabla pausas_version
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pausas_version (
        id                 INT           NOT NULL AUTO_INCREMENT,
        descripcion        TEXT          NOT NULL,
        tipo               ENUM('Interrupcion','Reunion','Bloqueado','Planeacion','Otro') NOT NULL DEFAULT 'Otro',
        responsable        VARCHAR(255),
        fecha_inicio       DATE,
        fecha_fin          DATE,
        ticket_relacionado VARCHAR(50),
        created_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  } catch (err) {
    console.warn('⚠️ Migración pausas_version:', err.message);
  }
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`✅ Backend corriendo en http://localhost:${PORT}`);
  await runMigrations();
  // arrancar job de telegram (si está configurado)
  try {
    const { startCron } = require('./jobs/telegramCron');
    startCron();
    console.log('✓ Telegram cron iniciado (si TELEGRAM_BOT_TOKEN+TELEGRAM_CHAT_ID configurados)');
  } catch (err) {
    console.warn('No se pudo inicializar telegram cron:', err.message);
  }
});
