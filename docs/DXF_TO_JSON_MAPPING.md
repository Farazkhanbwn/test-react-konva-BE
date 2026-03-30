# Where DXF entities become rooms, walls, doors, etc.

The DXF only has low-level **entity types** (e.g. `LINE`, `TEXT`, `INSERT`, `LWPOLYLINE`, `ARC`). We decide what they mean using **layer names** (and for INSERT, **block name**), then convert them into the JSON structure (rooms, walls, doors, windows, stairs, furniture).

---

## Two conversion paths

1. **Layer-based path** (Sparkix-style DXF)  
   Used when the file has a layer named **WALLS**.  
   **Entry:** `dxfToFloorPlan.ts` → `isSparkixLayeredDxf(entities)` (line ~174 in `dxfLayerExport.ts`).  
   **Conversion:** `dxfLayerExport.ts` → `dxfLayerExportToFloorPlan()`.

2. **General path** (any DXF)  
   Used when there is no WALLS layer.  
   **Conversion:** `dxfToFloorPlan.ts` → `dxfToFloorPlan()` (same file, after the `isSparkixLayeredDxf` check).

---

## Layer-based path (dxfLayerExport.ts)

Here we **only look at `entity.type` and `entity.layer`**. Same entity type (e.g. LINE) can become walls, doors, or windows depending on layer.

| DXF entity | Condition | Becomes | Code location |
|------------|-----------|---------|----------------|
| **LINE** | `layer === 'WALLS'` (case-insensitive) | **Walls** (segments merged into outer/inner walls) | `collectLineSegments(entities, 'WALLS', scale)` → lines 185–187, 236–270 |
| **ARC** | `layer === 'WALLS'` | **Walls** (arc turned into line segments, then same as above) | `collectArcSegments(entities, 'WALLS', scale)` → lines 186–187 |
| **LINE** | `layer === 'DOORS'` | **Doors** (clusters of segments → one door per opening) | `collectLineSegments(entities, 'DOORS', scale)` → line 189, 341–391 |
| **LINE** | `layer === 'WINDOWS'` | **Windows** (clusters → one window per opening) | `collectLineSegments(entities, 'WINDOWS', scale)` → line 190, 393–433 |
| **LINE** | `layer === 'STAIRS'` | **Stairs** (bbox of all segments) | `collectLineSegments(entities, 'STAIRS', scale)` → line 191, 435–451 |
| **TEXT** | `layer === 'LABELS'` and has `text` | **Rooms** (name + "W x H m" text paired to get room label and size) | lines 194–200, 308–338 |
| **INSERT** | `layer === 'FURNITURE'` | **Furniture** (block name → type, position → x,y, scale → size) | lines 454–469 |

So in this path:

- **Walls** = LINE (and ARC) on layer **WALLS**
- **Doors** = LINE on layer **DOORS**
- **Windows** = LINE on layer **WINDOWS**
- **Stairs** = LINE on layer **STAIRS**
- **Rooms** = TEXT on layer **LABELS** (paired with dimension text)
- **Furniture** = INSERT on layer **FURNITURE**

The actual “filter by layer” happens in:

- **WALLS / DOORS / WINDOWS / STAIRS:**  
  `collectLineSegments(entities, 'WALLS', scale)` etc. in **dxfLayerExport.ts** around **93–109**.  
  Each call keeps only entities where `e.type === 'LINE'` and `e.layer` matches the given layer (case-insensitive in the updated code).

- **LABELS (rooms):**  
  `entities.filter(e => e.type === 'TEXT' && String(e.layer).toUpperCase() === 'LABELS' ...)` around **194–200**.

- **FURNITURE:**  
  Loop over entities, keep `e.type === 'INSERT'` and `String(e.layer).toUpperCase() === 'FURNITURE'` around **454–469**.

---

## General path (dxfToFloorPlan.ts)

When there is **no** WALLS layer we don’t use layer names. We use **entity type and geometry** (and for INSERT, **block name**).

| DXF entity | How we use it | Becomes | Code location |
|------------|----------------|---------|----------------|
| **LINE** | All LINEs (any layer) | Line segments → merged → **walls** (outer + inner) | Lines 155–162, 252–339 |
| **LWPOLYLINE** | Vertices as segments; if closed and axis-aligned rectangle → room outline | Line segments → **walls**; closed rect → **room** outline | Lines 169–190, 342–351 |
| **ARC** | Convert to line segments | Same segment list → **walls** | Lines 191–205, 252–339 |
| **LWPOLYLINE** (closed, axis-aligned) | Rectangle bbox | **Rooms** (with label from TEXT inside) | Lines 342–403 |
| **TEXT / MTEXT** | Text and position | **Room label** (matched to room rect by point-in-rect), or standalone **room** if not inside any rect | Lines 354–418 |
| **INSERT** | Block **name** (e.g. "DOOR", "WINDOW", "SOFA") | **Doors** / **Windows** / **Stairs** / **Furniture** by name | Lines 451–498 |

So in this path:

- **Walls** = all LINE + LWPOLYLINE (non-room) + ARC segments, merged.
- **Rooms** = closed axis-aligned LWPOLYLINE (+ TEXT for label), or TEXT alone.
- **Doors** = INSERT whose block name contains `"door"` / `"d_"`.
- **Windows** = INSERT whose block name contains `"win"` / `"window"` / `"glazing"`.
- **Stairs** = INSERT whose block name contains `"stair"` (only if no stairs yet).
- **Furniture** = any other INSERT (not door/window/stair).

The “check and manage” for INSERT is in **dxfToFloorPlan.ts** around **455–498**: we read `entity.name`, normalize to lowercase, then branch with `if (name.includes('door') ...)`, `else if (name.includes('win') ...)`, `else if (name.includes('stair') ...)`, `else { furniture.push(...) }`.

---

## Where the final JSON is produced

- **Layer path:**  
  The object `{ meta, rooms, walls, doors, windows, stairs, furniture }` is built inside **dxfLayerExportToFloorPlan()** and returned at the end of **dxfLayerExport.ts** (around 471).

- **General path:**  
  The same shape is built inside **dxfToFloorPlan()** and returned at the end of **dxfToFloorPlan.ts** (around 524–534).

- **HTTP response:**  
  The plan is then run through **runFloorPlanPipeline()** (validation, rounding, wallId fix, bounds). The API returns that pipeline result (with `plan`, `konva`, etc.) in **server.ts** in the **POST /upload** handler (around 152–161): `plan: pipeline.plan` is the final JSON you get.

So:

- **“Where do you convert to JSON?”**  
  The “to JSON” is the returned **FloorPlan** object from `dxfToFloorPlan()` or `dxfLayerExportToFloorPlan()`, then after **runFloorPlanPipeline()** that object is sent as **server.ts** → `res.json(out)` with `out.plan = pipeline.plan`.

- **“I only see LINE and TEXT in entities – how do you know rooms, walls, doors?”**  
  - In the **layer-based** path: by **layer** (WALLS → walls, DOORS → doors, LABELS → rooms, etc.).  
  - In the **general** path: LINE/LWPOLYLINE/ARC → walls; LWPOLYLINE + TEXT → rooms; INSERT **name** → doors / windows / stairs / furniture.

If your DXF has only LINE and TEXT and **no** WALLS layer, the code uses the general path: all LINEs become walls, and rooms come from closed LWPOLYLINEs + TEXT. If you want walls/doors/windows from LINEs by meaning, the DXF should use the **WALLS / DOORS / WINDOWS** layers (and optionally LABELS for rooms).
