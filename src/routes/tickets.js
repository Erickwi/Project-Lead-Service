const express = require('express');
const router  = express.Router();
const { fetchJiraIssues, fetchIssueChangelog, adfToText } = require('../config/jira');
const pool = require('../config/db');
const logger = require('../lib/logger');

const PRIORITY_ORDER = { Highest: 0, High: 1, Medium: 2, Low: 3, Lowest: 4 };

/**
 * Mapea un issue de Jira + fila de MySQL a un objeto enriquecido.
 */
function mapIssue(issue, infoMap) {
  const f    = issue.fields;
  const info = infoMap[issue.key] || {};

  const comments    = f.comment?.comments || [];
  const fechaFin    = f.customfield_10037 || null;
  const resolutionDate = f.resolutiondate || null;
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
    resolutionDate,
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
    logger.error('[GET /api/tickets]', err.message);
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
    logger.error('[GET /api/tickets/done]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Detecta tickets que estuvieron en `fromSprintName` vía changelog de cada issue.
 */
async function findMovedTickets(issues, fromSprintName, infoMap) {
  const fromLower = fromSprintName.toLowerCase();
  const results = await Promise.allSettled(
    issues.map(async (issue) => {
      try {
        const histories = await fetchIssueChangelog(issue.key);
        const wasMoved = histories.some(h =>
          h.items?.some(item =>
            item.field === 'Sprint' &&
            typeof item.fromString === 'string' &&
            item.fromString.toLowerCase().includes(fromLower)
          )
        );
        return wasMoved ? issue : null;
      } catch { return null; }
    })
  );
  return results
    .filter(r => r.status === 'fulfilled' && r.value !== null)
    .map(r => mapIssue(r.value, infoMap));
}

router.get('/sprint-frederick', async (req, res) => {
  try {
    const sprintName = process.env.JIRA_SPRINT_FREDERICK || 'Desarrollos pasantía Frederick';
    const jql = process.env.JIRA_JQL_FREDERICK ||
      `project = 'Ecomex 360' AND sprint = "${sprintName}" ORDER BY priority ASC`;

    const [jiraIssues, dbResult] = await Promise.all([
      fetchJiraIssues(jql),
      pool.query('SELECT * FROM tickets_info'),
    ]);
    const [dbRows] = dbResult;
    const infoMap = Object.fromEntries(dbRows.map(r => [r.ticket_key, r]));
    const tickets = jiraIssues.map(issue => mapIssue(issue, infoMap));

    const DONE_RE = /done|cerrado|finalizado|completado/i;
    const total    = tickets.length;
    const finished = tickets.filter(t => DONE_RE.test(t.status || '')).length;

    const byStatus = {};
    for (const t of tickets) {
      const s = t.status || 'Sin estado';
      byStatus[s] = (byStatus[s] || 0) + 1;
    }

    res.json({ tickets, total, finished, byStatus, sprintName });
  } catch (err) {
    logger.error('[GET /api/tickets/sprint-frederick]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tickets/sprint-analysis — tickets movidos de 3.10.7 a stable + finalizados por versión
router.get('/sprint-analysis', async (req, res) => {
  try {
    const jqlDone306   = process.env.JIRA_JQL_DONE_306;
    const jqlDone307   = process.env.JIRA_JQL_DONE_307;
    const fromSprint   = process.env.JIRA_SPRINT_FROM || 'Versión 3.10.7';
    const jqlStableAll = process.env.JIRA_JQL_STABLE_ALL ||
      `project = 'Ecomex 360' AND sprint = "Versión 3.10.6.1 stable" ORDER BY priority ASC`;

    const [[dbRows]] = await Promise.all([pool.query('SELECT * FROM tickets_info')]);
    const infoMap = Object.fromEntries(dbRows.map(r => [r.ticket_key, r]));

    const safeJql = async (jql, label) => {
      if (!jql) return [];
      try {
        return await fetchJiraIssues(jql);
      } catch (err) {
        const detail = err.response?.data?.errorMessages || err.response?.data?.errors || err.message;
        logger.error(`[sprint-analysis][${label}] Error:`, JSON.stringify(detail));
        return { error: typeof detail === 'string' ? detail : JSON.stringify(detail) };
      }
    };

    const [stableAllResult, done306Result, done307Result] = await Promise.all([
      safeJql(jqlStableAll, 'STABLE_ALL'),
      safeJql(jqlDone306,   'DONE_306'),
      safeJql(jqlDone307,   'DONE_307'),
    ]);

    // Deduplicate issues by key in case JQLs overlap or sprint names changed.
    function uniqueIssues(list) {
      if (!Array.isArray(list)) return list;
      const seen = new Set();
      const out = [];
      for (const it of list) {
        const k = it?.key;
        if (!k) continue;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(it);
      }
      return out;
    }

    const stableAllDedup = Array.isArray(stableAllResult) ? uniqueIssues(stableAllResult) : stableAllResult;
    const done306Mapped = Array.isArray(done306Result) ? uniqueIssues(done306Result) : done306Result;
    const done307Mapped = Array.isArray(done307Result) ? uniqueIssues(done307Result) : done307Result;

    // Detectar movidos via changelog (todos los de stable que alguna vez estuvieron en fromSprint)
    let movedTickets = [];
    let movedError   = null;
    if (Array.isArray(stableAllDedup) && stableAllDedup.length > 0) {
      try {
        movedTickets = await findMovedTickets(stableAllDedup, fromSprint, infoMap);
      } catch (err) {
        movedError = err.message;
        logger.error('[sprint-analysis][MOVED changelog]', err.message);
      }
    } else if (!Array.isArray(stableAllResult)) {
      movedError = stableAllResult.error;
    }

    // Enriquecer los tickets finalizados con la fecha del cambio a Done (según changelog)
    async function enrichDoneList(list) {
      if (!Array.isArray(list)) return [];
      const enriched = await Promise.allSettled(list.map(async (issue) => {
        try {
          const mapped = mapIssue(issue, infoMap);
          const histories = await fetchIssueChangelog(issue.key);
          // Buscar la última entrada donde se cambió el campo 'status'
          const statusChanges = [];
          for (const h of histories) {
            const created = h.created;
            for (const item of h.items || []) {
              if (item.field === 'status') {
                statusChanges.push({ created, from: item.fromString, to: item.toString });
              }
            }
          }
          // Tomar la última (más reciente)
          if (statusChanges.length > 0) {
            const last = statusChanges[statusChanges.length - 1];
            mapped.doneChange = last;
            mapped.doneDate = last.created;
          } else {
            // Si no hay cambios de status en el changelog, usar la fecha de resolución si está disponible
            mapped.doneChange = null;
            mapped.doneDate = mapped.resolutionDate || null;
          }
          return mapped;
        } catch (err) {
          logger.error('[sprint-analysis][enrichDoneList] Error for', issue.key, err.message);
          return mapIssue(issue, infoMap);
        }
      }));
      return enriched.filter(r => r.status === 'fulfilled').map(r => r.value);
    }

    let [done306Enriched, done307Enriched] = await Promise.all([
      enrichDoneList(done306Mapped),
      enrichDoneList(done307Mapped),
    ]);

    // Remove duplicates between the two done lists (by ticket key).
    // Prefer entries in done306Enriched; filter them out of done307Enriched.
    try {
      const done306Keys = new Set(done306Enriched.map(t => t.key));
      done307Enriched = done307Enriched.filter(t => !done306Keys.has(t.key));
    } catch (e) {
      logger.warn('[sprint-analysis] Error deduplicating done lists:', e.message);
    }

    // Infer readable titles for the two groups based on sprint names or JQL
    function inferTitleFromList(list, envJql, defaultLabel) {
      try {
        if (Array.isArray(list) && list.length > 0) {
          const counts = {};
          for (const t of list) {
            const s = t.sprint || null;
            if (!s) continue;
            counts[s] = (counts[s] || 0) + 1;
          }
          const entries = Object.entries(counts);
          if (entries.length > 0) {
            entries.sort((a,b) => b[1] - a[1]);
            return `Finalizados — ${entries[0][0]}`;
          }
        }
        if (envJql && typeof envJql === 'string') {
          const m = envJql.match(/sprint\s*=\s*["']([^"']+)["']/i);
          if (m && m[1]) return `Finalizados — ${m[1]}`;
        }
      } catch (e) {
        logger.warn('Error inferring title:', e.message);
      }
      return defaultLabel;
    }

    const done306Title = inferTitleFromList(done306Enriched, jqlDone306, 'Finalizados — 3.10.6 Stable');
    const done307Title = inferTitleFromList(done307Enriched, jqlDone307, 'Finalizados — 3.10.7');

    // Agrupar por fecha (YYYY-MM-DD) usando doneDate
    function groupByDate(list) {
      const groups = {};
      for (const t of list) {
        const d = t.doneDate ? (new Date(t.doneDate)).toISOString().slice(0,10) : 'Sin fecha';
        if (!groups[d]) groups[d] = [];
        groups[d].push(t);
      }
      // Convertir a array ordenado por fecha descendente
      return Object.entries(groups)
        .map(([date, items]) => ({ date, items }))
        .sort((a,b) => b.date.localeCompare(a.date));
    }

    const done306Grouped = groupByDate(done306Enriched);
    const done307Grouped = groupByDate(done307Enriched);

    res.json({
      movedTickets,
      done306: done306Enriched,
      done307: done307Enriched,
      done306Title,
      done307Title,
      done306Grouped,
      done307Grouped,
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
    logger.error('[GET /api/tickets/sprint-analysis]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
