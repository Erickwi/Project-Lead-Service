const express = require('express');
const router  = express.Router();
const pool    = require('../config/db');

const PRIORIDADES_VALIDAS = ['Alta', 'Media', 'Baja', 'Verde'];

// GET /api/recordatorios
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM recordatorios ORDER BY posicion ASC, prioridad ASC, fecha ASC'
    );
    res.json({ recordatorios: rows });
  } catch (err) {
    console.error('[GET /api/recordatorios]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/recordatorios
router.post('/', async (req, res) => {
  const { descripcion, prioridad, fecha } = req.body;

  if (!descripcion || typeof descripcion !== 'string' || !descripcion.trim()) {
    return res.status(400).json({ error: 'descripcion es requerida' });
  }
  if (!prioridad || !PRIORIDADES_VALIDAS.includes(prioridad)) {
    return res.status(400).json({ error: 'prioridad debe ser Alta, Media, Baja o Verde' });
  }

  try {
    // Mover todas las posiciones actuales +1 para que la nueva nota quede en la posición 1
    await pool.query('UPDATE recordatorios SET posicion = posicion + 1');
    const [result] = await pool.query(
      'INSERT INTO recordatorios (descripcion, prioridad, fecha, posicion) VALUES (?, ?, ?, ?) ',
      [descripcion.trim(), prioridad, fecha || null, 1]
    );
    res.status(201).json({
      id: result.insertId,
      descripcion: descripcion.trim(),
      prioridad,
      fecha: fecha || null,
      posicion: 1,
    });
  } catch (err) {
    console.error('[POST /api/recordatorios]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/recordatorios/reorder - debe estar antes de /:id
router.put('/reorder', async (req, res) => {
  const { orden } = req.body;
  if (!Array.isArray(orden)) {
    return res.status(400).json({ error: 'orden debe ser un array de ids' });
  }

  try {
    for (let i = 0; i < orden.length; i++) {
      await pool.query('UPDATE recordatorios SET posicion = ? WHERE id = ?', [i + 1, orden[i]]);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[PUT /api/recordatorios/reorder]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/recordatorios/:id
router.put('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'id inválido' });

  const { descripcion, prioridad, fecha } = req.body;

  if (!descripcion || typeof descripcion !== 'string' || !descripcion.trim()) {
    return res.status(400).json({ error: 'descripcion es requerida' });
  }
  if (!prioridad || !PRIORIDADES_VALIDAS.includes(prioridad)) {
    return res.status(400).json({ error: 'prioridad debe ser Alta, Media, Baja o Verde' });
  }

  try {
    const [result] = await pool.query(
      'UPDATE recordatorios SET descripcion = ?, prioridad = ?, fecha = ? WHERE id = ?',
      [descripcion.trim(), prioridad, fecha || null, id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Recordatorio no encontrado' });
    res.json({ success: true });
  } catch (err) {
    console.error('[PUT /api/recordatorios]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/recordatorios/:id
router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'id inválido' });

  try {
    const [result] = await pool.query('DELETE FROM recordatorios WHERE id = ?', [id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Recordatorio no encontrado' });
    res.json({ success: true });
  } catch (err) {
    console.error('[DELETE /api/recordatorios]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
