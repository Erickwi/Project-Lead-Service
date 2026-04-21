const express = require('express');
const router  = express.Router();
const { fetchJiraIssues, adfToText } = require('../config/jira');
const pool = require('../config/db');

const PRIORITY_ORDER = { Highest: 0, High: 1, Medium: 2, Low: 3, Lowest: 4 };

/**
 * Mapea un issue de Jira + fila de MySQL a un objeto enriquecido.
 */
function mapIssue(issue, infoMap) {
  const f    = issue.fields;
  const info = infoMap[issue.key] || {};

  const comments    = f.comment?.comments || [];
  const fechaFin    = f.customfield_10037 || null;
  const hoy         = new Date();
  const esUrgente   = fechaFin
    ? Math.ceil((new Date(fechaFin) - hoy) / (1000 * 60 * 60 * 24)) <= 1
    : false;

  return {
    key:           issue.key,
    summary:       f.summary || 'Sin título',
    status:        f.status?.name || 'Sin Estado',
    priority:      f.priority?.name || 'Medium',
    priorityOrder: PRIORITY_ORDER[f.priority?.name] ?? 99,
    assignee:      f.assignee?.displayName || '⚠️ SIN ASIGNAR',
    horas:         f.timeoriginalestimate ? f.timeoriginalestimate / 3600 : 16,
    fechaFin,
    esUrgente,
    revInterno:    f.customfield_10083?.[0]?.displayName || 'N/A',
    revOperativo:  f.customfield_10115?.[0]?.displayName || 'N/A',
    numComentarios: comments.length,
    comentarios: comments.slice(-3).reverse().map(c => ({
      autor: c.author?.displayName || 'Desconocido',
      texto: typeof c.body === 'string' ? c.body : adfToText(c.body),
      fecha: c.created,
    })),
    // Datos enriquecidos desde MySQL
    cliente_nombre: info.cliente_nombre  || null,
    dia_despliegue: info.dia_despliegue  || null,
    estado_entrega: info.estado_entrega  || null,
    deploy_status:  info.deploy_status   || null,
    otrasVersiones: info.otrasVersiones || null,
    mostrarClienteDespliegue: info.mostrarClienteDespliegue == 1,
  };
}

// GET /api/tickets — tickets activos del sprint (statusCategory != Done)
router.get('/', async (req, res) => {
  try {
    const jql = process.env.JIRA_JQL;
    if (!jql) return res.status(500).json({ error: 'JIRA_JQL no configurado en .env' });

    const [jiraIssues, dbResult] = await Promise.all([
      fetchJiraIssues(jql),
      pool.query('SELECT * FROM tickets_info'),
    ]);
    const [dbRows] = dbResult;

    const infoMap = Object.fromEntries(dbRows.map(r => [r.ticket_key, r]));
    const tickets = jiraIssues.map(issue => mapIssue(issue, infoMap));

    res.json({ tickets });
  } catch (err) {
    console.error('[GET /api/tickets]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tickets/done — tickets finalizados (para Release Notes)
router.get('/done', async (req, res) => {
  try {
    const jql = process.env.JIRA_JQL_DONE;
    if (!jql) return res.status(500).json({ error: 'JIRA_JQL_DONE no configurado en .env' });

    const [jiraIssues, dbResult] = await Promise.all([
      fetchJiraIssues(jql),
      pool.query('SELECT * FROM tickets_info'),
    ]);
    const [dbRows] = dbResult;

    const infoMap = Object.fromEntries(dbRows.map(r => [r.ticket_key, r]));
    const tickets = jiraIssues.map(issue => mapIssue(issue, infoMap));

    res.json({ tickets });
  } catch (err) {
    console.error('[GET /api/tickets/done]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
