'use strict';

require('dotenv').config();

// Server HTTP pentru UI-ul profesorului. DRY-RUN (preview) — nu scrie in DB.
//   POST /api/import/chat  { url, message, history } -> { reply, materials }
//   GET  /api/import/file/:session/:name              -> serveste un PDF descarcat
//
// Pornire:  IMPORT_PORT=3040 node import/server.js

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { listSelectable, materialize } = require('./source');
const { chatSelect } = require('./chat');
const { parseFilename } = require('./parseFilename');
const { mapToMaterial } = require('./pipeline');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PREVIEW_ROOT = path.join(process.cwd(), '_import_preview');

// cache pe URL: lista selectabila (ca sa nu re-descarcam pagina la fiecare mesaj)
const pageCache = new Map(); // url -> { sel, ts }
const CACHE_MS = 10 * 60 * 1000;

async function getSelectable(url) {
  const c = pageCache.get(url);
  if (c && Date.now() - c.ts < CACHE_MS) return c.sel;
  const sel = await listSelectable(url);
  pageCache.set(url, { sel, ts: Date.now() });
  return sel;
}

function toMaterial(name, previewUrl) {
  const p = parseFilename(name);
  if (p) {
    const row = mapToMaterial(p, {});
    return { title: row.title, file_name: name, tip: row._tip, profil: p.profil, year: p.an, previewUrl };
  }
  const tip = /(barem|_bar_|\bbar\b|solut|rezolvar|answer)/i.test(name) ? 'barem' : 'subiect';
  return { title: name.replace(/\.pdf$/i, ''), file_name: name, tip, profil: null, year: null, previewUrl };
}

app.get('/api/health', (_req, res) => res.json({ status: 'ok', mode: 'import-chat' }));

app.post('/api/import/chat', async (req, res) => {
  const { url, message, history } = req.body || {};
  if (!url || !message) return res.status(400).json({ error: 'Trebuie url si message.' });
  try {
    const sel = await getSelectable(String(url));
    if (!sel.items.length) {
      return res.json({ reply: 'Pe pagina asta nu am găsit fișiere de descărcat (subiecte/bareme). Verifică linkul.', materials: [], found: 0 });
    }

    const { reply, ids } = await chatSelect(sel.items, String(message), history || []);
    if (!ids.length) return res.json({ reply, materials: [], found: sel.items.length });

    const session = crypto.randomBytes(6).toString('hex');
    const dest = path.join(PREVIEW_ROOT, session);
    fs.mkdirSync(dest, { recursive: true });

    const files = await materialize(sel, ids);
    const materials = [];
    for (const f of files) {
      const bytes = await f.getBytes();
      fs.writeFileSync(path.join(dest, f.name), bytes);
      materials.push(toMaterial(f.name, `/api/import/file/${session}/${encodeURIComponent(f.name)}`));
    }
    // reply cu numarul REAL de fisiere pregatite (dupa extinderea ZIP-urilor)
    const s = materials.filter((m) => m.tip === 'subiect').length;
    const b = materials.filter((m) => m.tip === 'barem').length;
    const finalReply = materials.length
      ? `Am pregătit ${materials.length} fișiere${b ? ` (${s} subiecte, ${b} bareme)` : ''}. Verifică-le mai jos și confirmă importul.`
      : reply;
    res.json({ reply: finalReply, materials, found: sel.items.length });
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
app.listen(PORT, () => console.log(`Import server (chat) pe portul ${PORT}`));
