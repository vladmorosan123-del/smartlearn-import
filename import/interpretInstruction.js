'use strict';

// Transforma o instructiune in limbaj natural intr-un filtru structurat.
// Ex: "importa toate modelele din 2019" ->
//     { an: 2019, sesiune: 'Model', materie: null, includeBareme: true, profiluri: [] }
//
// Determinist by default (regex) — NU depinde de reteaua/cota Gemini, deci
// testele si rularile offline merg. index.js poate cere varianta AI (Gemini)
// care, la orice eroare, cade inapoi pe cea determinista.

const { SUBJECTS, PROFILES } = require('./parseFilename');

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ă/g, 'a').replace(/â/g, 'a').replace(/î/g, 'i')
    .replace(/ș|ş/g, 's').replace(/ț|ţ/g, 't');
}

function interpretDeterministic(instruction) {
  const norm = normalize(instruction);

  const anMatch = norm.match(/((?:19|20)\d{2})/);
  const an = anMatch ? Number(anMatch[1]) : null;

  let sesiune = null;
  if (/model/.test(norm)) sesiune = 'Model';
  else if (/simular/.test(norm)) sesiune = 'Simulare';
  else if (/toamn/.test(norm)) sesiune = 'Toamnă';

  let materie = null;
  for (const s of SUBJECTS) {
    if (s.keys.some((k) => norm.includes(normalize(k)))) { materie = s.slug; break; }
  }

  // Baremele: incluse implicit (ex. "toate modelele"), exceptand cererea
  // explicita de "doar/numai subiecte" sau "fara barem".
  let includeBareme = true;
  if (/(doar|numai|only)\s+subiect/.test(norm) || /fara\s+barem/.test(norm)) includeBareme = false;
  if (/(cu|si|include)\s+barem|bareme/.test(norm)) includeBareme = true;

  const profiluri = PROFILES.filter((p) => norm.includes(p));

  return { an, sesiune, materie, includeBareme, profiluri };
}

// Varianta Gemini (optionala). Foloseste @google/genai daca exista + cheie;
// altfel arunca si apelantul cade pe determinist.
async function interpretWithGemini(instruction) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Fara GEMINI_API_KEY');
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const sys =
    'Extrage un filtru din instructiunea profesorului pentru importul de subiecte BAC. ' +
    'Raspunde DOAR cu JSON: {"an": number|null, "sesiune": "Model"|"Simulare"|null, ' +
    '"materie": "matematica"|"informatica"|"fizica"|"romana"|null, "includeBareme": boolean, "profiluri": string[]}.';
  const result = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: `Instructiune: "${instruction}"`,
    config: { systemInstruction: sys, maxOutputTokens: 512, responseMimeType: 'application/json' },
  });
  const parsed = JSON.parse(result.text || '{}');
  return {
    an: parsed.an ?? null,
    sesiune: parsed.sesiune ?? null,
    materie: parsed.materie ?? null,
    includeBareme: parsed.includeBareme !== false,
    profiluri: Array.isArray(parsed.profiluri) ? parsed.profiluri : [],
  };
}

async function interpretInstruction(instruction, { useAI = false } = {}) {
  if (useAI) {
    try {
      return await interpretWithGemini(instruction);
    } catch (_) {
      // fallback silentios pe determinist
    }
  }
  return interpretDeterministic(instruction);
}

module.exports = { interpretInstruction, interpretDeterministic };
