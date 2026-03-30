# Floor Plan Backend

## Konva pipeline (step order)

1. **unwrap** — `{ plan }` / `{ data }` → inner floor plan  
2. **coerce** — string numbers → `number`  
3. **validate** — schema + defaults (`wallHeight`, etc.)  
4. **finalize** — round coords, fix bad `wallId`, compute **`konva.bounds`**

Use **`?debug=1`** on `POST /plan` or `POST /upload` to get `debug.steps` in the response.  
See **`docs/FLOOR_PLAN_SCHEMA.md`** and **`GET /plan/schema`**.

## Source of truth: **JSON** (recommended for Konva)

Your canonical floor plan should be the **JSON** you export from the designer.  
Use **DXF** only for CAD exchange; re-importing DXF will not match JSON 1:1.

### `POST /plan`

Send the full floor plan as **JSON body** (same shape as `floor-plan-json-file.json`).

```bash
curl -X POST http://localhost:3000/plan \
  -H "Content-Type: application/json" \
  -d @floor-plan-json-file.json
```

**Response:** `{ "source": "json", "plan": { ... }, "warnings": [] }`  
Missing optional fields (e.g. `wallHeight` on walls) are filled from `meta`.

### `POST /plan/session`

Same body as `/plan`, plus server stores the plan **24h**.

**Response:** `{ "sessionId", "plan", "warnings", "designerUrl": "/designer?planSession=..." }`

### `GET /plan/session/:sessionId`

Returns `{ "source": "json", "plan" }` for your React `/designer` page (e.g. on load read `?planSession=`).

### `POST /upload/plan`

Multipart field **`file`** = `.json` file (canonical plan).

---

## DXF import (optional)

### `POST /upload`

- **Body:** `multipart/form-data`, field **`file`** = `.dxf`

**Response:** `{ "source": "dxf", "parsed": { ... }, "plan": { ... } }`  
`plan` is best-effort (layered Sparkix-style DXF works best).

---

## Setup

```bash
npm install
npm run build
npm start
```

## React designer flow (JSON)

1. **Option A — direct POST:**  
   `POST /plan` with JSON → use `plan` in Konva.

2. **Option B — session + refresh:**  
   `POST /plan/session` → redirect to `/designer?planSession=...`  
   On designer mount: `GET /plan/session/${id}` → render `plan`.

```javascript
// Load saved session
const id = new URLSearchParams(location.search).get('planSession');
const { plan } = await fetch(`http://localhost:3000/plan/session/${id}`).then((r) => r.json());
```
