const express = require('express');
const router = express.Router();
const { fetchJiraIssues, fetchIssueChangelog, adfToText } = require('../config/jira');
const pool = require('../config/db');

const PRIORITY_ORDER = { Highest: 0, High: 1, Medium: 2, Low: 3, Lowest: 4 };

// Nombres parciales de los desarrolladores reales del proyecto.
// Se usa toLowerCase().includes() para tolerar variaciones de nombre completo.
const DEV_NAME_PATTERNS = ['jerson', 'fabio', 'mateo', 'jairo', 'erick'];

function isDeveloper(displayName) {
  if (!displayName) return false;
  const n = displayName.toLowerCase();
  return DEV_NAME_PATTERNS.some(p => n.includes(p));
}

/**
 * Mapea un issue de Jira a un objeto reducido para el reporte.
 */
function mapIssue(issue, infoMap) {
  const f = issue.fields;
  const info = infoMap[issue.key] || {};

  const fechaFinEstimada  = f.customfield_10037 || null;
  const fechaInicioEst    = f.customfield_10038 || null;
  const fechaInicioReal   = f.customfield_10354 || null;
  const fechaFinReal      = f.customfield_10355 || null;
  const contadorQAInterno   = typeof f.customfield_10388 === 'number' ? f.customfield_10388 : null;
  const contadorQAOperativo = typeof f.customfield_10389 === 'number' ? f.customfield_10389 : 0;

  // Desarrolladores: campo custom (puede ser array de usuarios); fallback a assignee
  let desarrolladores = [];
  if (Array.isArray(f.customfield_10114) && f.customfield_10114.length > 0) {
    desarrolladores = f.customfield_10114.map(u => u.displayName).filter(Boolean);
  } else if (f.assignee?.displayName) {
    desarrolladores = [f.assignee.displayName];
  }

  // Rebotes = contador real de rondas QA interno (sin restar 1)
  const rebotesQAInterno = contadorQAInterno !== null ? Math.max(0, contadorQAInterno) : null;
  // Rebotes total: sumar conteos de QA Interno + QA Operativo para el análisis solicitado
  const rebotesQATotal = (typeof contadorQAInterno === 'number' ? contadorQAInterno : 0) +
    (typeof contadorQAOperativo === 'number' ? contadorQAOperativo : 0);

  // Retraso en días: fin real - fin estimado (positivo = se retrasó)
  let retraso_dias = null;
  if (fechaFinReal && fechaFinEstimada) {
    retraso_dias = Math.round(
      (new Date(fechaFinReal) - new Date(fechaFinEstimada)) / (1000 * 3600 * 24)
    );
  }

  // Duración real en días hábiles aproximada (solo días corridos)
  let duracion_real_dias = null;
  if (fechaInicioReal && fechaFinReal) {
    duracion_real_dias = Math.round(
      (new Date(fechaFinReal) - new Date(fechaInicioReal)) / (1000 * 3600 * 24)
    );
  }

  return {
    key: issue.key,
    summary: f.summary || 'Sin título',
    status: f.status?.name || 'Sin Estado',
    priority: f.priority?.name || 'Medium',
    priorityOrder: PRIORITY_ORDER[f.priority?.name] ?? 99,
    desarrolladores,
    assignee: f.assignee?.displayName || '⚠️ SIN ASIGNAR',
    horas: f.timeoriginalestimate ? Math.round(f.timeoriginalestimate / 3600 * 10) / 10 : 16,
    horasRestantes: f.timeestimate != null ? Math.round(f.timeestimate / 3600 * 10) / 10 : null,
    fechaFinEstimada,
    fechaInicioEst,
    fechaInicioReal,
    fechaFinReal,
    contadorQAInterno,
    rebotesQAInterno,
    retraso_dias,
    duracion_real_dias,
    contadorQAOperativo,
    rebotesQATotal,
    revInterno: f.customfield_10083?.[0]?.displayName || 'N/A',
    revOperativo: f.customfield_10115?.[0]?.displayName || 'N/A',
    cliente_nombre: info.cliente_nombre || null,
    modulo: f.customfield_10526?.value || 'Sin Módulo',
    tipoTicket: f.issuetype?.name || 'Sin Tipo',
    descripcion: f.description ? adfToText(f.description) : null,
  };
}

/**
 * Calcula tiempo en horas que un ticket pasó en cada estado,
 * y cuántas veces regresó de QA a desarrollo (retornos).
 */
function computeTimeline(histories) {
  const statusChanges = [];

  for (const h of (histories || [])) {
    const statusItem = (h.items || []).find(i => i.field === 'status');
    if (statusItem) {
      statusChanges.push({
        fecha: new Date(h.created),
        de: statusItem.fromString || '',
        a: statusItem.toString || '',
      });
    }
  }

  statusChanges.sort((a, b) => a.fecha - b.fecha);

  const tiemposPorEstado = {};
  let retornos = 0;
  const transiciones = [];

  for (let i = 0; i < statusChanges.length; i++) {
    const change = statusChanges[i];
    const hasta =
      i + 1 < statusChanges.length
        ? statusChanges[i + 1].fecha
        : new Date();

    const duracionHoras =
      Math.round(((hasta - change.fecha) / (1000 * 3600)) * 10) / 10;

    tiemposPorEstado[change.a] =
      (tiemposPorEstado[change.a] || 0) + duracionHoras;

    transiciones.push({ de: change.de, a: change.a, fecha: change.fecha.toISOString(), duracionHoras });

    // Retorno: salió de un estado tipo QA hacia un estado tipo desarrollo
    const fromQA = /qa|review|revisar|interno|operativo/i.test(change.de);
    const toDev =
      /desarrollo|progreso|progress|development|doing|in progress|en progreso/i.test(
        change.a
      );
    if (fromQA && toDev) retornos++;
  }

  return { tiemposPorEstado, retornos, transiciones };
}

/**
 * Dado el mapa de tiemposPorEstado, suma las horas de estados de desarrollo.
 */
function sumaDevTime(tiemposPorEstado) {
  return Object.entries(tiemposPorEstado)
    .filter(([s]) =>
      /desarrollo|progreso|progress|development|doing|in progress|en progreso|to do|abierto|backlog/i.test(s)
    )
    .reduce((sum, [, h]) => sum + h, 0);
}

/**
 * Suma las horas de estados tipo QA.
 */
function sumaQATime(tiemposPorEstado) {
  return Object.entries(tiemposPorEstado)
    .filter(([s]) => /qa|review|revisar|interno|operativo/i.test(s))
    .reduce((sum, [, h]) => sum + h, 0);
}

// ─────────────────────────────────────────────────────────────
// GET /api/reporte/datos-basicos
// Datos rápidos: tickets sin changelogs (KPIs, status, QA, modulos)
// ─────────────────────────────────────────────────────────────
router.get('/datos-basicos', async (req, res) => {
  try {
    const jqlActive = process.env.JIRA_JQL;
    const jqlDone = process.env.JIRA_JQL_DONE;
    if (!jqlActive) return res.status(500).json({ error: 'JIRA_JQL no configurado en .env' });
    if (!jqlDone) return res.status(500).json({ error: 'JIRA_JQL_DONE no configurado en .env' });

    const [activeIssues, doneIssues, [dbRows]] = await Promise.all([
      fetchJiraIssues(jqlActive),
      fetchJiraIssues(jqlDone),
      pool.query('SELECT * FROM tickets_info'),
    ]);

    const infoMap = Object.fromEntries(dbRows.map(r => [r.ticket_key, r]));
    const allIssues = [...activeIssues, ...doneIssues];
    const allTickets = allIssues.map(issue => mapIssue(issue, infoMap));

    // Distribución de estados
    const statusCounts = {};
    for (const t of allTickets) {
      statusCounts[t.status] = (statusCounts[t.status] || 0) + 1;
    }

    // QA Breakdown
    const qaBreakdown = { soloInterno: [], soloOperativo: [], ambos: [], sinQA: [] };
    for (const t of allTickets) {
      const hasInterno = t.revInterno && t.revInterno !== 'N/A';
      const hasOperativo = t.revOperativo && t.revOperativo !== 'N/A';
      const entry = {
        key: t.key, summary: t.summary, status: t.status,
        assignee: t.assignee, revInterno: t.revInterno, revOperativo: t.revOperativo,
      };
      if (hasInterno && hasOperativo) qaBreakdown.ambos.push(entry);
      else if (hasInterno) qaBreakdown.soloInterno.push(entry);
      else if (hasOperativo) qaBreakdown.soloOperativo.push(entry);
      else qaBreakdown.sinQA.push(entry);
    }

    // Totales
    const totales = {
      total: allTickets.length,
      activos: activeIssues.length,
      finalizados: doneIssues.length,
      soloInterno: qaBreakdown.soloInterno.length,
      soloOperativo: qaBreakdown.soloOperativo.length,
      ambosQA: qaBreakdown.ambos.length,
      sinQA: qaBreakdown.sinQA.length,
    };

    // Módulos y tipos
    const doneKeys = new Set(doneIssues.map(i => i.key));
    function buildTiposMap(tickets, universo) {
      const map = {};
      for (const t of tickets) {
        const tipo = t.tipoTicket, modulo = t.modulo;
        if (!map[tipo]) map[tipo] = { total: 0, modulos: {} };
        map[tipo].total++;
        if (!map[tipo].modulos[modulo]) map[tipo].modulos[modulo] = { count: 0, tickets: [] };
        map[tipo].modulos[modulo].count++;
        map[tipo].modulos[modulo].tickets.push({
          key: t.key, summary: t.summary, status: t.status, assignee: t.assignee,
          descripcion: t.descripcion || null,
        });
      }
      return Object.fromEntries(
        Object.entries(map).sort((a, b) => b[1].total - a[1].total)
          .map(([tipo, d]) => [tipo, {
            total: d.total,
            porcentaje: universo > 0 ? Math.round((d.total / universo) * 1000) / 10 : 0,
            modulos: Object.fromEntries(
              Object.entries(d.modulos).sort((a, b) => b[1].count - a[1].count)
                .map(([mod, mdata]) => [mod, {
                  count: mdata.count,
                  porcentajeTipo: d.total > 0 ? Math.round((mdata.count / d.total) * 1000) / 10 : 0,
                  tickets: mdata.tickets,
                }])
            ),
          }])
      );
    }

    const moduloStats = {
      totalTickets: allTickets.length,
      totalFinalizado: doneIssues.length,
      tipos: buildTiposMap(allTickets, allTickets.length),
      tiposFinalizado: buildTiposMap(allTickets.filter(t => doneKeys.has(t.key)), doneIssues.length),
    };

    res.json({
      generadoEn: new Date().toISOString(),
      totales, statusCounts, qaBreakdown, moduloStats,
    });
  } catch (err) {
    console.error('[GET /api/reporte/datos-basicos]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/reporte/datos-changelogs
// Datos pesados: changelogs, devStats, timeline, revisores
// ─────────────────────────────────────────────────────────────
router.get('/datos-changelogs', async (req, res) => {
  try {
    const jqlActive = process.env.JIRA_JQL;
    const jqlDone = process.env.JIRA_JQL_DONE;
    if (!jqlActive || !jqlDone) {
      return res.status(500).json({ error: 'JIRA_JQL no configurado en .env' });
    }

    const [activeIssues, doneIssues] = await Promise.all([
      fetchJiraIssues(jqlActive),
      fetchJiraIssues(jqlDone),
    ]);

    const allIssues = [...activeIssues, ...doneIssues];
    const allTickets = allIssues.map(issue => mapIssue(issue, {}));

    // Changelogs en lotes
    const BATCH = 5;
    const changelogs = {};
    for (let i = 0; i < allIssues.length; i += BATCH) {
      const batch = allIssues.slice(i, i + BATCH);
      const results = await Promise.all(
        batch.map(async issue => {
          try { return { key: issue.key, history: await fetchIssueChangelog(issue.key) }; }
          catch { return { key: issue.key, history: [] }; }
        })
      );
      results.forEach(r => { changelogs[r.key] = r.history; });
    }

    // Timelines
    const ticketTimelines = {};
    for (const t of allTickets) {
      ticketTimelines[t.key] = computeTimeline(changelogs[t.key] || []);
    }

    // Revisores
    const revInternoStats = {}, revOperativoStats = {};
    for (const t of allTickets) {
      const tl = ticketTimelines[t.key];
      if (t.revInterno && t.revInterno !== 'N/A') {
        if (!revInternoStats[t.revInterno]) revInternoStats[t.revInterno] = { total: 0, tickets: [], tiempoQA: 0 };
        revInternoStats[t.revInterno].total++;
        revInternoStats[t.revInterno].tickets.push(t.key);
        revInternoStats[t.revInterno].tiempoQA += sumaQATime(tl.tiemposPorEstado);
      }
      if (t.revOperativo && t.revOperativo !== 'N/A') {
        if (!revOperativoStats[t.revOperativo]) revOperativoStats[t.revOperativo] = { total: 0, tickets: [], tiempoQA: 0 };
        revOperativoStats[t.revOperativo].total++;
        revOperativoStats[t.revOperativo].tickets.push(t.key);
        revOperativoStats[t.revOperativo].tiempoQA += sumaQATime(tl.tiemposPorEstado);
      }
    }
    for (const r of Object.values(revInternoStats)) r.tiempoQA = Math.round(r.tiempoQA * 10) / 10;
    for (const r of Object.values(revOperativoStats)) r.tiempoQA = Math.round(r.tiempoQA * 10) / 10;

    // Dev stats
    const devStats = {};
    for (const t of allTickets) {
      const devs = (t.desarrolladores || []).filter(isDeveloper);
      if (devs.length === 0) continue;
      const tl = ticketTimelines[t.key];
      for (const dev of devs) {
        if (!devStats[dev]) {
          devStats[dev] = {
            tickets: [], totalHorasEstimadas: 0, finalizados: 0,
            totalDevTime: 0, totalQATime: 0, retornosTotal: 0, rebotesQAReal: 0,
            ticketsConRetraso: 0, retrasoPromedioDias: 0, _retrasoAcum: 0, _retrasoCount: 0,
          };
        }
        devStats[dev].tickets.push(t.key);
        devStats[dev].totalHorasEstimadas += t.horas || 0;
        if (/done|cerrado|finalizado|completado/i.test(t.status)) devStats[dev].finalizados++;
        devStats[dev].totalDevTime += sumaDevTime(tl.tiemposPorEstado);
        devStats[dev].totalQATime += sumaQATime(tl.tiemposPorEstado);
        devStats[dev].retornosTotal += tl.retornos;
        if (typeof t.rebotesQATotal === 'number') devStats[dev].rebotesQAReal += t.rebotesQATotal;
        if (t.retraso_dias !== null && t.retraso_dias > 0) {
          devStats[dev].ticketsConRetraso++;
          devStats[dev]._retrasoAcum += t.retraso_dias;
          devStats[dev]._retrasoCount++;
        }
      }
    }
    for (const d of Object.values(devStats)) {
      d.totalHorasEstimadas = Math.round(d.totalHorasEstimadas * 10) / 10;
      d.totalDevTime = Math.round(d.totalDevTime * 10) / 10;
      d.totalQATime = Math.round(d.totalQATime * 10) / 10;
      d.retrasoPromedioDias = d._retrasoCount > 0 ? Math.round((d._retrasoAcum / d._retrasoCount) * 10) / 10 : 0;
      delete d._retrasoAcum; delete d._retrasoCount;
    }

    // Timeline tickets
    const timelineTickets = allTickets.map(t => ({
      key: t.key, summary: t.summary, desarrolladores: t.desarrolladores, assignee: t.assignee,
      status: t.status, priority: t.priority, horas: t.horas, horasRestantes: t.horasRestantes,
      revInterno: t.revInterno, revOperativo: t.revOperativo,
      contadorQAInterno: t.contadorQAInterno, contadorQAOperativo: t.contadorQAOperativo,
      rebotesQATotal: t.rebotesQATotal, retraso_dias: t.retraso_dias,
      duracion_real_dias: t.duracion_real_dias, fechaInicioReal: t.fechaInicioReal,
      fechaFinReal: t.fechaFinReal, fechaInicioEst: t.fechaInicioEst,
      fechaFinEstimada: t.fechaFinEstimada,
      tiemposPorEstado: ticketTimelines[t.key]?.tiemposPorEstado || {},
      retornos: ticketTimelines[t.key]?.retornos || 0,
      transiciones: ticketTimelines[t.key]?.transiciones || [],
    }));

    res.json({
      generadoEn: new Date().toISOString(),
      revInternoStats, revOperativoStats, devStats, timelineTickets,
    });
  } catch (err) {
    console.error('[GET /api/reporte/datos-changelogs]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/reporte/datos (LEGACY - mantener compatibilidad)
// ─────────────────────────────────────────────────────────────
router.get('/datos', async (req, res) => {
  try {
    const [basicos, changelogs] = await Promise.all([
      fetch('http://localhost:' + (process.env.PORT || 3001) + '/api/reporte/datos-basicos').then(r => r.json()),
      fetch('http://localhost:' + (process.env.PORT || 3001) + '/api/reporte/datos-changelogs').then(r => r.json()),
    ]);
    res.json({ ...basicos, ...changelogs });
  } catch (err) {
    console.error('[GET /api/reporte/datos]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/reporte/pausas — Listar pausas/interrupciones
// ─────────────────────────────────────────────────────────────
router.get('/pausas', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM pausas_version ORDER BY fecha_inicio DESC, created_at DESC'
    );
    res.json({ pausas: rows });
  } catch (err) {
    console.error('[GET /api/reporte/pausas]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/reporte/pausas — Crear una pausa/interrupción
// ─────────────────────────────────────────────────────────────
router.post('/pausas', async (req, res) => {
  try {
    const { descripcion, tipo, responsable, fecha_inicio, fecha_fin, ticket_relacionado } = req.body;
    if (!descripcion || !descripcion.trim()) {
      return res.status(400).json({ error: 'La descripción es requerida' });
    }
    const [result] = await pool.query(
      `INSERT INTO pausas_version (descripcion, tipo, responsable, fecha_inicio, fecha_fin, ticket_relacionado)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        descripcion.trim(),
        tipo || 'Otro',
        responsable || null,
        fecha_inicio || null,
        fecha_fin || null,
        ticket_relacionado || null,
      ]
    );
    const [rows] = await pool.query('SELECT * FROM pausas_version WHERE id = ?', [result.insertId]);
    res.status(201).json({ pausa: rows[0] });
  } catch (err) {
    console.error('[POST /api/reporte/pausas]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// DELETE /api/reporte/pausas/:id — Eliminar una pausa
// ─────────────────────────────────────────────────────────────
router.delete('/pausas/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || id <= 0) return res.status(400).json({ error: 'ID inválido' });
    await pool.query('DELETE FROM pausas_version WHERE id = ?', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /api/reporte/pausas/:id]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
