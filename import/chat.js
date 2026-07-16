'use strict';

// Selectie in 2 etape:
//   COARSE (coarsePick, determinist, ieftin): ce ZIP-uri/fisiere aducem, dupa MATERIE/an.
//   FINE   (aiRefine, Gemini pe fisierele REALE): intelege profil / subiect-barem / limita,
//          din limbaj natural, si da un raspuns conversational. Fallback determinist.

const { PROFILES } = require('./parseFilename');

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ă/g, 'a').replace(/â/g, 'a').replace(/î/g, 'i')
    .replace(/ș|ş/g, 's').replace(/ț|ţ/g, 't');
}

const SUBJECT_KEYS = {
  matematica: ['matematica', 'mate-info', 'mate '], informatica: ['informatica', 'info'],
  fizica: ['fizica'], romana: ['romana', 'limba romana', 'literatura'],
};

// ── COARSE: ce elemente aducem (dupa materie/an) ─────────────
function coarsePick(items, message) {
  const q = normalize(message);
  const year = (q.match(/((?:19|20)\d{2})/) || [])[1];
  const wantAll = /\b(toate|tot|toti|all)\b/.test(q);
  const subjWanted = Object.entries(SUBJECT_KEYS)
    .filter(([, keys]) => keys.some((k) => q.includes(k)))
    .map(([slug]) => slug);

  const picked = items.filter((it) => {
    const l = normalize(it.label);
    if (it.kind === 'page') {
      // paginile sunt containere (materia e INAUNTRU) -> filtreaza doar pe an; AI-ul cauta dupa ce intra
      return !year || l.includes(year);
    }
    if (year && !l.includes(year)) return false;
    if (subjWanted.length && !subjWanted.some((s) => SUBJECT_KEYS[s].some((k) => l.includes(k)))) return false;
    return true;
  });
  // fara potrivire: daca sunt putine elemente (pagina cu fisiere directe) le luam pe toate;
  // altfel (multe arhive) cerem sa specifice materia.
  const finalItems = picked.length ? picked : (wantAll || items.length <= 4 ? items : []);
  return finalItems.map((it) => it.id);
}

// sinonime uzuale ca fallback-ul sa „inteleaga" mai mult limbaj natural
const PROFILE_SYNONYMS = {
  // "real" = profilul real = mate-info + st-nat (ambele stiintifice)
  'mate-info': ['mate-info', 'mate info', 'matematica-informatica', 'matematica informatica', 'mate/info', 'real'],
  'st-nat': ['st-nat', 'st nat', 'stiinte', 'stiintele naturii', 'stiinte ale naturii', 'real'],
  tehnologic: ['tehnologic', 'tehnic'],
  pedagogic: ['pedagogic', 'pedagog'],
  // la FIZICA "real" = profilul teoretic (nu tehnologic)
  real: ['real', 'teoretic', 'teoretica'],
  uman: ['uman', 'umanist', 'umanistic'],
};

// Profilul e scris diferit in nume de la o materie la alta:
//   fizica: "real" apare ca "teoretic"; romana: "real"/"uman" apar ca atare
//   (grija: la romana exista si "teoretic_umanist", deci NU folosim "teoretic" pt real aici).
const SPEC_TOKENS = {
  fizica: { real: ['teoretic', 'real'], tehnologic: ['tehnologic', 'tehnic'] },
  romana: { real: ['real'], uman: ['uman', 'umanist'] },
};
function specSynonyms(subject, spec) {
  if (!spec) return null;
  const bySubj = SPEC_TOKENS[subject];
  if (bySubj && bySubj[spec]) return bySubj[spec];
  return PROFILE_SYNONYMS[spec] || [spec];
}

// limbaj de programare cerut (informatica): C/C++ vs Pascal
function langFromQuery(q) {
  if (/\bpascal\b/.test(q)) return 'pascal';
  if (/c\/?c?\+\+|\bcpp\b|limbaj(ul)?\s+c\b|\b(in|pe|cu)\s+c\b/.test(q)) return 'c';
  return null;
}
// limbajul unui fisier de informatica din numele lui (baremul n-are limbaj -> null)
function langOfMaterial(m) {
  if (m.subject !== 'informatica') return null;
  const n = normalize(m.file_name || '');
  if (/pascal/.test(n)) return 'pascal';
  if (/_c_|_cpp|c\+\+/.test(n)) return 'c';
  return null;
}

// ── FINE determinist (fallback) ──────────────────────────────
function refineByMessage(materials, message) {
  const q = normalize(message);

  const profWanted = PROFILES.filter((p) => (PROFILE_SYNONYMS[p] || [p]).some((s) => q.includes(s)));
  const langWanted = langFromQuery(q);

  let onlySubiecte = /(doar|numai)\s+subiect|fara\s+barem|fara\s+rezolvar/.test(q);
  let onlyBareme = /(doar|numai)\s+(barem|rezolvar|solut|raspuns)|\b(baremele|rezolvarile|solutiile)\b/.test(q);

  let limit = 0;
  if (/\b(un singur|unul|o singura|doar un|doar unul|un model|o varianta)\b/.test(q)) limit = 1;
  const lim = q.match(/primele\s+(\d+)\s*(subiect|barem|model|fisier|variant)?|\b(\d+)\s+(subiect|barem|model|fisier|variant)/);
  if (lim) {
    limit = Number(lim[1] || lim[3]) || limit;
    const noun = lim[2] || lim[4] || '';
    if (/subiect/.test(noun)) onlySubiecte = true;
    else if (/barem/.test(noun)) onlyBareme = true;
  }

  let out = materials.filter((m) => {
    const l = normalize(`${m.file_name || ''} ${m.profil || ''}`);
    if (profWanted.length && !profWanted.some((p) => l.includes(p))) return false;
    // limbaj: exclude subiectele in alt limbaj; baremul (fara limbaj) ramane, se leaga de subiect
    if (langWanted) {
      const ml = langOfMaterial(m);
      if (ml && ml !== langWanted) return false;
    }
    if (onlySubiecte && m.tip === 'barem') return false;
    if (onlyBareme && m.tip !== 'barem') return false;
    return true;
  });
  if (limit > 0 && limit < 200) out = out.slice(0, limit);
  return out;
}

// Cererea are criterii clare (limbaj / specializare / doar-subiecte-bareme / limita)?
// Atunci filtram DETERMINIST — sigur, previzibil, fara sa depinda de cota AI.
function hasStructuredFilters(q) {
  if (langFromQuery(q)) return true;
  if (PROFILES.some((p) => (PROFILE_SYNONYMS[p] || [p]).some((s) => q.includes(s)))) return true;
  if (/(doar|numai)\s+(subiect|barem|rezolvar|solut)/.test(q)) return true;
  if (/\b(subiecte(le)?|bareme(le)?|rezolvarile|solutiile)\b/.test(q)) return true;
  if (/primele\s+\d+|\b\d+\s+(subiect|barem|model|fisier|variant)/.test(q)) return true;
  return false;
}

function replyFor(chosen) {
  const s = chosen.filter((m) => m.tip === 'subiect').length;
  const b = chosen.length - s;
  if (!chosen.length) return 'Nu am găsit fișiere care să se potrivească exact.';
  const parts = [s ? `${s} subiecte` : '', b ? `${b} bareme` : ''].filter(Boolean);
  return `Am ales exact ce ai cerut: ${parts.join(' + ')}`;
}

// ── FILTRARE STRUCTURATA: din butoanele barei (materie/an/specializare/limbaj/tip) ──
// Determinist 100%, fara AI. f = { subject, year, specializare, limbaj, tip }
function filterByStructured(materials, f) {
  f = f || {};
  const langWanted = f.limbaj ? (/pascal/i.test(f.limbaj) ? 'pascal' : 'c') : null;
  const syns = specSynonyms(f.subject, f.specializare);
  const yearW = f.year ? String(f.year) : null; // gol => toti anii
  const tip = f.tip || 'ambele';
  return materials.filter((m) => {
    if (f.subject && m.subject && m.subject !== f.subject) return false;
    if (yearW && String(m.year || '') !== yearW) return false;
    if (syns) {
      const l = normalize(`${m.file_name || ''} ${m.profil || ''}`);
      if (!syns.some((s) => l.includes(s))) return false;
    }
    if (langWanted) {
      const ml = langOfMaterial(m); // baremul (fara limbaj) => null => trece, ca sa se lege
      if (ml && ml !== langWanted) return false;
    }
    if (tip === 'subiecte' && m.tip === 'barem') return false;
    if (tip === 'bareme' && m.tip !== 'barem') return false;
    return true;
  });
}

// ── FINE cu AI: Gemini alege din fisierele reale + reply ─────
async function aiRefine(materials, message, history) {
  const q = normalize(message);
  if (hasStructuredFilters(q)) {
    const chosen = refineByMessage(materials, message);
    return { reply: replyFor(chosen), chosen };
  }
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('fara cheie');
    const { GoogleGenAI } = require('@google/genai');
    const ai = new GoogleGenAI({ apiKey });

    const lista = materials.map((m, i) => `${i}: [${m.tip}] ${m.title}`).join('\n');
    const sys =
      'Esti asistentul unui profesor care importa subiecte de BAC. Ai o lista numerotata de fisiere (index: [subiect|barem] descriere). ' +
      'Alege indecsii care se potrivesc cererii profesorului, INTELEGAND limbajul natural: profiluri/specializari ' +
      '(mate-info = Mate-Info; st-nat = Stiintele naturii; "profilul real" = mate-info SI st-nat impreuna; tehnologic; pedagogic), subiect vs barem (rezolvari), ' +
      'cantitati ("primele 2", "doar unul"), ani ("din toti anii"/"toate" = NU filtra dupa an). ' +
      'La informatica titlurile arata limbajul: C/C++ sau Pascal. Daca profesorul cere C/C++, alege DOAR subiectele C/C++ (nu cele Pascal); daca cere Pascal, invers. ' +
      'ATENTIE: baremele NU au limbaj in titlu (sunt comune) — cand ceri un limbaj, INCLUDE si baremele variantelor alese, ca sa se lege de subiect. ' +
      'Alege TOATE fisierele care se potrivesc exact cererii (nu limita numarul daca profesorul nu cere o limita). ' +
      'Raspunde DOAR cu JSON: {"reply":"o propozitie prietenoasa in romana despre ce ai ales", "idx":[numere]}.';
    const hist = (history || []).slice(-6).map((h) => `${h.role}: ${h.content}`).join('\n');
    const contents = `FISIERE:\n${lista}\n\nISTORIC:\n${hist}\n\nMESAJ: "${message}"`;
    const config = { systemInstruction: sys, maxOutputTokens: 1024, responseMimeType: 'application/json' };

    // aliasurile "latest" au cota separata de modelele fixe (des epuizate pe planul gratuit)
    const models = ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-2.5-flash-lite'];
    let result, lastErr;
    for (const model of models) {
      try { result = await ai.models.generateContent({ model, contents, config }); break; }
      catch (e) { lastErr = e; }
    }
    if (!result) throw lastErr;

    const parsed = JSON.parse(result.text || '{}');
    const idx = (Array.isArray(parsed.idx) ? parsed.idx : [])
      .map(Number)
      .filter((i) => Number.isInteger(i) && i >= 0 && i < materials.length);
    if (!idx.length) throw new Error('gemini n-a ales nimic');
    return { reply: parsed.reply || '', chosen: idx.map((i) => materials[i]) };
  } catch (_) {
    return { reply: '', chosen: refineByMessage(materials, message) };
  }
}

module.exports = { coarsePick, refineByMessage, aiRefine, filterByStructured };
