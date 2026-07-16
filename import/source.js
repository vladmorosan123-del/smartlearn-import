'use strict';

// Acces la o sursa oficiala dintr-un link ARBITRAR.
// Detecteaza tipul dupa Content-Type (nu doar dupa extensie), deci merge si pe
// linkuri de descarcare fara extensie (ex. Joomla ".../file" care intoarce un PDF).
//
// Expune:
//   listSelectable(url) -> { source, items:[{id,label,kind,href}], _download }
//   materialize(sel, ids) -> [{ name, getBytes() }]  (extrage/descarca doar ce s-a ales)
//   gatherFiles(url, subject) -> pentru CLI (parseFilename), pastrat compatibil

const path = require('path');
const AdmZip = require('adm-zip');

// UA de browser real + headere ro — unele site-uri (pbinfo, gov) dau 403 la UA-uri "bot"
// sau la cereri care nu par de browser romanesc, mai ales de pe IP-uri de datacenter.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const BROWSER_HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'ro-RO,ro;q=0.9,en-US;q=0.8,en;q=0.7',
};

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ă/g, 'a').replace(/â/g, 'a').replace(/î/g, 'i')
    .replace(/ș|ş/g, 's').replace(/ț|ţ/g, 't');
}
function baseName(u) {
  try { return decodeURIComponent(path.posix.basename(new URL(u).pathname)); }
  catch { return decodeURIComponent(path.posix.basename(String(u))); }
}
function nameFromDisposition(cd, fallback) {
  if (!cd) return fallback;
  let m = cd.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
  if (m) return decodeURIComponent(m[1].replace(/["']/g, ''));
  m = cd.match(/filename="?([^";]+)"?/i);
  return m ? m[1] : fallback;
}
function stripTags(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

// respecta tag-ul <base href="..."> (schimba rezolvarea linkurilor relative)
function baseHref(html, fallback) {
  const m = html.match(/<base[^>]*href="([^"]+)"/i);
  if (m) { try { return new URL(m[1], fallback).href; } catch { /* noop */ } }
  return fallback;
}

// Site-uri unde grila de variante e randata prin JS, dar PDF-urile au URL numerotat
// predictibil (ex: ..._si_002.pdf). Din URL-ul unei variante generam Varianta 1..max.
function enumerateVariants(pdfLinks, max = 120) {
  const pdf = pdfLinks.find((l) => /(\d+)\.pdf(\?|$)/i.test(l.href));
  if (!pdf) return null;
  const m = pdf.href.match(/(\d+)(\.pdf)(\?|$)/i);
  const pad = m[1].length;
  const start = pdf.href.slice(0, m.index);
  const end = pdf.href.slice(m.index + m[1].length);
  const out = [];
  for (let n = 1; n <= max; n++) out.push({ url: `${start}${String(n).padStart(pad, '0')}${end}`, num: n });
  return out;
}

async function fetchResource(url) {
  const r = await fetch(url, { headers: BROWSER_HEADERS, redirect: 'follow' });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  const buffer = Buffer.from(await r.arrayBuffer());
  return {
    contentType: (r.headers.get('content-type') || '').toLowerCase(),
    disposition: r.headers.get('content-disposition') || '',
    buffer,
    finalUrl: r.url || url,
  };
}

// numele real al unui fisier fara extensie in URL (din Content-Disposition), cu un GET minimal
async function resolveName(href) {
  try {
    const r = await fetch(href, { headers: { ...BROWSER_HEADERS, Range: 'bytes=0-0' }, redirect: 'follow' });
    const name = nameFromDisposition(r.headers.get('content-disposition') || '', null);
    return name && /\.(pdf|zip|docx?)$/i.test(name) ? name : null;
  } catch { return null; }
}

function isPdf(ct, url) { return ct.includes('pdf') || /\.pdf($|\?)/i.test(url); }
function isZip(ct, url, cd) { return ct.includes('zip') || /\.zip($|\?)/i.test(url) || /\.zip/i.test(cd); }

function zipEntries(buffer) {
  return new AdmZip(buffer)
    .getEntries()
    .filter((e) => !e.isDirectory && /\.pdf$/i.test(e.entryName))
    .map((e) => path.posix.basename(e.entryName));
}

// Extrage linkuri de descarcare (pdf/zip/doc sau Joomla ".../file"/"download") + textul lor.
function extractLinks(html, baseUrl) {
  const out = [];
  const seen = new Set();
  const re = /<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const rawHref = m[1];
    if (/^(#|javascript:|mailto:)/i.test(rawHref)) continue;
    const looksFile = /\.(pdf|zip|doc|docx)($|\?)/i.test(rawHref) || /\/file(\/|$|\?)/i.test(rawHref) || /download/i.test(rawHref);
    if (!looksFile) continue;
    let href;
    try { href = new URL(rawHref, baseUrl).href; } catch { continue; }
    if (seen.has(href)) continue;
    seen.add(href);
    const label = stripTags(m[2]).slice(0, 140) || baseName(href);
    out.push({ href, label });
  }
  return out;
}

// Lista de elemente selectabile dintr-un link (fara a descarca tot).
async function listSelectable(url) {
  const res = await fetchResource(url);

  // fisier direct (pdf/zip servit fara extensie in URL)
  if (isPdf(res.contentType, res.finalUrl)) {
    const name = nameFromDisposition(res.disposition, baseName(res.finalUrl) || 'subiect.pdf');
    const items = [{ id: 'f0', label: name, kind: 'file' }];
    return { source: url, items, _resolve: { f0: { kind: 'file', name, bytes: res.buffer } } };
  }
  if (isZip(res.contentType, res.finalUrl, res.disposition)) {
    const names = zipEntries(res.buffer);
    const items = names.map((n, i) => ({ id: `z${i}`, label: n, kind: 'file' }));
    const _resolve = {};
    const zip = new AdmZip(res.buffer);
    names.forEach((n, i) => {
      const entry = zip.getEntries().find((e) => path.posix.basename(e.entryName) === n);
      _resolve[`z${i}`] = { kind: 'file', name: n, bytes: entry.getData() };
    });
    return { source: url, items, _resolve };
  }

  // pagina HTML -> linkuri de descarcare
  const html = res.buffer.toString('utf8');
  const effBase = baseHref(html, res.finalUrl);
  let links = extractLinks(html, effBase);
  // scoate butoanele bulk / non-fisier
  links = links.filter((l) => !/download selected|selectate|select all|adaug/i.test(l.label));

  const items = [];
  const _resolve = {};
  await Promise.all(
    links.slice(0, 30).map(async (l, i) => {
      let label = l.label;
      // daca linkul nu are extensie de fisier in URL, ia numele real din Content-Disposition
      if (!/\.(pdf|zip|docx?)($|\?)/i.test(l.href)) {
        const real = await resolveName(l.href);
        if (real) label = real;
      }
      const kind = /\.zip($|\?)/i.test(l.href) || /\.zip$/i.test(label) ? 'zip' : 'file';
      const id = `l${i}`;
      items[i] = { id, label, kind };
      _resolve[id] = { kind, href: l.href, label };
    }),
  );

  // sub-pagini de continut (liste pe ani/sesiuni) — se urmaresc la materializare
  extractSubPages(html, effBase).slice(0, 40).forEach((s, i) => {
    const id = `p${i}`;
    items.push({ id, label: s.label, kind: 'page' });
    _resolve[id] = { kind: 'page', href: s.href, label: s.label };
  });

  // Grila de variante randata prin JS: putine PDF-uri directe -> enumeram dupa pattern-ul URL.
  const pdfLinks = links.filter((l) => /\.pdf(\?|$)/i.test(l.href));
  if (pdfLinks.length && pdfLinks.length <= 3) {
    const enumd = enumerateVariants(pdfLinks);
    if (enumd) {
      const existing = new Set(links.map((l) => l.href));
      enumd.forEach((v, i) => {
        if (existing.has(v.url)) return;
        const id = `v${i}`;
        items.push({ id, label: `Varianta ${v.num}`, kind: 'file' });
        _resolve[id] = { kind: 'file', href: v.url, label: `Varianta ${v.num}`, tolerant: true };
      });
    }
  }

  return { source: url, items: items.filter(Boolean), _resolve };
}

// Sub-pagini de continut (ex: liste pe ani) — linkuri mai adanci, non-fisier.
const NAV_JUNK = /(wp-|\/feed|\/category|\/tag\/|\/author|\/page\/|xmlrpc|\/comment|\/login|\/cart|\/cos|\/contact|\/despre|privacy|cookie|\/wp-json|\/account|\/abonament)/i;
const CONTENT_HINT = /(19|20)\d{2}|\bbac\b|variant|model|subiect|barem|simular|sesiun|teste/i;

function extractSubPages(html, baseUrl) {
  let base;
  try { base = new URL(baseUrl); } catch { return []; }
  const basePath = base.pathname.replace(/\/+$/, '');
  const out = [];
  const seen = new Set();
  const re = /<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const raw = m[1];
    if (/^(#|javascript:|mailto:|tel:)/i.test(raw)) continue;
    if (/\.(pdf|zip|docx?|png|jpe?g|gif|svg|css|js|ico|webp)($|\?)/i.test(raw) || /\/file(\/|$|\?)/i.test(raw)) continue;
    let u;
    try { u = new URL(raw, baseUrl); } catch { continue; }
    if (u.host !== base.host) continue;
    if (NAV_JUNK.test(u.pathname)) continue;
    const p = u.pathname.replace(/\/+$/, '');
    if (!p || p === basePath) continue; // radacina goala / pagina curenta
    const text = stripTags(m[2]).slice(0, 100);
    // sub-pagina = mai adanca decat pagina curenta SAU link de continut (an/bac/variante) oriunde
    const deeper = p.startsWith(`${basePath}/`) && p.length > basePath.length + 1;
    if (!deeper && !CONTENT_HINT.test(`${text} ${p}`)) continue;
    const seg = p.split('/').filter(Boolean).pop() || '';
    // eticheta: textul daca e informativ (are an/bac), altfel segmentul din URL
    const label = /(19|20)\d{2}|bac|variant|model/i.test(text) ? text : (seg || text || baseName(u.href));
    if (seen.has(u.href)) continue;
    seen.add(u.href);
    out.push({ href: u.href, label });
  }
  return out;
}

// Descarca/extrage efectiv doar elementele alese (dupa id).
async function materialize(sel, ids) {
  const files = [];
  for (const id of ids) {
    const r = sel._resolve[id];
    if (!r) continue;
    if (r.kind === 'file' && r.bytes) {
      files.push({ name: r.name, getBytes: async () => r.bytes });
    } else if (r.kind === 'file' && r.href) {
      try {
        const res = await fetchResource(r.href);
        const name = nameFromDisposition(res.disposition, baseName(res.finalUrl) || `${r.label}.pdf`);
        // enumerare: site-ul poate da pagina de eroare cu 200 -> pastreaza doar daca e chiar PDF
        if (r.tolerant && !(res.contentType.includes('pdf') || /\.pdf$/i.test(name))) continue;
        files.push({ name, getBytes: async () => res.buffer });
      } catch (e) {
        if (!r.tolerant) throw e; // enumerare: sarim peste variantele care dau 404
      }
    } else if (r.kind === 'zip' && r.href) {
      const res = await fetchResource(r.href);
      const zip = new AdmZip(res.buffer);
      for (const e of zip.getEntries()) {
        if (e.isDirectory || !/\.pdf$/i.test(e.entryName)) continue;
        files.push({ name: path.posix.basename(e.entryName), getBytes: async () => e.getData() });
      }
    } else if (r.kind === 'page' && r.href) {
      // urmareste sub-pagina si ia fisierele de descarcat de acolo
      if (files.length >= 120) continue;
      const pr = await fetchResource(r.href);
      const phtml = pr.buffer.toString('utf8');
      const plinks = extractLinks(phtml, baseHref(phtml, pr.finalUrl)).filter((l) => !/download selected|selectate|select all|adaug/i.test(l.label));
      for (const l of plinks.slice(0, 20)) {
        if (files.length >= 120) break;
        try {
          const rr = await fetchResource(l.href);
          if (!(rr.contentType.includes('pdf') || /\.pdf$/i.test(l.href))) continue;
          const name = nameFromDisposition(rr.disposition, baseName(rr.finalUrl) || `${l.label}.pdf`);
          files.push({ name, getBytes: async () => rr.buffer });
        } catch { /* sari peste fisierele care dau 404 */ }
      }
    }
  }
  return files;
}

// ── compat CLI: gatherFiles (parseFilename) ─────────────────────────────
function zipToFiles(zipBuffer, sourceUrl) {
  const zip = new AdmZip(zipBuffer);
  return zip.getEntries()
    .filter((e) => !e.isDirectory && /\.pdf$/i.test(e.entryName))
    .map((e) => ({ name: path.posix.basename(e.entryName), getBytes: async () => zip.getEntry(e.entryName).getData(), sourceUrl }));
}
async function fetchBuffer(url) { return (await fetchResource(url)).buffer; }
async function gatherFiles(startUrl, subjectSlug) {
  const res = await fetchResource(startUrl);
  if (isZip(res.contentType, res.finalUrl, res.disposition)) return { files: zipToFiles(res.buffer, startUrl), source: startUrl };
  if (isPdf(res.contentType, res.finalUrl)) {
    const name = nameFromDisposition(res.disposition, baseName(res.finalUrl));
    return { files: [{ name, getBytes: async () => res.buffer, sourceUrl: startUrl }], source: startUrl };
  }
  const html = res.buffer.toString('utf8');
  const links = extractLinks(html, baseHref(html, res.finalUrl));
  const key = { matematica: 'matematica', informatica: 'informatica', fizica: 'fizica', romana: 'romana' }[subjectSlug] || subjectSlug || '';
  const zipLinks = links.filter((l) => /\.zip($|\?)/i.test(l.href));
  const pdfLinks = links.filter((l) => !/\.zip($|\?)/i.test(l.href));
  if (zipLinks.length) {
    const picks = key ? zipLinks.filter((l) => normalize(l.href).includes(key)) : zipLinks;
    if (key && !picks.length) throw new Error(`Nu am gasit arhiva ZIP pentru "${subjectSlug}" la ${startUrl}.`);
    let files = [];
    for (const l of picks) files = files.concat(zipToFiles((await fetchResource(l.href)).buffer, l.href));
    return { files, source: picks.map((l) => l.href).join(', ') };
  }
  if (pdfLinks.length) {
    const files = [];
    for (const l of pdfLinks) {
      const rr = await fetchResource(l.href);
      files.push({ name: nameFromDisposition(rr.disposition, baseName(rr.finalUrl)), getBytes: async () => rr.buffer, sourceUrl: l.href });
    }
    return { files, source: startUrl };
  }
  throw new Error(`Niciun fisier gasit la ${startUrl}.`);
}

module.exports = { listSelectable, materialize, gatherFiles, fetchBuffer, extractLinks, nameFromDisposition };
