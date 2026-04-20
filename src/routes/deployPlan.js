const express = require('express');
const router  = express.Router();
const pool    = require('../config/db');
const { fetchJiraIssues } = require('../config/jira');

// GET /api/deploy-plan
// Devuelve: { plan: { [cliente]: { [fecha]: [ticket] } } }
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT ticket_key, cliente_nombre, dia_despliegue, estado_entrega, deploy_status
       FROM tickets_info
       WHERE cliente_nombre IS NOT NULL AND cliente_nombre != ''`
    );

    if (rows.length === 0) return res.json({ plan: {} });

    const keys = rows.map(r => `"${r.ticket_key}"`).join(',');
    const jiraIssues = await fetchJiraIssues(`key in (${keys})`);
    const issueMap   = Object.fromEntries(jiraIssues.map(i => [i.key, i.fields]));

    // Agrupar: cliente → fecha → [tickets]
    const plan = {};
    for (const row of rows) {
      const f = issueMap[row.ticket_key] || {};
      // Normalize fecha to YYYY-MM-DD string for consistent grouping.
      // Prefer explicit `dia_despliegue` from DB, otherwise fall back to Jira `duedate`.
      const sourceDate = row.dia_despliegue || f.duedate;
      const fechaKey = sourceDate ? new Date(sourceDate).toISOString().split('T')[0] : 'Sin fecha';
      const ticket = {
        key:            row.ticket_key,
        summary:        f.summary        || '(sin datos Jira)',
        status:         f.status?.name   || '',
        assignee:       f.assignee?.displayName || 'N/A',
        dia_despliegue: fechaKey,
        jira_duedate: f.duedate || null,
        estado_entrega: row.estado_entrega,
        deploy_status:  row.deploy_status,
        cliente_nombre: row.cliente_nombre,
      };

      if (!plan[row.cliente_nombre]) plan[row.cliente_nombre] = {};
      if (!plan[row.cliente_nombre][fechaKey]) plan[row.cliente_nombre][fechaKey] = [];
      plan[row.cliente_nombre][fechaKey].push(ticket);
    }

    // Ordenar fechas cronológicamente dentro de cada cliente
    for (const cliente of Object.keys(plan)) {
      const sorted = {};
      Object.keys(plan[cliente])
        .sort((a, b) => {
          if (a === 'Sin fecha') return 1;
          if (b === 'Sin fecha') return -1;
          return new Date(a) - new Date(b);
        })
        .forEach(f => { sorted[f] = plan[cliente][f]; });
      plan[cliente] = sorted;
    }

    res.json({ plan });
  } catch (err) {
    console.error('[GET /api/deploy-plan]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
