require('dotenv').config();
const pool = require('./src/config/db');
const logger = require('./src/lib/logger');

async function migrate() {
  try {
    logger.info('🔄 Ejecutando migraciones...');
    
    // Check if column exists
    const [cols] = await pool.query('DESCRIBE recordatorios');
    const hasPosicion = cols.some(c => c.Field === 'posicion');
    
    if (!hasPosicion) {
      await pool.query('ALTER TABLE recordatorios ADD COLUMN posicion INT DEFAULT 0');
      logger.info('✓ Columna posicion agregada a recordatorios');
    } else {
      logger.info('ℹ Columna posicion ya existe');
    }

    const [cols2] = await pool.query('DESCRIBE tickets_info');
    const hasOtrasVersiones = cols2.some(c => c.Field === 'otrasVersiones');
    
    if (!hasOtrasVersiones) {
      await pool.query('ALTER TABLE tickets_info ADD COLUMN otrasVersiones VARCHAR(255)');
      logger.info('✓ Columna otrasVersiones agregada a tickets_info');
    } else {
      logger.info('ℹ Columna otrasVersiones ya existe');
    }

    const hasMostrar = cols2.some(c => c.Field === 'mostrarClienteDespliegue');
    
    if (!hasMostrar) {
      await pool.query('ALTER TABLE tickets_info ADD COLUMN mostrarClienteDespliegue TINYINT(1) DEFAULT 1');
      logger.info('✓ Columna mostrarClienteDespliegue agregada a tickets_info');
    } else {
      logger.info('ℹ Columna mostrarClienteDespliegue ya existe');
    }

    logger.info('✅ Migraciones completadas');
    process.exit(0);
  } catch (err) {
    logger.error('❌ Error:', err.message);
    process.exit(1);
  } finally {
    pool.end();
  }
}

migrate();