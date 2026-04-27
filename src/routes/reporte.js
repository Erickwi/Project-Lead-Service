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
    revInterno: f.customfield_10083?.[0]?.displayName || 'N/A',
    revOperativo: f.customfield_10115?.[0]?.displayName || 'N/A',
    cliente_nombre: info.cliente_nombre || null,
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
// GET /api/reporte/datos
// Datos agregados del reporte de versión (tickets + changelogs)
// ─────────────────────────────────────────────────────────────
router.get('/datos', async (req, res) => {
  try {
    const jqlActive = process.env.JIRA_JQL;
    const jqlDone = process.env.JIRA_JQL_DONE;
    if (!jqlActive) return res.status(500).json({ error: 'JIRA_JQL no configurado en .env' });
    if (!jqlDone) return res.status(500).json({ error: 'JIRA_JQL_DONE no configurado en .env' });

    // 1. Obtener todos los tickets + datos de DB
    const [activeIssues, doneIssues, [dbRows]] = await Promise.all([
      fetchJiraIssues(jqlActive),
      fetchJiraIssues(jqlDone),
      pool.query('SELECT * FROM tickets_info'),
    ]);

    const infoMap = Object.fromEntries(dbRows.map(r => [r.ticket_key, r]));
    const allIssues = [...activeIssues, ...doneIssues];
    const allTickets = allIssues.map(issue => mapIssue(issue, infoMap));

    // 2. Obtener changelog por ticket (en lotes de 5 para no saturar la API)
    const BATCH = 5;
    const changelogs = {};

    for (let i = 0; i < allIssues.length; i += BATCH) {
      const batch = allIssues.slice(i, i + BATCH);
      const results = await Promise.all(
        batch.map(async issue => {
          try {
            const history = await fetchIssueChangelog(issue.key);
            return { key: issue.key, history };
          } catch {
            return { key: issue.key, history: [] };
          }
        })
      );
      results.forEach(r => { changelogs[r.key] = r.history; });
    }

    // 3. Calcular timelines por ticket
    const ticketTimelines = {};
    for (const t of allTickets) {
      ticketTimelines[t.key] = computeTimeline(changelogs[t.key] || []);
    }

    // 4. Distribución de estados actuales
    const statusCounts = {};
    for (const t of allTickets) {
      statusCounts[t.status] = (statusCounts[t.status] || 0) + 1;
    }

    // 5. QA Breakdown (quién tiene rev solo interno / solo operativo / ambos / sin QA)
    const qaBreakdown = { soloInterno: [], soloOperativo: [], ambos: [], sinQA: [] };
    for (const t of allTickets) {
      const hasInterno = t.revInterno && t.revInterno !== 'N/A';
      const hasOperativo = t.revOperativo && t.revOperativo !== 'N/A';
      const entry = {
        key: t.key,
        summary: t.summary,
        status: t.status,
        assignee: t.assignee,
        revInterno: t.revInterno,
        revOperativo: t.revOperativo,
      };
      if (hasInterno && hasOperativo) qaBreakdown.ambos.push(entry);
      else if (hasInterno) qaBreakdown.soloInterno.push(entry);
      else if (hasOperativo) qaBreakdown.soloOperativo.push(entry);
      else qaBreakdown.sinQA.push(entry);
    }

    // 6. Stats por revisor interno y operativo
    const revInternoStats = {};
    const revOperativoStats = {};

    for (const t of allTickets) {
      const tl = ticketTimelines[t.key];

      if (t.revInterno && t.revInterno !== 'N/A') {
        if (!revInternoStats[t.revInterno]) {
          revInternoStats[t.revInterno] = { total: 0, tickets: [], tiempoQA: 0 };
        }
        revInternoStats[t.revInterno].total++;
        revInternoStats[t.revInterno].tickets.push(t.key);

        // Acumular tiempo pasado en estados de QA para este ticket
        const qaHrs = sumaQATime(tl.tiemposPorEstado);
        revInternoStats[t.revInterno].tiempoQA += qaHrs;
      }

      if (t.revOperativo && t.revOperativo !== 'N/A') {
        if (!revOperativoStats[t.revOperativo]) {
          revOperativoStats[t.revOperativo] = { total: 0, tickets: [], tiempoQA: 0 };
        }
        revOperativoStats[t.revOperativo].total++;
        revOperativoStats[t.revOperativo].tickets.push(t.key);
        const qaHrs = sumaQATime(tl.tiemposPorEstado);
        revOperativoStats[t.revOperativo].tiempoQA += qaHrs;
      }
    }

    // Redondear tiempos
    for (const r of Object.values(revInternoStats)) {
      r.tiempoQA = Math.round(r.tiempoQA * 10) / 10;
    }
    for (const r of Object.values(revOperativoStats)) {
      r.tiempoQA = Math.round(r.tiempoQA * 10) / 10;
    }

    // 7. Stats por desarrollador — usa contadores reales de Jira
    // Usa el campo Desarrollador (customfield_10114), soporta múltiples devs por ticket.
    // Fallback a assignee si el campo no tiene valor.
    const devStats = {};
    for (const t of allTickets) {
      // Obtener lista de devs reales del ticket (filtrados)
      const devs = (t.desarrolladores || []).filter(isDeveloper);
      if (devs.length === 0) continue;
      const tl = ticketTimelines[t.key];
      for (const dev of devs) {
      if (!devStats[dev]) {
        devStats[dev] = {
          tickets: [],
          totalHorasEstimadas: 0,
          finalizados: 0,
          totalDevTime: 0,
          totalQATime: 0,
          retornosTotal: 0,       // calculado del changelog (fallback)
          rebotesQAReal: 0,       // calculado del contador de Jira
          ticketsConRetraso: 0,
          retrasoPromedioDias: 0,
          _retrasoAcum: 0,
          _retrasoCount: 0,
        };
      }
        devStats[dev].tickets.push(t.key);
        devStats[dev].totalHorasEstimadas += t.horas || 0;
        if (/done|cerrado|finalizado|completado/i.test(t.status)) devStats[dev].finalizados++;
        devStats[dev].totalDevTime += sumaDevTime(tl.tiemposPorEstado);
        devStats[dev].totalQATime += sumaQATime(tl.tiemposPorEstado);
        devStats[dev].retornosTotal += tl.retornos;

        // Rebotes reales desde el contador de Jira
        if (t.rebotesQAInterno !== null) {
          devStats[dev].rebotesQAReal += t.rebotesQAInterno;
        }

        // Retraso
        if (t.retraso_dias !== null && t.retraso_dias > 0) {
          devStats[dev].ticketsConRetraso++;
          devStats[dev]._retrasoAcum += t.retraso_dias;
          devStats[dev]._retrasoCount++;
        }
      } // fin loop devs
    }

    // Redondear y calcular promedios
    for (const d of Object.values(devStats)) {
      d.totalHorasEstimadas = Math.round(d.totalHorasEstimadas * 10) / 10;
      d.totalDevTime = Math.round(d.totalDevTime * 10) / 10;
      d.totalQATime = Math.round(d.totalQATime * 10) / 10;
      d.retrasoPromedioDias = d._retrasoCount > 0
        ? Math.round((d._retrasoAcum / d._retrasoCount) * 10) / 10
        : 0;
      delete d._retrasoAcum;
      delete d._retrasoCount;
    }

    // 8. Timeline por ticket (para la tabla detallada)
    const timelineTickets = allTickets.map(t => ({
      key: t.key,
      summary: t.summary,
      desarrolladores: t.desarrolladores,
      assignee: t.assignee,
      status: t.status,
      priority: t.priority,
      horas: t.horas,
      horasRestantes: t.horasRestantes,
      revInterno: t.revInterno,
      revOperativo: t.revOperativo,
      contadorQAInterno: t.contadorQAInterno,
      contadorQAOperativo: t.contadorQAOperativo,
      rebotesQAInterno: t.rebotesQAInterno,
      retraso_dias: t.retraso_dias,
      duracion_real_dias: t.duracion_real_dias,
      fechaInicioReal: t.fechaInicioReal,
      fechaFinReal: t.fechaFinReal,
      fechaInicioEst: t.fechaInicioEst,
      fechaFinEstimada: t.fechaFinEstimada,
      tiemposPorEstado: ticketTimelines[t.key]?.tiemposPorEstado || {},
      retornos: ticketTimelines[t.key]?.retornos || 0,
      transiciones: ticketTimelines[t.key]?.transiciones || [],
    }));

    // 9. Totales
    const totales = {
      total: allTickets.length,
      activos: activeIssues.length,
      finalizados: doneIssues.length,
      soloInterno: qaBreakdown.soloInterno.length,
      soloOperativo: qaBreakdown.soloOperativo.length,
      ambosQA: qaBreakdown.ambos.length,
      sinQA: qaBreakdown.sinQA.length,
    };

    // 10. Pausas de la DB
    const [pausasRows] = await pool.query(
      'SELECT * FROM pausas_version ORDER BY fecha_inicio DESC, created_at DESC'
    );

    res.json({
      generadoEn: new Date().toISOString(),
      totales,
      statusCounts,
      qaBreakdown,
      revInternoStats,
      revOperativoStats,
      devStats,
      timelineTickets,
      pausas: pausasRows,
    });
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
