'use strict';

// SCRIERE REALA in Supabase (storage + tabel `materials`).
// Triplu blocaj intentionat: --write + --confirm + IMPORT_ALLOW_PROD_WRITE=yes.
// Pana la validarea dry-run, NU trebuie rulata.

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const BUCKET = 'materials';

async function uploadPdf(bytes, destPath) {
  const url = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodeURI(destPath)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/pdf',
      'x-upsert': 'false',
    },
    body: bytes,
  });
  if (!r.ok) throw new Error(`upload ${destPath} -> ${r.status} ${await r.text()}`);
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${destPath}`;
}

async function insertMaterial(row) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/materials`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`insert -> ${r.status} ${await r.text()}`);
  return r.json();
}

async function writeMaterials(rows) {
  if (process.env.IMPORT_ALLOW_PROD_WRITE !== 'yes') {
    throw new Error('Scriere reala blocata. Seteaza IMPORT_ALLOW_PROD_WRITE=yes (in plus fata de --write --confirm).');
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY lipsesc');

  const inserted = [];
  for (const row of rows) {
    const bytes = await row._getBytes();
    const destPath = `bac_model/${row.subject}/${row.file_name}`;
    const publicUrl = await uploadPdf(bytes, destPath);

    const { _tip, _getBytes, ...clean } = row; // campuri ne-DB
    clean.file_url = publicUrl;
    clean.file_type = 'application/pdf';
    clean.file_size = bytes.length;

    const res = await insertMaterial(clean);
    inserted.push(res);
    console.error(`[scris] ${row.file_name}`);
  }
  console.error(`[gata] ${inserted.length} materiale inserate.`);
  return inserted;
}

module.exports = { writeMaterials };
