# Floor plan JSON → Konva (pipeline order)

Your renderer should use the **`plan`** object returned by the API. Optional **`konva`** tells you how big to make the Stage.

## Processing order (debug with `?debug=1`)

| Step | Phase | What it does |
|------|--------|----------------|
| 1 | **unwrap_payload** | If body is `{ plan: {...} }` or `{ data: {...} }`, use inner object. |
| 2 | **coerce_numeric_strings** | `"12"` → `12` (Konva needs numbers). |
| 3 | **validate_schema** | Ensures `meta`, `rooms`, `walls`, `doors`, `windows`, `stairs`, `furniture`; fills defaults. |
| 4 | **finalize_konva** | Rounds to 3 decimals; fixes bad `wallId` on doors/windows; computes **bounds**. |

DXF uploads add **parse_dxf** and **dxf_to_plan** before step 1.

## Response shape

```json
{
  "source": "json" | "dxf",
  "plan": { "meta", "rooms", "walls", "doors", "windows", "stairs", "furniture" },
  "konva": {
    "bounds": { "minX", "minY", "maxX", "maxY", "width", "height" },
    "suggestedPixelsPerMeter": 50
  },
  "warnings": [],
  "debug": { "steps": [...] }
}
```

## React Konva Stage

```javascript
const ppm = konva.suggestedPixelsPerMeter; // e.g. 50
<Stage width={800} height={600} scaleX={ppm} scaleY={ppm} x={-konva.bounds.minX * ppm} y={-konva.bounds.minY * ppm}>
```

Or fit to viewport by scaling `800 / konva.bounds.width / ppm`.

## Prefer JSON over DXF

`POST /plan` with your exported JSON → always matches your app schema.  
DXF is approximate unless you use the layered Sparkix export.
