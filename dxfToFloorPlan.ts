import type { IDxf, IPoint } from 'dxf-parser';
import { isSparkixLayeredDxf, dxfLayerExportToFloorPlan } from './dxfLayerExport';
import { mergeCollinearSegments, nearestWallId, arcToSegments } from './wallUtils';
import { insertToFurniture } from './furnitureFromDxf';
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

const EPS = 1e-3;

export interface DxfToFloorPlanOptions {
  /** Shown in meta.projectName */
  projectName?: string;
  /** DXF Y-up → screen/Konva Y-down (default true) */
  flipY?: boolean;
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

const INSUNITS_TO_METER: Record<number, number> = {
  1: 0.0254,
  2: 0.3048,
  4: 0.001,
  5: 0.01,
  6: 1,
  10: 1,
};

interface DxfEntity {
  type?: string;
  vertices?: IPoint[] | { x: number; y: number; z?: number }[];
  layer?: string;
  name?: string;
  position?: IPoint;
  rotation?: number;
  xScale?: number;
  yScale?: number;
  text?: string;
  startPoint?: IPoint;
  shape?: boolean;
  center?: IPoint;
  radius?: number;
  startAngle?: number;
  endAngle?: number;
  [key: string]: unknown;
}

function getScaleToMeters(dxf: IDxf): number {
  const header = dxf.header as Record<string, unknown>;
  const insunits = header?.INSUNITS;
  if (typeof insunits === 'number' && INSUNITS_TO_METER[insunits] !== undefined) {
    return INSUNITS_TO_METER[insunits];
  }
  return 1;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
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
  const s = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 24);
  return s || `room${idx}`;
}

/** Axis-aligned bbox room from closed LWPOLYLINE vertices (DXF meters) */
function isAxisAlignedRect(
  verts: { x: number; y: number }[]
): { minX: number; maxX: number; minY: number; maxY: number } | null {
  if (verts.length < 4) return null;
  const xs = verts.map((v) => v.x);
  const ys = verts.map((v) => v.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  if (maxX - minX < EPS || maxY - minY < EPS) return null;
  for (const v of verts) {
    const onVert = Math.abs(v.x - minX) < EPS || Math.abs(v.x - maxX) < EPS;
    const onHoriz = Math.abs(v.y - minY) < EPS || Math.abs(v.y - maxY) < EPS;
    if (!onVert || !onHoriz) return null;
  }
  return { minX, maxX, minY, maxY };
}

function pointInRect(px: number, py: number, r: { minX: number; maxX: number; minY: number; maxY: number }): boolean {
  return px >= r.minX - EPS && px <= r.maxX + EPS && py >= r.minY - EPS && py <= r.maxY + EPS;
}

export function dxfToFloorPlan(dxf: IDxf | null, opts: DxfToFloorPlanOptions = {}): FloorPlan {
  const projectName = opts.projectName?.trim() || process.env.PROJECT_NAME?.trim() || 'Floor plan';
  const flipY = opts.flipY !== false;

  const empty = (): FloorPlan => ({
    meta: baseMeta(projectName),
    rooms: [],
    walls: [],
    doors: [],
    windows: [],
    stairs: [],
    furniture: [],
  });

  if (!dxf?.entities?.length) return empty();

  const entities = dxf.entities as unknown as DxfEntity[];
  if (isSparkixLayeredDxf(entities)) {
    return dxfLayerExportToFloorPlan(dxf, entities, projectName);
  }

  const scale = getScaleToMeters(dxf);

  let minXd = Infinity;
  let minYd = Infinity;
  let maxXd = -Infinity;
  let maxYd = -Infinity;

  const lineSegmentsDxf: { x1: number; y1: number; x2: number; y2: number }[] = [];

  for (const entity of entities) {
    const type = entity.type ?? '';
    const lineVerts = entity.vertices;
    if (type === 'LINE' && lineVerts && lineVerts.length >= 2) {
      const v0 = lineVerts[0] as IPoint;
      const v1 = lineVerts[1] as IPoint;
      const x1 = v0.x * scale;
      const y1 = v0.y * scale;
      const x2 = v1.x * scale;
      const y2 = v1.y * scale;
      lineSegmentsDxf.push({ x1, y1, x2, y2 });
      minXd = Math.min(minXd, x1, x2);
      minYd = Math.min(minYd, y1, y2);
      maxXd = Math.max(maxXd, x1, x2);
      maxYd = Math.max(maxYd, y1, y2);
    }
    if (type === 'LWPOLYLINE' && entity.vertices?.length) {
      const verts = entity.vertices as { x: number; y: number }[];
      const scaled = verts.map((v) => ({ x: v.x * scale, y: v.y * scale }));
      const closed = entity.shape === true;
      const isRoomOutline = closed && isAxisAlignedRect(scaled) !== null;
      if (!isRoomOutline) {
        for (let i = 0; i < (closed ? scaled.length : scaled.length - 1); i++) {
          const a = scaled[i];
          const b = scaled[(i + 1) % scaled.length];
          lineSegmentsDxf.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
          minXd = Math.min(minXd, a.x, b.x);
          minYd = Math.min(minYd, a.y, b.y);
          maxXd = Math.max(maxXd, a.x, b.x);
          maxYd = Math.max(maxYd, a.y, b.y);
        }
      } else {
        for (const v of scaled) {
          minXd = Math.min(minXd, v.x);
          minYd = Math.min(minYd, v.y);
          maxXd = Math.max(maxXd, v.x);
          maxYd = Math.max(maxYd, v.y);
        }
      }
    }
    if (type === 'ARC' && entity.center != null && typeof entity.radius === 'number') {
      const cx = (entity.center as IPoint).x * scale;
      const cy = (entity.center as IPoint).y * scale;
      const r = entity.radius * scale;
      const startAng = Number(entity.startAngle ?? 0);
      const endAng = Number(entity.endAngle ?? 360);
      const arcSegs = arcToSegments(cx, cy, r, startAng, endAng);
      for (const s of arcSegs) {
        lineSegmentsDxf.push(s);
        minXd = Math.min(minXd, s.x1, s.x2);
        minYd = Math.min(minYd, s.y1, s.y2);
        maxXd = Math.max(maxXd, s.x1, s.x2);
        maxYd = Math.max(maxYd, s.y1, s.y2);
      }
    }
  }

  if (!Number.isFinite(minXd)) return empty();

  if (lineSegmentsDxf.length === 0) {
    let ax = Infinity;
    let ay = Infinity;
    let bx = -Infinity;
    let by = -Infinity;
    for (const entity of entities) {
      if (entity.type !== 'LWPOLYLINE' || !entity.shape || !entity.vertices?.length) continue;
      const verts = (entity.vertices as { x: number; y: number }[]).map((v) => ({
        x: v.x * scale,
        y: v.y * scale,
      }));
      const rect = isAxisAlignedRect(verts);
      if (!rect) continue;
      ax = Math.min(ax, rect.minX);
      ay = Math.min(ay, rect.minY);
      bx = Math.max(bx, rect.maxX);
      by = Math.max(by, rect.maxY);
    }
    if (Number.isFinite(ax) && bx - ax > EPS && by - ay > EPS) {
      lineSegmentsDxf.push(
        { x1: ax, y1: ay, x2: bx, y2: ay },
        { x1: bx, y1: ay, x2: bx, y2: by },
        { x1: bx, y1: by, x2: ax, y2: by },
        { x1: ax, y1: by, x2: ax, y2: ay }
      );
    }
  }

  if (lineSegmentsDxf.length === 0) return empty();

  const toPlanY = (y: number) => (flipY ? maxYd - y : y);

  function segToPlan(s: { x1: number; y1: number; x2: number; y2: number }) {
    return {
      x1: round3(s.x1),
      y1: round3(toPlanY(s.y1)),
      x2: round3(s.x2),
      y2: round3(toPlanY(s.y2)),
    };
  }

  const planSegsRaw = lineSegmentsDxf.map(segToPlan);
  const planSegs = mergeCollinearSegments(planSegsRaw, EPS);

  let minXp = Infinity;
  let minYp = Infinity;
  let maxXp = -Infinity;
  let maxYp = -Infinity;
  for (const s of planSegs) {
    minXp = Math.min(minXp, s.x1, s.x2);
    minYp = Math.min(minYp, s.y1, s.y2);
    maxXp = Math.max(maxXp, s.x1, s.x2);
    maxYp = Math.max(maxYp, s.y1, s.y2);
  }

  const isHoriz = (s: { x1: number; y1: number; x2: number; y2: number }) =>
    Math.abs(s.y1 - s.y2) < EPS;
  const isVert = (s: { x1: number; y1: number; x2: number; y2: number }) =>
    Math.abs(s.x1 - s.x2) < EPS;

  const used = new Set<number>();
  const outerWalls: FloorPlanWall[] = [];
  const meta = baseMeta(projectName);
  const tOut = meta.defaultWallThickness;
  const tIn = meta.defaultInnerWallThickness;
  const hWall = meta.defaultWallHeight;

  const tryMergeOuter = (
    pred: (s: { x1: number; y1: number; x2: number; y2: number }) => boolean,
    id: string
  ): void => {
    const cand: number[] = [];
    for (let i = 0; i < planSegs.length; i++) {
      if (used.has(i)) continue;
      const s = planSegs[i];
      if (!pred(s)) continue;
      cand.push(i);
    }
    if (!cand.length) return;
    let x1 = Infinity;
    let y1 = Infinity;
    let x2 = -Infinity;
    let y2 = -Infinity;
    for (const i of cand) {
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

  tryMergeOuter((s) => isHoriz(s) && Math.abs(s.y1 - minYp) < EPS && Math.abs(s.y2 - minYp) < EPS, 'ow-t');
  tryMergeOuter((s) => isHoriz(s) && Math.abs(s.y1 - maxYp) < EPS && Math.abs(s.y2 - maxYp) < EPS, 'ow-b');
  tryMergeOuter((s) => isVert(s) && Math.abs(s.x1 - minXp) < EPS && Math.abs(s.x2 - minXp) < EPS, 'ow-l');
  tryMergeOuter((s) => isVert(s) && Math.abs(s.x1 - maxXp) < EPS && Math.abs(s.x2 - maxXp) < EPS, 'ow-r');

  const innerWalls: FloorPlanWall[] = [];
  let iw = 0;
  for (let i = 0; i < planSegs.length; i++) {
    if (used.has(i)) continue;
    const s = planSegs[i];
    innerWalls.push({
      id: `iw-${++iw}`,
      x1: s.x1,
      y1: s.y1,
      x2: s.x2,
      y2: s.y2,
      thickness: tIn,
      isOuter: false,
      wallHeight: hWall,
      wallThickness3d: tIn,
    });
  }

  const walls = [...outerWalls, ...innerWalls];

  /* --- Rooms: closed LWPOLYLINE rectangles + TEXT labels --- */
  const roomRectsDxf: { r: { minX: number; maxX: number; minY: number; maxY: number }; label: string }[] = [];

  for (const entity of entities) {
    if (entity.type !== 'LWPOLYLINE' || !entity.shape || !entity.vertices?.length) continue;
    const verts = (entity.vertices as { x: number; y: number }[]).map((v) => ({
      x: v.x * scale,
      y: v.y * scale,
    }));
    const rect = isAxisAlignedRect(verts);
    if (!rect) continue;
    roomRectsDxf.push({ r: rect, label: '' });
  }

  const texts: { x: number; y: number; text: string }[] = [];
  for (const entity of entities) {
    const type = entity.type ?? '';
    if ((type === 'TEXT' || type === 'MTEXT') && entity.text) {
      const pt = (entity.startPoint ?? entity.position) as IPoint | undefined;
      if (!pt) continue;
      texts.push({ x: pt.x * scale, y: pt.y * scale, text: String(entity.text).replace(/\s+/g, ' ').trim() });
    }
  }

  for (const tr of texts) {
    let bestIdx = -1;
    let bestArea = Infinity;
    for (let i = 0; i < roomRectsDxf.length; i++) {
      const { r } = roomRectsDxf[i];
      if (!pointInRect(tr.x, tr.y, r)) continue;
      const area = (r.maxX - r.minX) * (r.maxY - r.minY);
      if (area < bestArea) {
        bestArea = area;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0 && tr.text) {
      roomRectsDxf[bestIdx].label = tr.text;
    }
  }

  const rooms: FloorPlanRoom[] = [];
  let roomIdx = 0;
  for (const { r, label } of roomRectsDxf) {
    const yTop = toPlanY(r.maxY);
    const h = round3(r.maxY - r.minY);
    const w = round3(r.maxX - r.minX);
    const lbl = label || `Room ${++roomIdx}`;
    rooms.push({
      id: slugId(lbl, roomIdx),
      label: lbl,
      x: round3(r.minX),
      y: round3(yTop),
      width: w,
      height: h,
      floor: floorFromLabel(lbl),
    });
  }

  for (const tr of texts) {
    const inside = roomRectsDxf.some(({ r }) => pointInRect(tr.x, tr.y, r));
    if (inside || !tr.text) continue;
    const px = round3(tr.x);
    const py = round3(toPlanY(tr.y));
    roomIdx++;
    rooms.push({
      id: slugId(tr.text, roomIdx),
      label: tr.text,
      x: px,
      y: py,
      width: 2,
      height: 2,
      floor: floorFromLabel(tr.text),
    });
  }

  if (rooms.length === 0 && planSegs.length > 0) {
    const w = round3(maxXp - minXp);
    const h = round3(maxYp - minYp);
    if (w > EPS && h > EPS) {
      rooms.push({
        id: 'space',
        label: 'Floor',
        x: round3(minXp),
        y: round3(minYp),
        width: w,
        height: h,
        floor: { color: '#ececec', material: 'tile' },
      });
    }
  }

  /* --- Stairs from rooms labeled stairs --- */
  const stairs: FloorPlanStairs[] = [];
  let stairN = 0;
  for (const room of rooms) {
    if (/stair/i.test(room.label)) {
      stairs.push({
        id: `stairs-${++stairN}`,
        x: room.x,
        y: room.y,
        width: room.width,
        height: room.height,
        direction: 'up',
      });
    }
  }

  /* --- Doors / windows / furniture from INSERT --- */
  const doors: FloorPlanDoor[] = [];
  const windows: FloorPlanWindow[] = [];
  const furniture: FloorPlanFurniture[] = [];
  let doorN = 0;
  let winN = 0;
  let furnN = 0;

  for (const entity of entities) {
    if (entity.type !== 'INSERT' || !entity.position) continue;
    const pos = entity.position as IPoint;
    const px = round3(pos.x * scale);
    const py = round3(toPlanY(pos.y * scale));
    const name = String(entity.name ?? '').toLowerCase();
    const rot = Number(entity.rotation ?? 0);
    const xScale = Number(entity.xScale ?? 1);
    const yScale = Number(entity.yScale ?? 1);

    if (name.includes('door') || name.includes('d_') || name === 'door') {
      doors.push({
        id: `door-${++doorN}`,
        x: px,
        y: py,
        width: 0.8,
        height: 2.1,
        wallId: nearestWallId(px, py, walls),
        rotation: rot,
        type: 'hinged',
        openDirection: doorN % 2 === 1 ? 'left' : 'right',
        swingAngle: 90,
      });
    } else if (name.includes('win') || name.includes('window') || name.includes('glazing')) {
      windows.push({
        id: `win-${++winN}`,
        x1: px,
        y1: py,
        x2: round3(px + 1.2),
        y2: py,
        height: 1.2,
        sillHeight: 0.9,
        wallId: nearestWallId(px, py, walls),
      });
    } else if (name.includes('stair') && stairs.length === 0) {
      stairs.push({
        id: `stairs-${++stairN}`,
        x: px,
        y: py,
        width: 2.5,
        height: 2.5,
        direction: 'up',
      });
    } else {
      furniture.push(insertToFurniture(`f-${++furnN}`, String(entity.name ?? 'furniture'), px, py, xScale, yScale, rot));
    }
  }

  /* Window openings: short segments on bbox — only add if not already covered by an INSERT window */
  const WINDOW_DEDUPE_DIST = 0.5;
  const wallsBeforeWin = [...outerWalls, ...innerWalls];
  for (const s of planSegs) {
    const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
    if (len < 0.35 || len > 4) continue;
    const onOuter =
      (isHoriz(s) && (Math.abs(s.y1 - minYp) < EPS || Math.abs(s.y1 - maxYp) < EPS)) ||
      (isVert(s) && (Math.abs(s.x1 - minXp) < EPS || Math.abs(s.x1 - maxXp) < EPS));
    if (!onOuter) continue;
    const midx = (s.x1 + s.x2) / 2;
    const midy = (s.y1 + s.y2) / 2;
    const alreadyHasWindow = windows.some(
      (w) => Math.hypot((w.x1 + w.x2) / 2 - midx, (w.y1 + w.y2) / 2 - midy) < WINDOW_DEDUPE_DIST
    );
    if (alreadyHasWindow) continue;
    windows.push({
      id: `win-${++winN}`,
      x1: round3(s.x1),
      y1: round3(s.y1),
      x2: round3(s.x2),
      y2: round3(s.y2),
      height: 1.2,
      sillHeight: 0.9,
      wallId: nearestWallId(midx, midy, wallsBeforeWin),
    });
  }

  return {
    meta,
    rooms,
    walls,
    doors,
    windows,
    stairs,
    furniture,
  };
}
