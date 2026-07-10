'use strict';

// Acces la o sursa oficiala, dintr-un link ARBITRAR:
//   - un .zip direct (ex. arhiva de modele per materie)
//   - un .pdf direct
//   - o pagina-index care listeaza .pdf-uri directe SAU .zip-uri per materie
// Returneaza fisiere candidate uniforme: { name, getBytes(), sourceUrl }.

const path = require('path');
const AdmZip = require('adm-zip');

const UA = 'Mozilla/5.0 (SmartLearning import bot)';

// cuvant-cheie din numele ZIP-ului, pe materie (ca sa alegem arhiva corecta)
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

function uniq(arr) {
  return [...new Set(arr)];
}

function baseName(u) {
  try {
    return decodeURIComponent(path.posix.basename(new URL(u).pathname));
  } catch {
    return decodeURIComponent(path.posix.basename(u));
  }
}

function directFile(url) {
  return { name: baseName(url), getBytes: () => fetchBuffer(url), sourceUrl: url };
}

function zipToFiles(zipBuffer, sourceUrl) {
  const zip = new AdmZip(zipBuffer);
  return zip
    .getEntries()
    .filter((e) => !e.isDirectory && /\.pdf$/i.test(e.entryName))
    .map((e) => ({
      name: path.posix.basename(e.entryName),
      getBytes: async () => zip.getEntry(e.entryName).getData(),
      sourceUrl,
    }));
}

// Aduna fisierele candidate dintr-un link arbitrar.
async function gatherFiles(startUrl, subjectSlug) {
  // 1) .zip direct
  if (/\.zip($|\?)/i.test(startUrl)) {
    const buf = await fetchBuffer(startUrl);
    return { files: zipToFiles(buf, startUrl), source: startUrl };
  }
  // 2) .pdf direct
  if (/\.pdf($|\?)/i.test(startUrl)) {
    return { files: [directFile(startUrl)], source: startUrl };
  }

  // 3) pagina-index: cauta .pdf-uri directe si .zip-uri
  const html = await fetchText(startUrl);
  const pdfLinks = uniq([...html.matchAll(/href="([^"]+\.pdf)"/gi)].map((m) => m[1]));
  const zipLinks = uniq([...html.matchAll(/href="([^"]+\.zip)"/gi)].map((m) => m[1]));

  if (pdfLinks.length) {
    return {
      files: pdfLinks.map((h) => directFile(new URL(h, startUrl).href)),
      source: startUrl,
    };
  }

  if (zipLinks.length) {
    const key = ZIP_KEYWORD[subjectSlug] || (subjectSlug || '');
    let picks = key ? zipLinks.filter((h) => normalize(h).includes(key)) : zipLinks;
    if (key && !picks.length) {
      throw new Error(`Nu am gasit arhiva ZIP pentru "${subjectSlug}" la ${startUrl} (gasite ${zipLinks.length} ZIP-uri).`);
    }
    let files = [];
    const srcs = [];
    for (const h of picks) {
      const url = new URL(h, startUrl).href;
      const buf = await fetchBuffer(url);
      files = files.concat(zipToFiles(buf, url));
      srcs.push(url);
    }
    return { files, source: srcs.join(', ') };
  }

  throw new Error(`Niciun .pdf sau .zip gasit la ${startUrl}.`);
}

module.exports = { gatherFiles, fetchBuffer };
