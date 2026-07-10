'use strict';

// Interpreteaza conversatia profesorului si alege ce fisiere de pe pagina se
// potrivesc. Gemini daca e disponibil; altfel matching determinist pe etichete.

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ă/g, 'a').replace(/â/g, 'a').replace(/î/g, 'i')
    .replace(/ș|ş/g, 's').replace(/ț|ţ/g, 't');
}

const SUBJECT_KEYS = {
  matematica: ['matematica'], informatica: ['informatica'], fizica: ['fizica'],
  romana: ['romana', 'limba romana', 'literatura'],
};

// ── determinist ─────────────────────────────────────────────
function pickDeterministic(items, message) {
  const q = normalize(message);
  const year = (q.match(/((?:19|20)\d{2})/) || [])[1];
  const wantAll = /\b(toate|tot|toti|all)\b/.test(q);
  const onlySubiecte = /(doar|numai)\s+subiect|fara\s+barem/.test(q);
  const onlyBareme = /(doar|numai)\s+barem/.test(q);

  const subjWanted = Object.entries(SUBJECT_KEYS)
    .filter(([, keys]) => keys.some((k) => q.includes(k)))
    .map(([slug]) => slug);
  const profWanted = ['mate-info', 'st-nat', 'tehnologic', 'pedagogic'].filter((p) => q.includes(p));

  const picked = items.filter((it) => {
    const l = normalize(it.label);
    if (year && !l.includes(year)) return false;
    if (subjWanted.length && !subjWanted.some((s) => SUBJECT_KEYS[s].some((k) => l.includes(k)))) return false;
    if (profWanted.length && !profWanted.some((p) => l.includes(p))) return false;
    if (onlySubiecte && /(barem|_bar_|\bbar\b)/.test(l)) return false;
    if (onlyBareme && !/(barem|_bar_|\bbar\b)/.test(l)) return false;
    return true;
  });

  // daca nu s-a cerut nimic specific dar zice "toate" -> tot; altfel ce s-a filtrat
  const finalItems = picked.length ? picked : (wantAll ? items : picked);
  const ids = finalItems.map((it) => it.id);
  const reply = ids.length
    ? `Am găsit ${ids.length} fișiere care se potrivesc cererii tale. Verifică-le mai jos și confirmă.`
    : 'Nu am găsit fișiere care să se potrivească. Încearcă să reformulezi (ex: „modelele de matematică mate-info 2009").';
  return { reply, ids };
}

// ── Gemini (optional) ───────────────────────────────────────
async function pickWithGemini(items, message, history) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('fara cheie');
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });

  const lista = items.map((it) => `${it.id}: ${it.label}`).join('\n');
  const sys =
    'Esti asistentul unui profesor care importa subiecte/bareme de BAC de pe o pagina. ' +
    'Ai o LISTA de fisiere (id: eticheta). Pe baza mesajului profesorului, alege DOAR id-urile care se potrivesc. ' +
    'Raspunde DOAR cu JSON: {"reply": "raspuns scurt si prietenos in romana", "ids": ["id",...]}. ' +
    'Daca cere "toate", alege tot ce e relevant. Daca zice "doar subiecte", exclude baremele.';
  const hist = (history || []).slice(-6).map((h) => `${h.role}: ${h.content}`).join('\n');
  const contents = `LISTA FISIERE:\n${lista}\n\nISTORIC:\n${hist}\n\nMESAJ PROFESOR: "${message}"`;

  const result = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents,
    config: { systemInstruction: sys, maxOutputTokens: 1024, responseMimeType: 'application/json' },
  });
  const parsed = JSON.parse(result.text || '{}');
  const valid = new Set(items.map((i) => i.id));
  const ids = (Array.isArray(parsed.ids) ? parsed.ids : []).filter((id) => valid.has(id));
  return { reply: parsed.reply || `Am selectat ${ids.length} fișiere.`, ids };
}

async function chatSelect(items, message, history, { useAI = true } = {}) {
  if (useAI) {
    try { return await pickWithGemini(items, message, history); }
    catch (_) { /* fallback */ }
  }
  return pickDeterministic(items, message);
}

module.exports = { chatSelect, pickDeterministic };
