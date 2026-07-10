'use strict';

// CLI import subiecte BAC — DRY-RUN by default (doar descarca local + printeaza JSON).
//
//   node import/index.js <url> "<instructiune>" [optiuni]
//
// Optiuni:
//   --ai        foloseste Gemini pt interpretarea instructiunii (fallback determinist)
//   --out FILE  salveaza planul JSON si in FILE
//   --write --confirm   SCRIERE REALA (upload + insert). DEZACTIVAT implicit; necesita AMBELE.
//
// Exemplu:
//   node import/index.js \
//     "https://subiecte.edu.ro/2026/bacalaureat/modeledesubiecte/probescrise/" \
//     "importa toate modelele de matematica"

const fs = require('fs');
const path = require('path');
const { interpretInstruction } = require('./interpretInstruction');
const { parseFilename } = require('./parseFilename');
const { resolveZipUrl, fetchBuffer, listPdfEntries, extractPdf } = require('./source');
const { filterFiles, sortPairs, mapToMaterial } = require('./pipeline');

const DRY_DIR = path.join(process.cwd(), '_import_dryrun');

function parseArgs(argv) {
  const args = { url: null, instruction: null, ai: false, write: false, confirm: false, out: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ai') args.ai = true;
    else if (a === '--write') args.write = true;
    else if (a === '--confirm') args.confirm = true;
    else if (a === '--out') args.out = argv[++i];
    else rest.push(a);
  }
  args.url = rest[0];
  args.instruction = rest[1];
  return args;
}

async function run(argv) {
  const args = parseArgs(argv);
  if (!args.url || !args.instruction) {
    console.error('Utilizare: node import/index.js <url> "<instructiune>" [--ai] [--out FILE] [--write --confirm]');
    process.exit(2);
  }

  const isWrite = args.write && args.confirm;
  console.error(`\n[mod] ${isWrite ? 'SCRIERE REALA' : 'DRY-RUN (fara scriere in DB/storage)'}`);

  // 1) Interpreteaza instructiunea -> filtru
  const filter = await interpretInstruction(args.instruction, { useAI: args.ai });
  console.error('[filtru]', JSON.stringify(filter));

  // 2) Gaseste + descarca ZIP-ul de modele
  const zipUrl = await resolveZipUrl(args.url, filter.materie);
  console.error('[zip]', zipUrl);
  const zipBuffer = await fetchBuffer(zipUrl);

  // 3) Listeaza PDF-urile, deduce metadate, filtreaza, ordoneaza
  const entries = listPdfEntries(zipBuffer);
  const parsed = entries.map((e) => parseFilename(e.name)).filter(Boolean);
  const kept = sortPairs(filterFiles(parsed, filter));

  console.error(`[gasit] ${entries.length} PDF in ZIP -> ${kept.length} potrivite filtrului`);

  // 4) Descarca local (dry-run) + construieste randurile
  fs.mkdirSync(DRY_DIR, { recursive: true });
  const rows = [];
  for (const p of kept) {
    const entry = entries.find((e) => e.name === p.fileName);
    let fileUrl = null;
    if (!isWrite) {
      const { dest } = extractPdf(zipBuffer, entry.entryName, DRY_DIR);
      fileUrl = path.relative(process.cwd(), dest);
    }
    rows.push(mapToMaterial(p, { fileUrl }));
  }

  // 5) Raport
  const subiecte = rows.filter((r) => r._tip === 'subiect').length;
  const bareme = rows.filter((r) => r._tip === 'barem').length;
  const report = {
    mode: isWrite ? 'write' : 'dry-run',
    source: zipUrl,
    filter,
    summary: { pdfInZip: entries.length, matched: rows.length, subiecte, bareme },
    materials: rows,
  };
  const json = JSON.stringify(report, null, 2);
  console.log(json);
  if (args.out) fs.writeFileSync(args.out, json);
  fs.writeFileSync(path.join(DRY_DIR, 'plan.json'), json);

  if (isWrite) {
    const { writeMaterials } = require('./write');
    await writeMaterials(rows, zipBuffer, entries);
  } else {
    console.error(`\n[ok] ${rows.length} fisiere descarcate in ${DRY_DIR}/ . NIMIC nu s-a scris in DB/storage.`);
    console.error('     Pentru scriere reala (dupa verificare): adauga --write --confirm.');
  }
  return report;
}

if (require.main === module) {
  run(process.argv.slice(2)).catch((err) => {
    console.error('[eroare]', err.message);
    process.exit(1);
  });
}

module.exports = { run, parseArgs };
