'use strict';

// Teste deterministe (fara retea). Ruleaza: node import/parseFilename.test.js
const assert = require('assert');
const { parseFilename } = require('./parseFilename');
const { interpretDeterministic } = require('./interpretInstruction');
const { filterFiles, sortPairs } = require('./pipeline');

// Fixture: exact continutul PDF al ZIP-ului oficial Bac_2026_E_c_Matematica_modele.zip
const OFFICIAL_8 = [
  'E_c_matematica_M_mate-info_2026_bar_model.pdf',
  'E_c_matematica_M_mate-info_2026_var_model.pdf',
  'E_c_matematica_M_pedagogic_2026_bar_model.pdf',
  'E_c_matematica_M_pedagogic_2026_var_model.pdf',
  'E_c_matematica_M_st-nat_2026_bar_model.pdf',
  'E_c_matematica_M_st-nat_2026_var_model.pdf',
  'E_c_matematica_M_tehnologic_2026_bar_model.pdf',
  'E_c_matematica_M_tehnologic_2026_var_model.pdf',
];

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('parseFilename:');

ok('parseaza numele oficial (subiect)', () => {
  const p = parseFilename('E_c_matematica_M_mate-info_2026_var_model.pdf');
  assert.strictEqual(p.an, 2026);
  assert.strictEqual(p.materieSlug, 'matematica');
  assert.strictEqual(p.profil, 'mate-info');
  assert.strictEqual(p.sesiune, 'Model');
  assert.strictEqual(p.tip, 'subiect');
});

ok('parseaza numele oficial (barem)', () => {
  const p = parseFilename('E_c_matematica_M_st-nat_2026_bar_model.pdf');
  assert.strictEqual(p.tip, 'barem');
  assert.strictEqual(p.profil, 'st-nat');
});

ok('parseaza exemplul arhivabac din cerinta', () => {
  const p = parseFilename('2019_Matematica_SM_M_mate-info_Model_Subiect');
  assert.deepStrictEqual(
    { an: p.an, materie: p.materie, profil: p.profil, sesiune: p.sesiune, tip: p.tip },
    { an: 2019, materie: 'Matematică', profil: 'mate-info', sesiune: 'Model', tip: 'subiect' },
  );
});

ok('ignora fisiere fara subiect/barem', () => {
  assert.strictEqual(parseFilename('index.html'), null);
  assert.strictEqual(parseFilename('legislatie_2026.pdf'), null);
});

console.log('interpretInstruction (determinist):');

ok('"importa toate modelele de matematica" -> filtru corect', () => {
  const f = interpretDeterministic('importa toate modelele de matematica');
  assert.strictEqual(f.materie, 'matematica');
  assert.strictEqual(f.sesiune, 'Model');
  assert.strictEqual(f.includeBareme, true);
});

ok('"doar subiectele" -> fara bareme', () => {
  const f = interpretDeterministic('importa doar subiectele model de matematica');
  assert.strictEqual(f.includeBareme, false);
});

ok('extrage anul', () => {
  assert.strictEqual(interpretDeterministic('modelele din 2019').an, 2019);
});

console.log('pipeline (pe cele 8 fisiere oficiale):');

ok('gaseste toate cele 8 fisiere (subiect+barem)', () => {
  const parsed = OFFICIAL_8.map(parseFilename).filter(Boolean);
  const filter = interpretDeterministic('importa toate modelele de matematica');
  const kept = sortPairs(filterFiles(parsed, filter));
  assert.strictEqual(kept.length, 8, `asteptat 8, primit ${kept.length}`);
  assert.strictEqual(kept.filter((k) => k.tip === 'subiect').length, 4);
  assert.strictEqual(kept.filter((k) => k.tip === 'barem').length, 4);
});

ok('ordoneaza subiect inainte de barem pe fiecare profil', () => {
  const parsed = OFFICIAL_8.map(parseFilename).filter(Boolean);
  const kept = sortPairs(filterFiles(parsed, interpretDeterministic('toate modelele matematica')));
  for (let i = 0; i < kept.length; i += 2) {
    assert.strictEqual(kept[i].tip, 'subiect', `pozitia ${i} ar trebui subiect`);
    assert.strictEqual(kept[i + 1].tip, 'barem', `pozitia ${i + 1} ar trebui barem`);
    assert.strictEqual(kept[i].profil, kept[i + 1].profil, 'perechea trebuie sa aiba acelasi profil');
  }
});

ok('"doar subiecte" pastreaza 4', () => {
  const parsed = OFFICIAL_8.map(parseFilename).filter(Boolean);
  const kept = filterFiles(parsed, interpretDeterministic('doar subiectele model de matematica'));
  assert.strictEqual(kept.length, 4);
});

console.log(`\n✅ ${passed} teste trecute.`);
