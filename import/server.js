'use strict';

// incarca .env din directorul serverului, indiferent de cwd (altfel commit-ul da "Supabase neconfigurat")
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

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
const { coarsePick, aiRefine, filterByStructured } = require('./chat');
const { parseFilename } = require('./parseFilename');
const { mapToMaterial } = require('./pipeline');

// Nu lasa serverul sa moara la o eroare neprinsa dintr-un link prost (stream picat, PDF stricat,
// socket resetat). Fara astea, un singur link problematic omoara procesul si TOATE link-urile
// urmatoare esueaza pana la repornire manuala.
process.on('uncaughtException', (e) => console.error('[uncaughtException]', (e && e.stack) || e));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', (e && (e.stack || e.message)) || e));

const app = express();
// CORS: daca CORS_ORIGIN e setat (prod), permitem doar acel domeniu; altfel orice (local/test).
app.use(cors(process.env.CORS_ORIGIN ? { origin: process.env.CORS_ORIGIN.split(',').map((s) => s.trim()) } : {}));
app.use(express.json({ limit: '1mb' }));

// legat de directorul serverului (nu de cwd) ca sesiunile chat->commit sa foloseasca acelasi loc,
// indiferent de unde e pornit serverul (altfel commit da "Fisier lipsa in sesiune")
const PREVIEW_ROOT = path.join(__dirname, '_import_preview');
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
  if (/informatica/.test(n)) return 'informatica'; // "mate-info" NU contine "informatica"
  if (/fizic/.test(n)) return 'fizica';
  if (/romana|literatura/.test(n)) return 'romana';
  return 'matematica';
}
function toMaterial(name, previewUrl) {
  const p = parseFilename(name);
  const subject = inferSubject(name, p);
  const tip = p ? mapToMaterial(p, {})._tip : (/(barem|_bar_|\bbar\b|solut|rezolvar|answer)/i.test(name) ? 'barem' : 'subiect');
  // distinge, ca subiectele sa nu aiba acelasi nume: specializare (MI/SN) + limbaj (doar la informatica) + numarul variantei
  const nlow = name.toLowerCase();
  const spec = subject === 'informatica'
    ? (/_sp[_\- ]?mi[_\-]/i.test(name) ? 'mate-info' : /_sp[_\- ]?sn[_\-]/i.test(name) ? 'st-nat' : null)
    : null;
  const specLabel = spec === 'mate-info' ? 'Mate-Info' : spec === 'st-nat' ? 'Șt. naturii' : null;
  const lang = subject === 'informatica'
    ? (/pascal/.test(nlow) ? 'Pascal' : /(_c_|_cpp|c\+\+)/.test(nlow) ? 'C/C++' : null)
    : null;
  const vm = name.match(/(?:var|bar)[_\- ]?(\d{1,3}|simulare|model|special[a-z]*|rezerv[a-z]*|toamn[a-z]*)/i);
  let varLabel = null;
  if (vm) {
    const v = vm[1].toLowerCase();
    varLabel = /^\d+$/.test(v) ? `Varianta ${Number(v)}` : (v.charAt(0).toUpperCase() + v.slice(1));
  }
  const extra = [specLabel, lang, varLabel].filter(Boolean);
  const profil = (p && p.profil) || spec || null;
  let title;
  if (p) {
    const base = mapToMaterial(p, {}).title.replace(/\s*\((subiect|barem)\)\s*$/i, '');
    title = [base, ...extra].join(' — ');
  } else {
    title = [name.replace(/\.pdf$/i, ''), ...extra].join(' — ');
  }
  return {
    title, file_name: name, tip,
    profil,
    year: p ? p.an : null,
    subject,
    category: 'bac_model',
    previewUrl,
  };
}

// Metadate afisabile pentru un element din rasfoire (subiect/barem, profil, an).
function fileMeta(label, href) {
  let name = label || '';
  if (!parseFilename(name) && href) {
    try { const b = decodeURIComponent(href.split('?')[0].split('/').pop()); if (parseFilename(b)) name = b; } catch { /* noop */ }
  }
  const m = toMaterial(name, '');
  return { tip: m.tip, profil: m.profil, year: m.year, subject: m.subject, title: m.title };
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

    // COARSE (materie/an): ce arhive/fisiere aducem
    const ids = coarsePick(sel.items, String(message));
    if (!ids.length) {
      return res.json({ reply: 'Spune-mi materia (ex: „modelele de matematică", „subiectele de fizică") ca să știu ce să deschid.', materials: [], found: sel.items.length });
    }

    // aduce fisierele reale, apoi AI-ul alege exact ce se potriveste cererii
    const files = await materialize(sel, ids);
    if (!files.length) return res.json({ reply: 'N-am putut extrage fișiere din sursa asta.', materials: [], found: sel.items.length });
    const byName = new Map(files.map((f) => [f.name, f]));
    const prelim = files.map((f) => toMaterial(f.name, ''));

    const { reply: aiReply, chosen } = await aiRefine(prelim, String(message), history || []);
    if (!chosen.length) {
      return res.json({ reply: 'Am găsit fișiere, dar niciunul nu se potrivește exact cererii tale. Încearcă altă formulare.', materials: [], found: sel.items.length });
    }

    const session = crypto.randomBytes(6).toString('hex');
    const dest = path.join(PREVIEW_ROOT, session);
    fs.mkdirSync(dest, { recursive: true });
    const materials = [];
    for (const m of chosen) {
      const f = byName.get(m.file_name);
      if (!f) continue;
      const bytes = await f.getBytes();
      fs.writeFileSync(path.join(dest, m.file_name), bytes);
      m.previewUrl = `/api/import/file/${session}/${encodeURIComponent(m.file_name)}`;
      materials.push(m);
    }
    const s = materials.filter((m) => m.tip === 'subiect').length;
    const b = materials.filter((m) => m.tip === 'barem').length;
    const countLine = `${materials.length} fișiere${b ? ` (${s} subiecte, ${b} bareme)` : ''}`;
    const finalReply = aiReply ? `${aiReply} — ${countLine}. Verifică și confirmă.` : `Am pregătit ${countLine}. Verifică și confirmă.`;
    res.json({ session, reply: finalReply, materials, found: sel.items.length });
  } catch (e) {
    const m = String((e && e.message) || e);
    let friendly;
    if (/-> 404/.test(m)) friendly = 'Linkul dă eroare 404 — fișierul nu există la adresa asta (poate nu e publicat încă sau adresa e greșită).';
    else if (/-> (\d{3})/.test(m)) friendly = `Sursa nu răspunde corect (eroare ${(m.match(/-> (\d{3})/) || [])[1]}). Verifică linkul.`;
    else if (/Niciun fisier|Niciun \.pdf/i.test(m)) friendly = 'Pe pagina asta n-am găsit fișiere de descărcat.';
    else friendly = 'N-am putut citi sursa asta.';
    res.json({ reply: `⚠️ ${friendly} Îți recomand subiecte.edu.ro (arhiva oficială) — acolo modelele sunt fișiere curate, gata de importat.`, materials: [], found: 0 });
  }
});

// Descarca fisierele alese intr-o sesiune de preview si le pregateste pt afisare/commit.
async function stageSession(chosen, byName) {
  const session = crypto.randomBytes(6).toString('hex');
  const dest = path.join(PREVIEW_ROOT, session);
  fs.mkdirSync(dest, { recursive: true });
  const materials = [];
  for (const m of chosen) {
    const f = byName.get(m.file_name);
    if (!f) continue;
    const bytes = await f.getBytes();
    fs.writeFileSync(path.join(dest, m.file_name), bytes);
    m.previewUrl = `/api/import/file/${session}/${encodeURIComponent(m.file_name)}`;
    materials.push(m);
  }
  return { session, materials };
}

const SUBJ_WORD = { matematica: 'matematica', informatica: 'informatica', fizica: 'fizica', romana: 'romana' };

// FILTRARE STRUCTURATA din bara: fara AI, pe butoane (materie/an/specializare/limbaj/tip).
app.post('/api/import/filter', async (req, res) => {
  const { url, subject, year, specializare, limbaj, tip } = req.body || {};
  if (!url || !subject) return res.status(400).json({ error: 'Trebuie url si materie.' });
  try {
    const sel = await getSelectable(String(url));
    if (!sel.items.length) return res.json({ reply: 'Pe pagina asta nu am găsit fișiere de descărcat.', materials: [], found: 0 });

    // coarse: aducem doar ce tine de materie + an (paginile se deschid singure)
    const coarseMsg = `${SUBJ_WORD[subject] || ''} ${year || 'toate'}`.trim();
    const ids = coarsePick(sel.items, coarseMsg);
    if (!ids.length) return res.json({ reply: 'Nu am găsit nimic pentru materia asta pe pagină.', materials: [], found: sel.items.length });

    const files = await materialize(sel, ids);
    if (!files.length) return res.json({ reply: 'N-am putut extrage fișiere din sursa asta.', materials: [], found: sel.items.length });
    const byName = new Map(files.map((f) => [f.name, f]));
    const prelim = files.map((f) => toMaterial(f.name, ''));

    const chosen = filterByStructured(prelim, { subject, year, specializare, limbaj, tip });
    if (!chosen.length) return res.json({ reply: 'Niciun fișier nu se potrivește filtrelor alese. Slăbește un filtru și încearcă din nou.', materials: [], found: sel.items.length });

    const { session, materials } = await stageSession(chosen, byName);
    const s = materials.filter((m) => m.tip === 'subiect').length;
    const b = materials.length - s;
    const countLine = `${materials.length} fișiere${b ? ` (${s} subiecte, ${b} bareme)` : ''}`;
    res.json({ session, reply: `Am adus ${countLine}. Verifică și publică.`, materials, found: sel.items.length });
  } catch (e) {
    const m = String((e && e.message) || e);
    let friendly;
    if (/-> 404/.test(m)) friendly = 'Linkul dă eroare 404 — pagina nu există la adresa asta.';
    else if (/-> (\d{3})/.test(m)) friendly = `Sursa nu răspunde corect (eroare ${(m.match(/-> (\d{3})/) || [])[1]}).`;
    else friendly = 'N-am putut citi sursa asta.';
    res.json({ reply: `⚠️ ${friendly}`, materials: [], found: 0 });
  }
});

// Grupeaza subiect+barem intr-un material + upload storage + insert. bytesOf(m) -> octetii.
async function commitMaterials(materials, bytesOf, token, genre) {
  const H = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` };
  const uploadOne = async (m) => {
    const bytes = await bytesOf(m);
    const destPath = `${m.category || 'bac_model'}/${m.subject || 'matematica'}/${m.file_name}`;
    const up = await fetch(`${SUPABASE_URL}/storage/v1/object/materials/${encodeURI(destPath)}`, {
      method: 'POST', headers: { ...H, 'Content-Type': 'application/pdf', 'x-upsert': 'true' }, body: bytes,
    });
    if (!up.ok) throw new Error(`upload ${m.file_name}: ${up.status} ${await up.text()}`);
    return { url: `${SUPABASE_URL}/storage/v1/object/public/materials/${destPath}`, size: bytes.length };
  };
  // Grup = aceeasi varianta (an, specializare, numar). Cheia ignora marcajul var/bar
  // SI limbajul (c/cpp/pascal), ca subiectul C++, subiectul Pascal si baremul comun
  // sa cada impreuna; variantele si specializarile (03/05, MI/SN) raman SEPARATE.
  const baseKey = (m) => {
    const n = String(m.file_name || '').toLowerCase().replace(/\.pdf$/, '')
      .replace(/(^|[_\-\s])(var|bar|subiect|barem|solutii|rezolvari)([_\-\s]|$)/g, '$1$3')
      .replace(/(^|[_\-\s])(cpp|pascal|c)([_\-\s]|$)/g, '$1$3')
      .replace(/[_\-\s]+/g, '_').replace(/^_|_$/g, '');
    return `${m.subject || ''}|${n}`;
  };
  const groups = new Map(); // key -> { subiecte: [...], barem: m|null }
  for (const m of materials) {
    const k = baseKey(m);
    if (!groups.has(k)) groups.set(k, { subiecte: [], barem: null });
    const g = groups.get(k);
    if (m.tip === 'barem') {
      if (!g.barem) g.barem = m;
      else groups.set(`${k}#b${groups.size}`, { subiecte: [], barem: m }); // barem in plus -> rand propriu
    } else {
      g.subiecte.push(m);
    }
  }
  let imported = 0;
  for (const g of groups.values()) {
    const list = g.subiecte.length ? g.subiecte : (g.barem ? [g.barem] : []);
    let baremUp = null; // baremul comun se urca o singura data pe grup
    for (const main of list) {
      const mainUp = await uploadOne(main);
      const row = {
        title: (main.title || '').replace(/\s*\((subiect|barem)\)\s*$/i, '') || main.title,
        subject: main.subject || 'matematica', category: main.category || 'bac_model',
        year: main.year || null, file_name: main.file_name, file_type: 'pdf',
        genre: genre || null, // sectiunea din platforma: Subiectul I/II/III sau Variante intregi
        file_size: mainUp.size, file_url: mainUp.url,
      };
      if (g.subiecte.length && g.barem) {
        if (!baremUp) baremUp = await uploadOne(g.barem);
        row.barem_url = baremUp.url; row.barem_name = g.barem.file_name; row.barem_size = baremUp.size;
      }
      const ins = await fetch(`${SUPABASE_URL}/rest/v1/materials`, {
        method: 'POST', headers: { ...H, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify(row),
      });
      if (!ins.ok) throw new Error(`insert ${main.file_name}: ${ins.status} ${await ins.text()}`);
      imported += 1;
    }
  }
  return imported;
}

// SCRIERE REALA din chat: fisierele sunt deja descarcate in sesiune.
app.post('/api/import/commit', async (req, res) => {
  const { session, materials, token, genre } = req.body || {};
  if (!session || !Array.isArray(materials) || !materials.length) return res.status(400).json({ error: 'Trebuie session si materials.' });
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return res.status(500).json({ error: 'Supabase neconfigurat.' });
  if (!token) return res.status(401).json({ error: 'Lipseste sesiunea profesorului. Reautentifica-te si incearca din nou.' });
  const dir = path.join(PREVIEW_ROOT, path.basename(String(session)));
  try {
    const imported = await commitMaterials(materials, (m) => {
      const file = path.join(dir, path.basename(m.file_name));
      if (!fs.existsSync(file)) throw new Error(`Fisier lipsa in sesiune: ${m.file_name}`);
      return fs.readFileSync(file);
    }, token, genre);
    res.json({ ok: true, imported });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// RASFOIRE: listeaza elementele unei pagini (fara AI) — pentru bifat/navigat manual.
app.post('/api/import/list', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Trebuie url.' });
  try {
    const sel = await getSelectable(String(url));
    res.json({
      source: sel.source,
      items: sel.items.map((i) => {
        const href = (sel._resolve[i.id] || {}).href || null;
        const it = { id: i.id, label: i.label, kind: i.kind, href };
        if (i.kind !== 'page') Object.assign(it, fileMeta(i.label, href)); // tip, profil, an, subiect, title
        return it;
      }),
    });
  } catch (e) {
    res.json({ items: [], error: e.message });
  }
});

// IMPORT din rasfoire: descarca elementele bifate de pe o pagina + le publica.
app.post('/api/import/browse-import', async (req, res) => {
  const { url, ids, token, genre } = req.body || {};
  if (!url || !Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'Trebuie url si elemente bifate.' });
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return res.status(500).json({ error: 'Supabase neconfigurat.' });
  if (!token) return res.status(401).json({ error: 'Lipseste sesiunea profesorului. Reautentifica-te.' });
  try {
    const sel = await getSelectable(String(url));
    const files = await materialize(sel, ids);
    if (!files.length) return res.status(400).json({ error: 'Elementele alese nu conțin fișiere.' });
    const byName = new Map(files.map((f) => [f.name, f]));
    const materials = files.map((f) => toMaterial(f.name, ''));
    const imported = await commitMaterials(materials, (m) => byName.get(m.file_name).getBytes(), token, genre);
    res.json({ ok: true, imported });
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

// Render (si alte host-uri) seteaza PORT; local folosim IMPORT_PORT sau 3040.
const PORT = process.env.PORT || process.env.IMPORT_PORT || 3040;
app.listen(PORT, () => console.log(`Import server (chat) pe portul ${PORT}`));
