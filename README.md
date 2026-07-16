# SmartLearning — Server de import subiecte

Server Node + Express care citește pagini cu subiecte de BAC, extrage fișierele (subiect + barem),
le filtrează după materie/an/specializare/limbaj/tip și le publică în platformă (Supabase storage + tabela `materials`).
Frontend-ul îl apelează prin `VITE_IMPORT_URL`.

## Rulare locală
```bash
npm install
cp .env.example import/.env   # completează SUPABASE_URL, SUPABASE_ANON_KEY (GEMINI_API_KEY opțional)
npm start                     # pornește pe portul 3040
# test: http://localhost:3040/api/health  ->  {"status":"ok"}
```

## Deploy pe Render (HTTPS automat, gratis)

Repo-ul are `render.yaml`, deci Render preia singur build/start/variabilele.

1. Pune acest folder într-un **repo GitHub separat** (ex. `smartlearn-import`).
2. Pe [render.com](https://render.com) → **New → Blueprint** → conectează repo-ul (citește `render.yaml`).
   - Sau manual: **New → Web Service**, Build `npm install`, Start `npm start`, Instance **Free**.
3. La **Environment** completează variabilele (din `.env.example`):
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `GEMINI_API_KEY` — opțional (fără ea, filtrarea merge determinist)
   - `CORS_ORIGIN` = domeniul site-ului (ex. `https://smart-learning-cnmsm.ro`)
4. Deploy. Render dă un URL `https://smartlearn-import.onrender.com`.
5. Testează: `https://...onrender.com/api/health` → `"status":"ok"`.
6. În frontend, setează `VITE_IMPORT_URL` = acel URL `https://...` și fă rebuild/deploy.

## Endpoints principale
- `GET  /api/health` — stare
- `POST /api/import/filter` — filtrare structurată (materie/an/specializare/limbaj/tip)
- `POST /api/import/chat` — selecție prin limbaj natural
- `POST /api/import/list` — răsfoire manuală a unei pagini
- `POST /api/import/commit` / `browse-import` — publicare (necesită tokenul profesorului)

## Note
- Free tier adoarme după ~15 min inactivitate; prima cerere după somn durează ~30s (cold start).
- Publicarea în DB folosește tokenul profesorului (RLS) — serverul are nevoie doar de `SUPABASE_URL` + `SUPABASE_ANON_KEY`.
