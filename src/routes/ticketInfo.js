const express = require('express');
const router  = express.Router();
const pool    = require('../config/db');

// PUT /api/ticket-info/:key — crear o actualizar datos de un ticket
router.put('/:key', async (req, res) => {
  const { key } = req.params;
  const { cliente_nombre, dia_despliegue, estado_entrega, deploy_status } = req.body;

  if (!/^[A-Z0-9_\-]+$/i.test(key)) {
    return res.status(400).json({ error: 'ticket_key inválido' });
  }

  try {
    await pool.query(
      `INSERT INTO tickets_info (ticket_key, cliente_nombre, dia_despliegue, estado_entrega, deploy_status)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         cliente_nombre = VALUES(cliente_nombre),
         dia_despliegue = VALUES(dia_despliegue),
         estado_entrega = VALUES(estado_entrega),
         deploy_status  = COALESCE(VALUES(deploy_status), deploy_status)`,
      [key, cliente_nombre || null, dia_despliegue || null, estado_entrega || null, deploy_status || null]
    );
    res.json({ success: true, ticket_key: key });
  } catch (err) {
    console.error('[PUT /api/ticket-info]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/ticket-info/:key/deploy-status — actualizar sólo el estado de despliegue
router.patch('/:key/deploy-status', async (req, res) => {
  const { key } = req.params;
  const { deploy_status } = req.body;

  if (!/^[A-Z0-9_\-]+$/i.test(key)) {
    return res.status(400).json({ error: 'ticket_key inválido' });
  }

  const allowed = [null, 'notificado', 'confirmado'];
  if (!allowed.includes(deploy_status)) {
    return res.status(400).json({ error: 'deploy_status inválido' });
  }

  try {
    await pool.query(
      `INSERT INTO tickets_info (ticket_key, deploy_status)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE deploy_status = VALUES(deploy_status)`,
      [key, deploy_status]
    );
    res.json({ success: true, ticket_key: key, deploy_status });
  } catch (err) {
    console.error('[PATCH /api/ticket-info/deploy-status]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
