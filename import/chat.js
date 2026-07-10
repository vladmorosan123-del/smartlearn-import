'use strict';

// Selectie in 2 etape:
//   1) chatSelect  -> alege ELEMENTELE de pe pagina (ZIP-uri/fisiere) dupa materie/an
//   2) refineByMessage -> dupa extinderea ZIP-urilor, filtreaza FISIERELE dupa profil/tip/limita
// Gemini pt etapa 1 daca e disponibil; altfel determinist.

const { PROFILES } = require('./parseFilename');

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ă/g, 'a').replace(/â/g, 'a').replace(/î/g, 'i')
    .replace(/ș|ş/g, 's').replace(/ț|ţ/g, 't');
}

const SUBJECT_KEYS = {
  matematica: ['matematica', 'mate-info', 'mate '], informatica: ['informatica'],
  fizica: ['fizica'], romana: ['romana', 'limba romana', 'literatura'],
};

// ── etapa 1: alege elementele (determinist) ──────────────────
function pickDeterministic(items, message) {
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
  const finalItems = picked.length ? picked : (wantAll ? items : picked);
  return { reply: '', ids: finalItems.map((it) => it.id) };
}

async function pickWithGemini(items, message, history) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('fara cheie');
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const lista = items.map((it) => `${it.id}: ${it.label}`).join('\n');
  const sys =
    'Esti asistentul unui profesor care importa subiecte/bareme de BAC. Ai o lista de fisiere/arhive (id: eticheta). ' +
    'Alege id-urile relevante pentru cererea profesorului. Daca cere o materie, alege arhiva/fisierele acelei materii ' +
    '(profilul se filtreaza ulterior, nu exclude arhiva). Raspunde DOAR JSON: {"ids":["id",...]}.';
  const hist = (history || []).slice(-6).map((h) => `${h.role}: ${h.content}`).join('\n');
  const result = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: `LISTA:\n${lista}\n\nISTORIC:\n${hist}\n\nMESAJ: "${message}"`,
    config: { systemInstruction: sys, maxOutputTokens: 1024, responseMimeType: 'application/json' },
  });
  const parsed = JSON.parse(result.text || '{}');
  const valid = new Set(items.map((i) => i.id));
  const ids = (Array.isArray(parsed.ids) ? parsed.ids : []).filter((id) => valid.has(id));
  if (!ids.length) throw new Error('gemini n-a ales nimic');
  return { reply: '', ids };
}

async function chatSelect(items, message, history, { useAI = true } = {}) {
  if (useAI) {
    try { return await pickWithGemini(items, message, history); }
    catch (_) { /* fallback */ }
  }
  return pickDeterministic(items, message);
}

// ── etapa 2: filtreaza fisierele extrase dupa profil / tip / limita ──
function refineByMessage(materials, message) {
  const q = normalize(message);
  const profWanted = PROFILES.filter((p) => q.includes(p));
  let onlySubiecte = /(doar|numai)\s+subiect|fara\s+barem/.test(q);
  let onlyBareme = /(doar|numai)\s+barem/.test(q);

  // "primele N <ceva>" sau "N subiecte/bareme/modele" -> limita (+ tipul, daca e spus)
  let limit = 0;
  const lim = q.match(/primele\s+(\d+)\s*(subiect|barem|model|fisier|variant)?|\b(\d+)\s+(subiect|barem|model|fisier|variant)/);
  if (lim) {
    limit = Number(lim[1] || lim[3]) || 0;
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

module.exports = { chatSelect, pickDeterministic, refineByMessage };
