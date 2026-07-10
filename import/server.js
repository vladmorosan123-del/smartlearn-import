'use strict';

// Server HTTP pentru UI-ul profesorului. DRY-RUN (preview) — nu scrie in DB.
//   POST /api/import/preview   { url, instruction, useAI? } -> plan + PDF-uri de previzualizat
//   GET  /api/import/file/:session/:name                    -> serveste un PDF descarcat
//
// Pornire:  IMPORT_PORT=3040 node import/server.js

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildPlan } = require('./index');

const app = express();
app.use(cors());
app.use(express.json());

const PREVIEW_ROOT = path.join(process.cwd(), '_import_preview');

app.get('/api/health', (_req, res) => res.json({ status: 'ok', mode: 'import-preview' }));

app.post('/api/import/preview', async (req, res) => {
  const { url, instruction, useAI } = req.body || {};
  if (!url || !instruction) return res.status(400).json({ error: 'Trebuie url si instructiune.' });
  try {
    const session = crypto.randomBytes(6).toString('hex');
    const dest = path.join(PREVIEW_ROOT, session);
    const plan = await buildPlan(String(url), String(instruction), { useAI: !!useAI, dest });

    const materials = plan.materials.map((r) => ({
      title: r.title,
      subject: r.subject,
      category: r.category,
      year: r.year,
      profil: (r.study_classes && r.study_classes[0]) || null,
      tip: r._tip,
      file_name: r.file_name,
      previewUrl: `/api/import/file/${session}/${encodeURIComponent(r.file_name)}`,
    }));

    res.json({ session, source: plan.source, filter: plan.filter, summary: plan.summary, materials });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/import/file/:session/:name', (req, res) => {
  const file = path.join(PREVIEW_ROOT, path.basename(req.params.session), path.basename(req.params.name));
  if (!fs.existsSync(file)) return res.status(404).end('not found');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${path.basename(file)}"`);
  fs.createReadStream(file).pipe(res);
});

const PORT = process.env.IMPORT_PORT || 3040;
app.listen(PORT, () => console.log(`Import server (preview) pe portul ${PORT}`));
