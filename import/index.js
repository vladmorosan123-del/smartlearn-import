'use strict';

// CLI import subiecte BAC — DRY-RUN by default (doar descarca local + printeaza JSON).
//
//   node import/index.js <url> "<instructiune>" [optiuni]
//
// <url> poate fi ORICE link oficial: un .zip, un .pdf, sau o pagina-index
// care listeaza .pdf-uri / .zip-uri.
//
// Optiuni:
//   --ai        foloseste Gemini pt interpretarea instructiunii (fallback determinist)
//   --out FILE  salveaza planul JSON si in FILE
//   --write --confirm   SCRIERE REALA (upload + insert). DEZACTIVAT implicit.

const fs = require('fs');
const path = require('path');
const { interpretInstruction } = require('./interpretInstruction');
const { parseFilename } = require('./parseFilename');
const { gatherFiles } = require('./source');
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

// Nucleul reutilizabil (folosit si de serverul HTTP pentru UI-ul profesorului).
// Returneaza planul; daca dest e dat, extrage PDF-urile acolo.
async function buildPlan(url, instruction, { useAI = false, dest = null } = {}) {
  const filter = await interpretInstruction(instruction, { useAI });
  const { files, source } = await gatherFiles(url, filter.materie);

  const parsed = files
    .map((f) => {
      const p = parseFilename(f.name);
      if (p) p._file = f;
      return p;
    })
    .filter(Boolean);

  const kept = sortPairs(filterFiles(parsed, filter));

  const rows = [];
  for (const p of kept) {
    let fileUrl = null;
    if (dest) {
      fs.mkdirSync(dest, { recursive: true });
      const bytes = await p._file.getBytes();
      const out = path.join(dest, p.fileName);
      fs.writeFileSync(out, bytes);
      fileUrl = path.relative(process.cwd(), out);
    }
    const row = mapToMaterial(p, { fileUrl });
    row._getBytes = p._file.getBytes; // pt scrierea reala (nu se serializeaza)
    rows.push(row);
  }

  const subiecte = rows.filter((r) => r._tip === 'subiect').length;
  const bareme = rows.filter((r) => r._tip === 'barem').length;
  return {
    source,
    filter,
    summary: { candidate: files.length, matched: rows.length, subiecte, bareme },
    materials: rows,
  };
}

async function run(argv) {
  const args = parseArgs(argv);
  if (!args.url || !args.instruction) {
    console.error('Utilizare: node import/index.js <url> "<instructiune>" [--ai] [--out FILE] [--write --confirm]');
    process.exit(2);
  }

  const isWrite = args.write && args.confirm;
  console.error(`\n[mod] ${isWrite ? 'SCRIERE REALA' : 'DRY-RUN (fara scriere in DB/storage)'}`);

  const plan = await buildPlan(args.url, args.instruction, {
    useAI: args.ai,
    dest: isWrite ? null : DRY_DIR,
  });
  console.error('[filtru]', JSON.stringify(plan.filter));
  console.error('[sursa]', plan.source);
  console.error(`[gasit] ${plan.summary.candidate} candidate -> ${plan.summary.matched} potrivite`);

  const report = {
    mode: isWrite ? 'write' : 'dry-run',
    source: plan.source,
    filter: plan.filter,
    summary: plan.summary,
    materials: plan.materials.map(({ _getBytes, ...r }) => r),
  };
  const json = JSON.stringify(report, null, 2);
  console.log(json);
  if (args.out) fs.writeFileSync(args.out, json);
  if (!isWrite) {
    fs.mkdirSync(DRY_DIR, { recursive: true });
    fs.writeFileSync(path.join(DRY_DIR, 'plan.json'), json);
  }

  if (isWrite) {
    const { writeMaterials } = require('./write');
    await writeMaterials(plan.materials);
  } else {
    console.error(`\n[ok] ${report.summary.matched} fisiere descarcate in ${DRY_DIR}/ . NIMIC nu s-a scris in DB/storage.`);
    console.error('     Pentru scriere reala (dupa verificare): --write --confirm + IMPORT_ALLOW_PROD_WRITE=yes');
  }
  return report;
}

if (require.main === module) {
  run(process.argv.slice(2)).catch((err) => {
    console.error('[eroare]', err.message);
    process.exit(1);
  });
}

module.exports = { run, parseArgs, buildPlan };
