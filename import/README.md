# Import AI subiecte BAC

Import în masă de subiecte/bareme BAC dintr-un link + o instrucțiune în limbaj natural.
Sursă recomandată: **subiecte.edu.ro** (arhiva oficială, gratuită). Modelele sunt ZIP-uri per materie.

## Utilizare (DRY-RUN — implicit, nu scrie nimic)

```bash
node import/index.js "<url>" "<instrucțiune>" [--ai] [--out FILE]
```

Exemplu:

```bash
node import/index.js \
  "https://subiecte.edu.ro/2026/bacalaureat/modeledesubiecte/probescrise/" \
  "importă toate modelele de matematică"
```

- `<url>` poate fi un director-index SAU un `.zip` direct.
- `--ai` folosește Gemini pentru interpretarea instrucțiunii (cade automat pe varianta determinist-regex dacă nu e cheie/rețea).
- Dry-run: descarcă PDF-urile în `_import_dryrun/` și printează JSON-ul cu rândurile care S-AR insera în `materials`. **Nimic** nu se scrie în DB/storage.

## Scriere reală (blocată triplu, NU rula până nu validezi)

Necesită TOATE trei: `--write` + `--confirm` + `IMPORT_ALLOW_PROD_WRITE=yes`.

```bash
IMPORT_ALLOW_PROD_WRITE=yes node import/index.js "<url>" "<instrucțiune>" --write --confirm
```

## Fișiere

| fișier | rol |
|---|---|
| `parseFilename.js` | nume fișier → `{ an, materie, profil, sesiune, tip }` |
| `interpretInstruction.js` | instrucțiune NL → filtru (determinist + Gemini opțional) |
| `source.js` | găsește/descarcă ZIP-ul oficial, listează/extrage PDF-uri |
| `pipeline.js` | filtrare + sortare (subiect→barem) + mapare la `materials` |
| `index.js` | CLI orchestrator (dry-run implicit) |
| `write.js` | scriere reală în Supabase (storage + `materials`), triplu-blocată |
| `parseFilename.test.js` | teste deterministe (`node import/parseFilename.test.js`) |

## Model de date

Fiecare fișier = **un rând** în `materials` (subiectul și baremul sunt rânduri separate),
ordonate subiect, barem, subiect, barem. `category: 'bac_model'`, `subject: <slug>`, `study_classes: [profil]`.
