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
const { chatSelect, refineByMessage } = require('./chat');
const { parseFilename } = require('./parseFilename');
const { mapToMaterial } = require('./pipeline');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PREVIEW_ROOT = path.join(process.cwd(), '_import_preview');
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

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

function inferSubject(name, p) {
  if (p && p.materieSlug) return p.materieSlug;
  const n = name.toLowerCase();
  if (/fizica|fizic/.test(n)) return 'fizica';
  if (/informatica|info/.test(n)) return 'informatica';
  if (/romana|literatura/.test(n)) return 'romana';
  return 'matematica';
}
function toMaterial(name, previewUrl) {
  const p = parseFilename(name);
  const tip = p ? mapToMaterial(p, {})._tip : (/(barem|_bar_|\bbar\b|solut|rezolvar|answer)/i.test(name) ? 'barem' : 'subiect');
  const title = p ? mapToMaterial(p, {}).title : name.replace(/\.pdf$/i, '');
  return {
    title, file_name: name, tip,
    profil: p ? p.profil : null,
    year: p ? p.an : null,
    subject: inferSubject(name, p),
    category: 'bac_model',
    previewUrl,
  };
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

    const { ids } = await chatSelect(sel.items, String(message), history || []);
    if (!ids.length) {
      return res.json({ reply: 'Nu am găsit fișiere care să se potrivească. Reformulează (ex: „modelele de matematică mate-info").', materials: [], found: sel.items.length });
    }

    // extinde selectia in fisiere, apoi filtreaza FIN dupa mesaj (profil/tip/limita)
    const files = await materialize(sel, ids);
    let prelim = files.map((f) => ({ f, m: toMaterial(f.name, '') }));
    const keptNames = new Set(refineByMessage(prelim.map((x) => x.m), String(message)).map((m) => m.file_name));
    prelim = prelim.filter((x) => keptNames.has(x.m.file_name));

    if (!prelim.length) {
      return res.json({ reply: 'Am găsit fișiere, dar niciunul nu se potrivește exact cererii. Încearcă altă formulare.', materials: [], found: sel.items.length });
    }

    const session = crypto.randomBytes(6).toString('hex');
    const dest = path.join(PREVIEW_ROOT, session);
    fs.mkdirSync(dest, { recursive: true });
    const materials = [];
    for (const { f, m } of prelim) {
      const bytes = await f.getBytes();
      fs.writeFileSync(path.join(dest, f.name), bytes);
      m.previewUrl = `/api/import/file/${session}/${encodeURIComponent(f.name)}`;
      materials.push(m);
    }
    const s = materials.filter((m) => m.tip === 'subiect').length;
    const b = materials.filter((m) => m.tip === 'barem').length;
    const finalReply = `Am pregătit ${materials.length} fișiere${b ? ` (${s} subiecte, ${b} bareme)` : ''}. Verifică-le mai jos și confirmă importul.`;
    res.json({ session, reply: finalReply, materials, found: sel.items.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// SCRIERE REALA: upload in storage + insert in `materials`. Confirmata din UI.
app.post('/api/import/commit', async (req, res) => {
  const { session, materials } = req.body || {};
  if (!session || !Array.isArray(materials) || !materials.length) return res.status(400).json({ error: 'Trebuie session si materials.' });
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return res.status(500).json({ error: 'Supabase neconfigurat (SUPABASE_URL / SUPABASE_ANON_KEY).' });

  const dir = path.join(PREVIEW_ROOT, path.basename(String(session)));
  const H = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` };
  try {
    const imported = [];
    for (const m of materials) {
      const file = path.join(dir, path.basename(m.file_name));
      if (!fs.existsSync(file)) throw new Error(`Fisier lipsa in sesiune: ${m.file_name}`);
      const bytes = fs.readFileSync(file);

      const destPath = `${m.category || 'bac_model'}/${m.subject || 'matematica'}/${m.file_name}`;
      const up = await fetch(`${SUPABASE_URL}/storage/v1/object/materials/${encodeURI(destPath)}`, {
        method: 'POST',
        headers: { ...H, 'Content-Type': 'application/pdf', 'x-upsert': 'true' },
        body: bytes,
      });
      if (!up.ok) throw new Error(`upload ${m.file_name}: ${up.status} ${await up.text()}`);
      const fileUrl = `${SUPABASE_URL}/storage/v1/object/public/materials/${destPath}`;

      const row = {
        title: m.title, subject: m.subject || 'matematica', category: m.category || 'bac_model',
        year: m.year || null, file_name: m.file_name, file_type: 'application/pdf',
        file_size: bytes.length, file_url: fileUrl,
      };
      const ins = await fetch(`${SUPABASE_URL}/rest/v1/materials`, {
        method: 'POST',
        headers: { ...H, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify(row),
      });
      if (!ins.ok) throw new Error(`insert ${m.file_name}: ${ins.status} ${await ins.text()}`);
      imported.push(m.file_name);
    }
    res.json({ ok: true, imported: imported.length });
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
