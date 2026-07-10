'use strict';

// Deduce metadatele unui subiect/barem din numele fisierului.
// Suporta doua conventii:
//   Oficial (subiecte.edu.ro):  E_c_matematica_M_mate-info_2026_var_model.pdf
//   Etichete (arhivabac):       2019_Matematica_SM_M_mate-info_Model_Subiect
//
// Returneaza: { an, materie, materieSlug, profil, sesiune, tip, fileName }
// sau null daca nu recunoaste un subiect/barem.

const SUBJECTS = [
  { slug: 'matematica', label: 'Matematică', keys: ['matematica', 'matematică'] },
  { slug: 'informatica', label: 'Informatică', keys: ['informatica', 'informatică'] },
  { slug: 'fizica', label: 'Fizică', keys: ['fizica', 'fizică'] },
  { slug: 'romana', label: 'Limba și literatura română', keys: ['limba_si_literatura_romana', 'literatura_romana', 'romana', 'română'] },
];

const PROFILES = ['mate-info', 'st-nat', 'tehnologic', 'pedagogic'];

function stripExt(name) {
  return String(name || '').replace(/\.[a-z0-9]+$/i, '');
}

// numele afisat = fara extensie, fara diacritice pt potrivire
function normalize(s) {
  return s
    .toLowerCase()
    .replace(/ă/g, 'a').replace(/â/g, 'a').replace(/î/g, 'i')
    .replace(/ș|ş/g, 's').replace(/ț|ţ/g, 't');
}

function detectMaterie(norm) {
  for (const s of SUBJECTS) {
    if (s.keys.some((k) => norm.includes(normalize(k)))) return s;
  }
  return null;
}

function detectProfil(norm) {
  return PROFILES.find((p) => norm.includes(p)) || null;
}

// subiect = "var"/"subiect"/"varianta"; barem = "bar"/"barem"
function detectTip(norm) {
  if (/(^|[_\- ])(bar|barem)([_\- ]|$)/.test(norm)) return 'barem';
  if (/(^|[_\- ])(var|varianta|subiect)([_\- ]|$)/.test(norm)) return 'subiect';
  return null;
}

function detectAn(norm) {
  const m = norm.match(/(?:^|[_\- ])((?:19|20)\d{2})(?:[_\- ]|$)/);
  return m ? Number(m[1]) : null;
}

function detectSesiune(norm) {
  if (/model/.test(norm)) return 'Model';
  if (/simular/.test(norm)) return 'Simulare';
  if (/toamn/.test(norm)) return 'Toamnă';
  if (/iuni|iulie|var(a|ă)/.test(norm)) return 'Iunie';
  return null;
}

function parseFilename(fileName) {
  const base = stripExt(fileName);
  const norm = normalize(base);

  const materie = detectMaterie(norm);
  const tip = detectTip(norm);
  // Un subiect/barem valid are cel putin materie + tip.
  if (!materie || !tip) return null;

  return {
    an: detectAn(norm),
    materie: materie.label,
    materieSlug: materie.slug,
    profil: detectProfil(norm),
    sesiune: detectSesiune(norm),
    tip,
    fileName,
  };
}

module.exports = { parseFilename, SUBJECTS, PROFILES };
