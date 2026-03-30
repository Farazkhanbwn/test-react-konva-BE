/**
 * DXF exports with layers: WALLS, DOORS, WINDOWS, LABELS, STAIRS (Sparkix-style).
 * Matches floor-plan-json structure much more closely than raw geometry dump.
 */
import type { IDxf, IPoint } from 'dxf-parser';
import { mergeCollinearSegments, nearestWallId as nearestWallIdUtil, arcToSegments } from './wallUtils';
import type { Seg } from './wallUtils';
import { insertToFurniture, getFurnitureStyle, normalizeFurnitureType } from './furnitureFromDxf';
import type {
  FloorPlan,
  FloorPlanMeta,
  FloorPlanWall,
  FloorPlanRoom,
  FloorPlanDoor,
  FloorPlanWindow,
  FloorPlanStairs,
  FloorPlanRoomFloor,
  FloorPlanFurniture,
} from './types/floorPlan';

const EPS = 0.02;

interface DxfEntity {
  type?: string;
  vertices?: IPoint[] | { x: number; y: number; z?: number }[];
  layer?: string;
  text?: string;
  startPoint?: IPoint;
  position?: IPoint;
  name?: string;
  rotation?: number;
  xScale?: number;
  yScale?: number;
  center?: IPoint;
  radius?: number;
  startAngle?: number;
  endAngle?: number;
  [key: string]: unknown;
}

function baseMeta(projectName: string): FloorPlanMeta {
  return {
    version: 1,
    unit: 'm',
    defaultWallHeight: 2.8,
    defaultWallThickness: 0.2,
    defaultInnerWallThickness: 0.1,
    slabThickness: 0.15,
    floorLevel: 0.01,
    projectName,
  };
}

function floorFromLabel(label: string): FloorPlanRoomFloor {
  const l = label.toLowerCase();
  if (/bath|wc|toilet|ensuite|shower/.test(l)) return { color: '#d4e6f1', material: 'tile' };
  if (/bed|sleep/.test(l)) return { color: '#e8d5b7', material: 'wood' };
  if (/hall|corridor|passage|lobby/.test(l)) return { color: '#f2f2f2', material: 'tile' };
  if (/stair|step/.test(l)) return { color: '#d5d5d5', material: 'tile' };
  if (/kitchen|dining|pantry/.test(l)) return { color: '#e8dcc8', material: 'tile' };
  if (/living|lounge|family/.test(l)) return { color: '#e5e0d8', material: 'wood' };
  return { color: '#ececec', material: 'tile' };
}

function slugId(label: string, idx: number): string {
  const s = label.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24);
  return s || `room${idx}`;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function getScaleToMeters(dxf: IDxf): number {
  const header = dxf.header as Record<string, unknown>;
  const u = header?.INSUNITS;
  const map: Record<number, number> = {
    1: 0.0254,
    2: 0.3048,
    4: 0.001,
    5: 0.01,
    6: 1,
    10: 1,
  };
  if (typeof u === 'number' && map[u] !== undefined) return map[u];
  return 1;
}

function segLen(s: Seg): number {
  return Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
}

function collectLineSegments(entities: DxfEntity[], layer: string, scale: number): Seg[] {
  const out: Seg[] = [];
  const layerUpper = String(layer).toUpperCase();
  for (const e of entities) {
    if (e.type !== 'LINE' || String(e.layer ?? '').toUpperCase() !== layerUpper) continue;
    const v = e.vertices;
    if (!v || v.length < 2) continue;
    const a = v[0] as IPoint;
    const b = v[1] as IPoint;
    out.push({
      x1: a.x * scale,
      y1: a.y * scale,
      x2: b.x * scale,
      y2: b.y * scale,
    });
  }
  return out;
}

function collectArcSegments(entities: DxfEntity[], layer: string, scale: number): Seg[] {
  const out: Seg[] = [];
  const layerUpper = String(layer).toUpperCase();
  for (const e of entities) {
    if (e.type !== 'ARC' || String(e.layer ?? '').toUpperCase() !== layerUpper || e.center == null || typeof e.radius !== 'number') continue;
    const cx = (e.center as IPoint).x * scale;
    const cy = (e.center as IPoint).y * scale;
    const r = e.radius * scale;
    const startAng = Number(e.startAngle ?? 0);
    const endAng = Number(e.endAngle ?? 360);
    out.push(...arcToSegments(cx, cy, r, startAng, endAng));
  }
  return out;
}

function bboxFromSegs(segs: Seg[]): { minX: number; maxX: number; minY: number; maxY: number } | null {
  if (!segs.length) return null;
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const s of segs) {
    minX = Math.min(minX, s.x1, s.x2);
    maxX = Math.max(maxX, s.x1, s.x2);
    minY = Math.min(minY, s.y1, s.y2);
    maxY = Math.max(maxY, s.y1, s.y2);
  }
  return { minX, maxX, minY, maxY };
}

function clusterSegments(segs: Seg[], eps: number): Seg[][] {
  const n = segs.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i: number, j: number) => {
    const ri = find(i),
      rj = find(j);
    if (ri !== rj) parent[ri] = rj;
  };

  const near = (a: number, b: number) => Math.abs(a - b) < eps;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const A = segs[i],
        B = segs[j];
      const touch =
        (near(A.x1, B.x1) && near(A.y1, B.y1)) ||
        (near(A.x1, B.x2) && near(A.y1, B.y2)) ||
        (near(A.x2, B.x1) && near(A.y2, B.y1)) ||
        (near(A.x2, B.x2) && near(A.y2, B.y2));
      if (touch) union(i, j);
    }
  }
  const groups = new Map<number, Seg[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(segs[i]);
  }
  return [...groups.values()];
}

const DIM_RE = /^(\d+(?:\.\d+)?)\s*m\s*x\s*(\d+(?:\.\d+)?)\s*m/i;

export function isSparkixLayeredDxf(entities: DxfEntity[]): boolean {
  return entities.some((e) => e.type === 'LINE' && String(e.layer).toUpperCase() === 'WALLS');
}

export function dxfLayerExportToFloorPlan(dxf: IDxf, entities: DxfEntity[], projectName: string): FloorPlan {
  const scale = getScaleToMeters(dxf);
  const meta = baseMeta(projectName);
  const tOut = meta.defaultWallThickness;
  const tIn = meta.defaultInnerWallThickness;
  const hWall = meta.defaultWallHeight;

  /* Layer → JSON mapping (case-insensitive): WALLS→walls, DOORS→doors, WINDOWS→windows, STAIRS→stairs, LABELS→rooms, FURNITURE→furniture */
  const wallSegs = [
    ...collectLineSegments(entities, 'WALLS', scale),
    ...collectArcSegments(entities, 'WALLS', scale),
  ];
  const doorSegs = collectLineSegments(entities, 'DOORS', scale);
  const winSegs = collectLineSegments(entities, 'WINDOWS', scale);
  const stairSegs = collectLineSegments(entities, 'STAIRS', scale);
  const furnitureLineSegs = [
    ...collectLineSegments(entities, 'FURNITURE', scale),
    ...collectArcSegments(entities, 'FURNITURE', scale),
  ];

  const allForY = [...wallSegs, ...doorSegs, ...winSegs, ...stairSegs, ...furnitureLineSegs];
  const texts = entities
    .filter((e) => e.type === 'TEXT' && String(e.layer).toUpperCase() === 'LABELS' && e.text)
    .map((e) => {
      const pt = (e.startPoint ?? e.position) as IPoint | undefined;
      if (!pt) return null;
      return { x: pt.x * scale, y: pt.y * scale, text: String(e.text).trim() };
    })
    .filter(Boolean) as { x: number; y: number; text: string }[];

  for (const t of texts) {
    allForY.push({ x1: t.x, y1: t.y, x2: t.x, y2: t.y });
  }

  const bb = bboxFromSegs(allForY);
  if (!bb) {
    return { meta, rooms: [], walls: [], doors: [], windows: [], stairs: [], furniture: [] };
  }
  const maxYd = bb.maxY;
  const minYAll = bb.minY;

  const toPlanY = (yd: number) => round3(maxYd - yd);

  const planSegsRaw: Seg[] = wallSegs.map((s) => ({
    x1: round3(s.x1),
    y1: toPlanY(s.y1),
    x2: round3(s.x2),
    y2: toPlanY(s.y2),
  }));
  const planSegs = mergeCollinearSegments(planSegsRaw, EPS);

  let minXp = Infinity,
    minYp = Infinity,
    maxXp = -Infinity,
    maxYp = -Infinity;
  for (const s of planSegs) {
    minXp = Math.min(minXp, s.x1, s.x2);
    minYp = Math.min(minYp, s.y1, s.y2);
    maxXp = Math.max(maxXp, s.x1, s.x2);
    maxYp = Math.max(maxYp, s.y1, s.y2);
  }

  const isHoriz = (s: Seg) => Math.abs(s.y1 - s.y2) < EPS;
  const isVert = (s: Seg) => Math.abs(s.x1 - s.x2) < EPS;

  const used = new Set<number>();
  const outerWalls: FloorPlanWall[] = [];

  const mergeOuter = (pred: (s: Seg) => boolean, id: string) => {
    const idx: number[] = [];
    for (let i = 0; i < planSegs.length; i++) {
      if (used.has(i) || !pred(planSegs[i])) continue;
      idx.push(i);
    }
    if (!idx.length) return;
    let x1 = Infinity,
      y1 = Infinity,
      x2 = -Infinity,
      y2 = -Infinity;
    for (const i of idx) {
      const s = planSegs[i];
      x1 = Math.min(x1, s.x1, s.x2);
      y1 = Math.min(y1, s.y1, s.y2);
      x2 = Math.max(x2, s.x1, s.x2);
      y2 = Math.max(y2, s.y1, s.y2);
      used.add(i);
    }
    outerWalls.push({
      id,
      x1: round3(x1),
      y1: round3(y1),
      x2: round3(x2),
      y2: round3(y2),
      thickness: tOut,
      isOuter: true,
      wallHeight: hWall,
      wallThickness3d: tOut,
    });
  };

  mergeOuter((s) => isHoriz(s) && Math.abs(s.y1 - minYp) < EPS, 'ow-t');
  mergeOuter((s) => isHoriz(s) && Math.abs(s.y1 - maxYp) < EPS, 'ow-b');
  mergeOuter((s) => isVert(s) && Math.abs(s.x1 - minXp) < EPS, 'ow-l');
  mergeOuter((s) => isVert(s) && Math.abs(s.x1 - maxXp) < EPS, 'ow-r');

  const innerRaw: Seg[] = [];
  for (let i = 0; i < planSegs.length; i++) {
    if (!used.has(i)) innerRaw.push(planSegs[i]);
  }

  innerRaw.sort((a, b) => {
    const ay = (a.y1 + a.y2) / 2,
      ax = (a.x1 + a.x2) / 2;
    const by = (b.y1 + b.y2) / 2,
      bx = (b.x1 + b.x2) / 2;
    if (Math.abs(ay - by) > EPS) return ay - by;
    return ax - bx;
  });

  const innerWalls: FloorPlanWall[] = innerRaw.map((s, i) => ({
    id: `iw-${i + 1}`,
    x1: s.x1,
    y1: s.y1,
    x2: s.x2,
    y2: s.y2,
    thickness: tIn,
    isOuter: false,
    wallHeight: hWall,
    wallThickness3d: tIn,
  }));

  const walls = [...outerWalls, ...innerWalls];

  /* Rooms: LABELS — name line above "W x H m" (within ~0.45 m in DXF Y) */
  const sortedLabels = [...texts].sort((a, b) => b.y - a.y);
  const labelUsed = new Set<number>();
  const rooms: FloorPlanRoom[] = [];
  let roomIdx = 0;
  for (let i = 0; i < sortedLabels.length; i++) {
    if (labelUsed.has(i)) continue;
    const name = sortedLabels[i];
    if (DIM_RE.test(name.text)) continue;
    for (let j = i + 1; j < sortedLabels.length; j++) {
      if (labelUsed.has(j)) continue;
      const dim = sortedLabels[j];
      if (!DIM_RE.test(dim.text)) continue;
      const dy = name.y - dim.y;
      if (dy <= 0 || dy > 0.48) continue;
      if (Math.abs(name.x - dim.x) > 2.5) continue;
      const m = dim.text.match(DIM_RE);
      if (!m) continue;
      labelUsed.add(i);
      labelUsed.add(j);
      const W = parseFloat(m[1]);
      const H = parseFloat(m[2]);
      const lx = name.x;
      const ly = name.y;
      const x = round3(lx - W / 2);
      const yTopDxf = ly + H / 2;
      const y = round3(maxYd - yTopDxf);
      rooms.push({
        id: slugId(name.text, ++roomIdx),
        label: name.text,
        x,
        y,
        width: round3(W),
        height: round3(H),
        floor: floorFromLabel(name.text),
      });
      break;
    }
  }

  /* Doors: one opening segment per cluster (axis-aligned ~0.7–1.0 m) */
  const doorClusters = clusterSegments(doorSegs, 0.12).sort((a, b) => {
    const ca = bboxFromSegs(a)!;
    const cb = bboxFromSegs(b)!;
    return ca.minY - cb.minY || ca.minX - cb.minX;
  });
  const doors: FloorPlanDoor[] = [];
  let doorN = 0;
  for (const cl of doorClusters) {
    let best: Seg | null = null;
    let bestScore = Infinity;
    for (const s of cl) {
      const L = segLen(s);
      if (L < 0.45 || L > 1.25) continue;
      const horiz = Math.abs(s.y1 - s.y2) < 0.08;
      const vert = Math.abs(s.x1 - s.x2) < 0.08;
      if (!horiz && !vert) continue;
      const score = Math.abs(L - 0.8);
      if (score < bestScore) {
        bestScore = score;
        best = s;
      }
    }
    if (!best) continue;
    const horiz = Math.abs(best.y1 - best.y2) < 0.08;
    let x: number;
    let y: number;
    let rotation: number;
    if (horiz) {
      x = round3(Math.max(best.x1, best.x2));
      y = round3(maxYd - best.y1);
      rotation = best.x2 >= best.x1 ? 0 : 180;
    } else {
      x = round3(best.x1);
      y = round3(maxYd - Math.min(best.y1, best.y2));
      rotation = best.y2 > best.y1 ? -90 : 90;
    }
    doors.push({
      id: `door-${++doorN}`,
      x,
      y,
      width: round3(segLen(best)),
      height: 2.1,
      wallId: nearestWallIdUtil(x, y, walls),
      rotation,
      type: 'hinged',
      openDirection: doorN % 2 === 1 ? 'left' : 'right',
      swingAngle: 90,
    });
  }

  /* Windows */
  const winClusters = clusterSegments(winSegs, 0.08);
  const windows: FloorPlanWindow[] = [];
  let winN = 0;
  for (const cl of winClusters) {
    const b = bboxFromSegs(cl);
    if (!b) continue;
    const w = b.maxX - b.minX;
    const h = b.maxY - b.minY;
    if (w < 0.08 && h < 0.08) continue;

    if (w > h + 0.08) {
      const yWall = Math.abs(b.minY) < Math.abs(b.maxY) ? b.minY : b.maxY;
      if (Math.abs(yWall) < 0.15 || Math.abs(yWall + 8) < 0.15) {
        const yLine = Math.abs(yWall) < 0.15 ? 0 : round3(maxYd - minYAll);
        windows.push({
          id: `win-${++winN}`,
          x1: round3(b.minX),
          y1: yLine,
          x2: round3(b.maxX),
          y2: yLine,
          height: 1.2,
          sillHeight: 0.9,
          wallId: Math.abs(yWall) < 0.15 ? 'ow-t' : 'ow-b',
        });
      }
    } else if (h > w + 0.08) {
      const xWall = Math.abs(b.minX) < Math.abs(b.maxX) ? b.minX : b.maxX;
      const xLine = Math.abs(xWall) < 0.15 ? 0 : round3(maxXp);
      const y1 = round3(maxYd - Math.max(b.minY, b.maxY));
      const y2 = round3(maxYd - Math.min(b.minY, b.maxY));
      windows.push({
        id: `win-${++winN}`,
        x1: xLine,
        y1: y1,
        x2: xLine,
        y2: y2,
        height: 1.2,
        sillHeight: 0.9,
        wallId: Math.abs(xWall) < 0.15 ? 'ow-l' : 'ow-r',
      });
    }
  }

  /* Stairs bbox */
  let stairs: FloorPlanStairs[] = [];
  const sb = bboxFromSegs(stairSegs);
  if (sb && stairSegs.length) {
    const x = round3(sb.minX);
    const y = round3(maxYd - sb.maxY);
    stairs = [
      {
        id: 'stairs-1',
        x,
        y,
        width: round3(sb.maxX - sb.minX),
        height: round3(sb.maxY - sb.minY),
        direction: 'up',
      },
    ];
  }

  /* Furniture: (1) INSERT blocks on layer FURNITURE, (2) LINE/ARC on layer FURNITURE → cluster bbox */
  const furniture: FloorPlanFurniture[] = [];
  let furnN = 0;
  for (const e of entities) {
    if (e.type !== 'INSERT' || !e.position) continue;
    if (String(e.layer ?? '').toUpperCase() !== 'FURNITURE') continue;
    const pos = e.position as IPoint;
    const px = round3(pos.x * scale);
    const py = round3(maxYd - pos.y * scale);
    const rot = Number(e.rotation ?? 0);
    const xScale = Number(e.xScale ?? 1);
    const yScale = Number(e.yScale ?? 1);
    furniture.push(
      insertToFurniture(`f-${++furnN}`, String(e.name ?? 'furniture'), px, py, xScale, yScale, rot)
    );
  }
  /* TEXT on layer FURNITURE with "FURNITURETYPE:SOFA" etc. → match to LINE clusters for type/label */
  const FURNITURETYPE_RE = /FURNITURETYPE\s*:\s*(.+)/i;
  const furnitureTypeTexts: { x: number; y: number; type: string }[] = [];
  for (const e of entities) {
    if (e.type !== 'TEXT' || !e.text) continue;
    if (String(e.layer ?? '').toUpperCase() !== 'FURNITURE') continue;
    const m = String(e.text).trim().match(FURNITURETYPE_RE);
    if (!m) continue;
    const pt = (e.startPoint ?? e.position) as IPoint | undefined;
    if (!pt) continue;
    const planX = round3(pt.x * scale);
    const planY = round3(maxYd - pt.y * scale);
    furnitureTypeTexts.push({ x: planX, y: planY, type: normalizeFurnitureType(m[1].trim()) });
  }

  const furniturePlanSegs: Seg[] = furnitureLineSegs.map((s) => ({
    x1: round3(s.x1),
    y1: toPlanY(s.y1),
    x2: round3(s.x2),
    y2: toPlanY(s.y2),
  }));
  const furnitureClusters = clusterSegments(furniturePlanSegs, 0.15);
  for (const cl of furnitureClusters) {
    const b = bboxFromSegs(cl);
    if (!b) continue;
    const w = b.maxX - b.minX;
    const h = b.maxY - b.minY;
    if (w < 0.05 || h < 0.05) continue;
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    let bestType = 'furniture';
    let bestDist = Infinity;
    const pad = 0.5;
    for (const tt of furnitureTypeTexts) {
      const inBox = tt.x >= b.minX - pad && tt.x <= b.maxX + pad && tt.y >= b.minY - pad && tt.y <= b.maxY + pad;
      const dist = Math.hypot(tt.x - cx, tt.y - cy);
      if (inBox && dist < bestDist) {
        bestDist = dist;
        bestType = tt.type;
      }
    }
    if (bestDist === Infinity) {
      for (const tt of furnitureTypeTexts) {
        const dist = Math.hypot(tt.x - cx, tt.y - cy);
        if (dist < bestDist) {
          bestDist = dist;
          bestType = tt.type;
        }
      }
    }
    const style = getFurnitureStyle(bestType);
    furniture.push({
      id: `f-${++furnN}`,
      furnitureType: bestType,
      label: style.label,
      x: round3(b.minX),
      y: round3(b.minY),
      width: round3(w),
      depth: round3(h),
      rotation: 0,
      height3d: round3(style.height3d),
      color3d: style.color3d,
    });
  }

  return { meta, rooms, walls, doors, windows, stairs, furniture };
}
