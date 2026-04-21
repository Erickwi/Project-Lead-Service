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

// Health check
app.get('/api/health', (_req, res) => res.json({ status: 'ok', ts: new Date() }));

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

  const added3 = await safeAddColumn('tickets_info', 'otrasVersiones',
    `ALTER TABLE tickets_info ADD COLUMN otrasVersiones VARCHAR(255)`);
  if (added3) console.log('✅ Migración DB: otrasVersiones');

  const added4 = await safeAddColumn('tickets_info', 'mostrarClienteDespliegue',
    `ALTER TABLE tickets_info ADD COLUMN mostrarClienteDespliegue TINYINT(1) DEFAULT 1`);
  if (added4) console.log('✅ Migración DB: mostrarClienteDespliegue');
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`✅ Backend corriendo en http://localhost:${PORT}`);
  await runMigrations();
});
