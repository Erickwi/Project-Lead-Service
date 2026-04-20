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
async function runMigrations() {
  try {
    await pool.query(`
      ALTER TABLE tickets_info
        ADD COLUMN IF NOT EXISTS deploy_status ENUM('notificado','confirmado') NULL DEFAULT NULL
    `);
    console.log('✅ Migración DB: deploy_status OK');
  } catch (err) {
    // MySQL 5.x no soporta ADD COLUMN IF NOT EXISTS — intentar silencioso
    if (!err.message.includes('Duplicate column')) {
      console.warn('⚠️  Migración deploy_status:', err.message);
    }
  }
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`✅ Backend corriendo en http://localhost:${PORT}`);
  await runMigrations();
});
