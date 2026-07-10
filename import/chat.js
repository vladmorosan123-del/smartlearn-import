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
  'mate-info': ['mate-info', 'mate info', 'matematica-informatica', 'matematica informatica', 'mate/info'],
  'st-nat': ['st-nat', 'st nat', 'stiinte', 'stiintele naturii', 'stiinte ale naturii', 'real'],
  tehnologic: ['tehnologic', 'tehnic'],
  pedagogic: ['pedagogic', 'pedagog'],
};

// ── FINE determinist (fallback) ──────────────────────────────
function refineByMessage(materials, message) {
  const q = normalize(message);

  const profWanted = PROFILES.filter((p) => (PROFILE_SYNONYMS[p] || [p]).some((s) => q.includes(s)));

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
    if (onlySubiecte && m.tip === 'barem') return false;
    if (onlyBareme && m.tip !== 'barem') return false;
    return true;
  });
  if (limit > 0 && limit < 200) out = out.slice(0, limit);
  return out;
}

// ── FINE cu AI: Gemini alege din fisierele reale + reply ─────
async function aiRefine(materials, message, history) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('fara cheie');
    const { GoogleGenAI } = require('@google/genai');
    const ai = new GoogleGenAI({ apiKey });

    const lista = materials.map((m, i) => `${i}: ${m.title}`).join('\n');
    const sys =
      'Esti asistentul unui profesor care importa subiecte de BAC. Ai o lista numerotata de fisiere (index: descriere). ' +
      'Alege indecsii care se potrivesc cererii profesorului, INTELEGAND limbajul natural: profiluri ' +
      '(mate-info, st-nat = stiintele naturii / "real", tehnologic, pedagogic), subiect vs barem (rezolvari), ' +
      'cantitati ("primele 2", "doar unul"). Daca cere "toate", alege tot. ' +
      'Raspunde DOAR cu JSON: {"reply":"o propozitie prietenoasa in romana despre ce ai ales", "idx":[numere]}.';
    const hist = (history || []).slice(-6).map((h) => `${h.role}: ${h.content}`).join('\n');
    const contents = `FISIERE:\n${lista}\n\nISTORIC:\n${hist}\n\nMESAJ: "${message}"`;
    const config = { systemInstruction: sys, maxOutputTokens: 1024, responseMimeType: 'application/json' };

    const models = ['gemini-2.5-flash-lite', 'gemini-2.5-flash'];
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

module.exports = { coarsePick, refineByMessage, aiRefine };
