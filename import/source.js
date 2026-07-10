'use strict';

// Acces la sursa oficiala (subiecte.edu.ro): modelele de subiecte sunt
// impachetate ca ZIP per materie (ex. Bac_2026_E_c_Matematica_modele.zip).
// Aici: gaseste ZIP-ul potrivit, il descarca si listeaza / extrage PDF-urile.

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const UA = 'Mozilla/5.0 (SmartLearning import bot)';

// Cuvantul-cheie din numele ZIP-ului, pe materie.
const ZIP_KEYWORD = {
  matematica: 'matematica',
  informatica: 'informatica',
  fizica: 'fizica',
  romana: 'romana',
};

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ă/g, 'a').replace(/â/g, 'a').replace(/î/g, 'i')
    .replace(/ș|ş/g, 's').replace(/ț|ţ/g, 't');
}

async function fetchText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.text();
}

async function fetchBuffer(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// Din pagina-index gaseste ZIP-ul de modele pentru materia ceruta.
async function resolveZipUrl(startUrl, subjectSlug) {
  if (/\.zip($|\?)/i.test(startUrl)) return startUrl;

  const html = await fetchText(startUrl);
  const hrefs = [...html.matchAll(/href="([^"]+\.zip)"/gi)].map((m) => m[1]);
  const key = ZIP_KEYWORD[subjectSlug] || subjectSlug || '';
  const wantModel = (h) => /model/.test(normalize(h));

  // preferam ZIP-ul care contine materia SI "model"
  let hit =
    hrefs.find((h) => normalize(h).includes(key) && wantModel(h)) ||
    hrefs.find((h) => normalize(h).includes(key));

  if (!hit) throw new Error(`Nu am gasit ZIP pentru "${subjectSlug}" in ${startUrl}`);
  return new URL(hit, startUrl).href;
}

function listPdfEntries(zipBuffer) {
  const zip = new AdmZip(zipBuffer);
  return zip
    .getEntries()
    .filter((e) => !e.isDirectory && /\.pdf$/i.test(e.entryName))
    .map((e) => ({ name: path.posix.basename(e.entryName), entryName: e.entryName }));
}

function extractPdf(zipBuffer, entryName, destDir) {
  const zip = new AdmZip(zipBuffer);
  const entry = zip.getEntry(entryName);
  if (!entry) throw new Error(`Lipsa in ZIP: ${entryName}`);
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, path.posix.basename(entryName));
  fs.writeFileSync(dest, entry.getData());
  return { dest, size: entry.header.size };
}

module.exports = { resolveZipUrl, fetchBuffer, listPdfEntries, extractPdf };
