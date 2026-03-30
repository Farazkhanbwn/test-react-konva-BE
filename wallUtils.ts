/**
 * Shared wall helpers: nearestWallId (prefer point-on-segment), merge collinear segments.
 */
import type { FloorPlanWall } from './types/floorPlan';

export type Seg = { x1: number; y1: number; x2: number; y2: number };

const EPS = 1e-4;
const ON_WALL_THRESHOLD = 0.15;

/**
 * Distance from point to segment; t is the projection parameter (0..1 = on segment).
 */
export function distPointToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): { dist: number; t: number } {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) {
    const d = Math.hypot(px - x1, py - y1);
    return { dist: d, t: 0 };
  }
  const t = ((px - x1) * dx + (py - y1) * dy) / len2;
  const tClamp = Math.max(0, Math.min(1, t));
  const qx = x1 + tClamp * dx;
  const qy = y1 + tClamp * dy;
  return { dist: Math.hypot(px - qx, py - qy), t };
}

/**
 * Prefer wall where (px,py) projects onto the segment (t in 0..1) and is close;
 * otherwise fall back to closest wall by distance.
 */
export function nearestWallId(px: number, py: number, walls: FloorPlanWall[]): string {
  let bestOnWall: string | null = null;
  let bestOnWallDist = Infinity;
  let bestAny = walls[0]?.id ?? '';
  let bestAnyDist = Infinity;

  for (const w of walls) {
    const { dist, t } = distPointToSegment(px, py, w.x1, w.y1, w.x2, w.y2);
    const onSegment = t >= -EPS && t <= 1 + EPS && dist <= ON_WALL_THRESHOLD;
    if (onSegment && dist < bestOnWallDist) {
      bestOnWallDist = dist;
      bestOnWall = w.id;
    }
    if (dist < bestAnyDist) {
      bestAnyDist = dist;
      bestAny = w.id;
    }
  }
  return bestOnWall ?? bestAny;
}

/**
 * Merge collinear segments that share an endpoint or overlap.
 * Returns new array of segments (horizontal and vertical grouped and merged).
 */
export function mergeCollinearSegments(segs: Seg[], eps: number = EPS): Seg[] {
  const isHoriz = (s: Seg) => Math.abs(s.y1 - s.y2) <= eps;
  const isVert = (s: Seg) => Math.abs(s.x1 - s.x2) <= eps;

  const out: Seg[] = [];

  const horiz = segs.filter(isHoriz).map((s) => {
    const [x1, x2] = s.x1 <= s.x2 ? [s.x1, s.x2] : [s.x2, s.x1];
    return { x1, x2, y: (s.y1 + s.y2) / 2 };
  });
  const vert = segs.filter(isVert).map((s) => {
    const [y1, y2] = s.y1 <= s.y2 ? [s.y1, s.y2] : [s.y2, s.y1];
    return { y1, y2, x: (s.x1 + s.x2) / 2 };
  });

  const mergeHoriz = (arr: { x1: number; x2: number; y: number }[]) => {
    const byY = new Map<number, { x1: number; x2: number }[]>();
    for (const s of arr) {
      const y = Math.round(s.y / eps) * eps;
      if (!byY.has(y)) byY.set(y, []);
      byY.get(y)!.push({ x1: s.x1, x2: s.x2 });
    }
    for (const [y, lines] of byY) {
      lines.sort((a, b) => a.x1 - b.x1);
      let cur = lines[0];
      for (let i = 1; i < lines.length; i++) {
        const n = lines[i];
        if (n.x1 <= cur.x2 + eps) {
          cur = { x1: cur.x1, x2: Math.max(cur.x2, n.x2) };
        } else {
          out.push({ x1: cur.x1, y1: y, x2: cur.x2, y2: y });
          cur = n;
        }
      }
      out.push({ x1: cur.x1, y1: y, x2: cur.x2, y2: y });
    }
  };

  const mergeVert = (arr: { y1: number; y2: number; x: number }[]) => {
    const byX = new Map<number, { y1: number; y2: number }[]>();
    for (const s of arr) {
      const x = Math.round(s.x / eps) * eps;
      if (!byX.has(x)) byX.set(x, []);
      byX.get(x)!.push({ y1: s.y1, y2: s.y2 });
    }
    for (const [x, lines] of byX) {
      lines.sort((a, b) => a.y1 - b.y1);
      let cur = lines[0];
      for (let i = 1; i < lines.length; i++) {
        const n = lines[i];
        if (n.y1 <= cur.y2 + eps) {
          cur = { y1: cur.y1, y2: Math.max(cur.y2, n.y2) };
        } else {
          out.push({ x1: x, y1: cur.y1, x2: x, y2: cur.y2 });
          cur = n;
        }
      }
      out.push({ x1: x, y1: cur.y1, x2: x, y2: cur.y2 });
    }
  };

  mergeHoriz(horiz);
  mergeVert(vert);

  const diag = segs.filter((s) => !isHoriz(s) && !isVert(s));
  out.push(...diag);

  return out;
}

/** DXF ARC: center (m), radius (m), startAngle/endAngle in degrees. Returns line segments. */
const DEFAULT_ARC_STEPS = 16;

export function arcToSegments(
  centerX: number,
  centerY: number,
  radius: number,
  startAngleDeg: number,
  endAngleDeg: number,
  steps: number = DEFAULT_ARC_STEPS
): Seg[] {
  const segs: Seg[] = [];
  let start = startAngleDeg;
  let end = endAngleDeg;
  if (end < start) end += 360;
  const span = end - start;
  const n = Math.max(2, Math.min(steps, Math.ceil((span / 360) * 24)));
  let prevX = centerX + radius * Math.cos((start * Math.PI) / 180);
  let prevY = centerY + radius * Math.sin((start * Math.PI) / 180);
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const angleDeg = start + t * span;
    const rad = (angleDeg * Math.PI) / 180;
    const x = centerX + radius * Math.cos(rad);
    const y = centerY + radius * Math.sin(rad);
    segs.push({ x1: prevX, y1: prevY, x2: x, y2: y });
    prevX = x;
    prevY = y;
  }
  return segs;
}
