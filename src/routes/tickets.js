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
    // Sprint actual
    sprint: (() => {
      const sprints = f.customfield_10020;
      if (!Array.isArray(sprints) || sprints.length === 0) return null;
      const active = sprints.find(s => s.state === 'active');
      return (active || sprints[sprints.length - 1])?.name || null;
    })(),
    // Subtareas y jerarquía
    isSubtask: f.issuetype?.subtask === true,
    parent: f.parent
      ? { key: f.parent.key, summary: f.parent.fields?.summary || '' }
      : null,
    subtasks: (f.subtasks || []).map(s => ({
      key:      s.key,
      summary:  s.fields?.summary || '',
      status:   s.fields?.status?.name || '',
      assignee: s.fields?.assignee?.displayName || null,
    })),
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

/**
 * Detecta tickets que tienen en su historial de sprints (customfield_10020)
 * el sprint `fromSprintName`. No requiere llamadas adicionales a la API.
 */
function findMovedTickets(issues, fromSprintName, infoMap) {
  const fromLower = fromSprintName.toLowerCase();
  return issues
    .filter(issue => {
      const sprints = issue.fields.customfield_10020;
      return Array.isArray(sprints) &&
        sprints.some(s => typeof s.name === 'string' && s.name.toLowerCase().includes(fromLower));
    })
    .map(issue => mapIssue(issue, infoMap));
}

// GET /api/tickets/sprint-analysis — tickets movidos de 3.10.7 a stable + finalizados por versión
router.get('/sprint-analysis', async (req, res) => {
  try {
    const jqlDone306 = process.env.JIRA_JQL_DONE_306;
    const jqlDone307 = process.env.JIRA_JQL_DONE_307;
    const fromSprint = process.env.JIRA_SPRINT_FROM || 'Versión 3.10.7';

    const [[dbRows]] = await Promise.all([pool.query('SELECT * FROM tickets_info')]);
    const infoMap = Object.fromEntries(dbRows.map(r => [r.ticket_key, r]));

    const safeJql = async (jql, label) => {
      if (!jql) return [];
      try {
        return await fetchJiraIssues(jql);
      } catch (err) {
        const detail = err.response?.data?.errorMessages || err.response?.data?.errors || err.message;
        console.error(`[sprint-analysis][${label}] Error:`, JSON.stringify(detail));
        return { error: typeof detail === 'string' ? detail : JSON.stringify(detail) };
      }
    };

    // done306 y done307 en paralelo (sin query extra para STABLE_ALL)
    const [done306Result, done307Result] = await Promise.all([
      safeJql(jqlDone306, 'DONE_306'),
      safeJql(jqlDone307, 'DONE_307'),
    ]);

    // Detectar movidos: tickets de done306 que tienen 3.10.7 en su historial de sprints
    let movedTickets = [];
    let movedError   = null;
    if (Array.isArray(done306Result)) {
      movedTickets = findMovedTickets(done306Result, fromSprint, infoMap);
    } else {
      movedError = done306Result.error;
    }

    res.json({
      movedTickets,
      done306: Array.isArray(done306Result) ? done306Result.map(i => mapIssue(i, infoMap)) : [],
      done307: Array.isArray(done307Result) ? done307Result.map(i => mapIssue(i, infoMap)) : [],
      errors: {
        moved:   movedError,
        done306: Array.isArray(done306Result) ? null : done306Result.error,
        done307: Array.isArray(done307Result) ? null : done307Result.error,
      },
      configured: {
        moved:   true,
        done306: !!jqlDone306,
        done307: !!jqlDone307,
      },
    });
  } catch (err) {
    console.error('[GET /api/tickets/sprint-analysis]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
