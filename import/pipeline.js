'use strict';

// Filtrare + sortare + mapare la randuri `materials`.

// Pastreaza fisierele care se potrivesc filtrului dedus din instructiune.
function filterFiles(parsedList, filter) {
  const f = filter || {};
  return parsedList.filter((p) => {
    if (!p) return false;
    if (f.an && p.an && p.an !== f.an) return false;
    if (f.sesiune && p.sesiune && p.sesiune.toLowerCase() !== String(f.sesiune).toLowerCase()) return false;
    if (f.materie && p.materieSlug !== f.materie) return false;
    if (f.includeBareme === false && p.tip === 'barem') return false;
    if (Array.isArray(f.profiluri) && f.profiluri.length && p.profil && !f.profiluri.includes(p.profil)) return false;
    return true;
  });
}

// Ordoneaza subiect-inainte-de-barem pe fiecare (an, materie, profil):
// rezulta subiect, barem, subiect, barem...
function sortPairs(list) {
  const tipRank = (t) => (t === 'subiect' ? 0 : 1);
  return [...list].sort((a, b) => {
    return (
      (a.an || 0) - (b.an || 0) ||
      String(a.materieSlug).localeCompare(String(b.materieSlug)) ||
      String(a.profil || '').localeCompare(String(b.profil || '')) ||
      tipRank(a.tip) - tipRank(b.tip)
    );
  });
}

// Un fisier -> un rand `materials` (subiectul si baremul = randuri separate).
function mapToMaterial(p, { fileUrl } = {}) {
  const bits = ['Model BAC', p.materie, p.an, p.profil ? `— ${p.profil}` : '', `(${p.tip})`].filter(Boolean);
  return {
    title: bits.join(' ').replace(/\s+/g, ' ').trim(),
    subject: p.materieSlug,
    category: 'bac_model',
    year: p.an ?? null,
    file_name: p.fileName,
    study_classes: p.profil ? [p.profil] : [],
    description: `Model oficial BAC — ${p.tip}${p.profil ? `, profil ${p.profil}` : ''}. Sursă: subiecte.edu.ro`,
    file_url: fileUrl || null,
    // camp informativ (nu e coloana in DB), pastrat pt dry-run:
    _tip: p.tip,
  };
}

module.exports = { filterFiles, sortPairs, mapToMaterial };
