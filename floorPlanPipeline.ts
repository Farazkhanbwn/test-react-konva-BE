/**
 * Single pipeline: raw input → schema-safe plan for Konva.
 * Step order: unwrap → coerce → validate/normalize → finalize (bounds, wallIds, rounding).
 */
import type { FloorPlan, FloorPlanWall, FloorPlanFurniture } from './types/floorPlan';
import { nearestWallId } from './wallUtils';

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** API may send { plan }, { data }, or { floorPlan } */
export function unwrapFloorPlanPayload(raw: unknown): unknown {
  if (!isObj(raw)) return raw;
  if (Array.isArray(raw.rooms) && Array.isArray(raw.walls)) return raw;
  const plan = raw.plan;
  if (isObj(plan) && Array.isArray(plan.rooms) && Array.isArray(plan.walls)) return plan;
  const data = raw.data;
  if (isObj(data) && Array.isArray(data.rooms) && Array.isArray(data.walls)) return data;
  const fp = raw.floorPlan;
  if (isObj(fp) && Array.isArray(fp.rooms) && Array.isArray(fp.walls)) return fp;
  return raw;
}
import { validateAndNormalizeFloorPlan, type ValidateResult } from './validateFloorPlan';

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** JSON from some tools uses string numbers — Konva needs real numbers */
export function coerceNumericFields(input: unknown): unknown {
  if (input === null || input === undefined) return input;
  if (typeof input === 'string') {
    const t = input.trim();
    if (t === '') return input;
    const n = Number(t);
    if (Number.isFinite(n) && String(n) === t.replace(/^\+/, '')) return n;
    const f = parseFloat(t);
    if (Number.isFinite(f) && /^-?\d*\.?\d+(e[+-]?\d+)?$/i.test(t.replace(/\s/g, ''))) return f;
    return input;
  }
  if (Array.isArray(input)) return input.map(coerceNumericFields);
  if (typeof input === 'object') {
    const o = input as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o)) out[k] = coerceNumericFields(o[k]);
    return out;
  }
  return input;
}

/**
 * After validation: round coords, fix bad wallIds, compute Konva viewport hints.
 */
export function finalizePlanForKonva(plan: FloorPlan): {
  plan: FloorPlan;
  konva: {
    bounds: { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number };
    suggestedPixelsPerMeter: number;
  };
  issues: string[];
} {
  const issues: string[] = [];
  const wallIds = new Set(plan.walls.map((w) => w.id));

  const roundWall = (w: FloorPlanWall): FloorPlanWall => ({
    ...w,
    x1: round3(w.x1),
    y1: round3(w.y1),
    x2: round3(w.x2),
    y2: round3(w.y2),
    thickness: round3(w.thickness),
    wallHeight: round3(w.wallHeight),
    wallThickness3d: round3(w.wallThickness3d),
  });

  const walls = plan.walls.map(roundWall);

  const doors = plan.doors.map((d) => {
    let wallId = d.wallId;
    if (wallId && !wallIds.has(wallId)) {
      const best = nearestWallId(d.x, d.y, walls);
      issues.push(`door ${d.id}: wallId "${wallId}" not found → remapped to "${best}"`);
      wallId = best;
    }
    return {
      ...d,
      x: round3(d.x),
      y: round3(d.y),
      width: round3(d.width),
      height: round3(d.height),
      wallId,
      swingAngle: round3(d.swingAngle),
    };
  });

  const windows = plan.windows.map((win) => {
    let wallId = win.wallId;
    if (wallId && !wallIds.has(wallId)) {
      const mx = (win.x1 + win.x2) / 2;
      const my = (win.y1 + win.y2) / 2;
      const best = nearestWallId(mx, my, walls);
      issues.push(`window ${win.id}: wallId "${wallId}" not found → remapped to "${best}"`);
      wallId = best;
    }
    return {
      ...win,
      x1: round3(win.x1),
      y1: round3(win.y1),
      x2: round3(win.x2),
      y2: round3(win.y2),
      height: round3(win.height),
      sillHeight: round3(win.sillHeight),
      wallId,
    };
  });

  const rooms = plan.rooms.map((r) => ({
    ...r,
    x: round3(r.x),
    y: round3(r.y),
    width: round3(r.width),
    height: round3(r.height),
  }));

  const stairs = plan.stairs.map((s) => ({
    ...s,
    x: round3(s.x),
    y: round3(s.y),
    width: round3(s.width),
    height: round3(s.height),
  }));

  const furniture: FloorPlanFurniture[] = (Array.isArray(plan.furniture) ? plan.furniture : []).map((f) => ({
    ...f,
    x: round3(f.x),
    y: round3(f.y),
    width: round3(f.width),
    depth: round3(f.depth),
    rotation: round3(f.rotation),
    height3d: round3(f.height3d),
  }));

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const r of rooms) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  for (const w of walls) {
    minX = Math.min(minX, w.x1, w.x2);
    minY = Math.min(minY, w.y1, w.y2);
    maxX = Math.max(maxX, w.x1, w.x2);
    maxY = Math.max(maxY, w.y1, w.y2);
  }
  for (const f of furniture) {
    minX = Math.min(minX, f.x);
    minY = Math.min(minY, f.y);
    maxX = Math.max(maxX, f.x + f.width);
    maxY = Math.max(maxY, f.y + f.depth);
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 12;
    maxY = 8;
  }
  const pad = 0.5;
  const bounds = {
    minX: round3(minX - pad),
    minY: round3(minY - pad),
    maxX: round3(maxX + pad),
    maxY: round3(maxY + pad),
    width: round3(maxX - minX + 2 * pad),
    height: round3(maxY - minY + 2 * pad),
  };

  const finalized: FloorPlan = {
    meta: { ...plan.meta },
    rooms,
    walls,
    doors,
    windows,
    stairs,
    furniture,
  };

  return {
    plan: finalized,
    konva: {
      bounds,
      suggestedPixelsPerMeter: 50,
    },
    issues,
  };
}

export interface PipelineDebugStep {
  step: number;
  phase: string;
  detail?: string;
  counts?: Record<string, number>;
  bounds?: { width: number; height: number };
}

export interface PipelineResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  plan: FloorPlan | null;
  konva: ReturnType<typeof finalizePlanForKonva>['konva'] | null;
  issues: string[];
  debugSteps?: PipelineDebugStep[];
}

export interface RunPipelineOptions {
  debug?: boolean;
}

/** Full pipeline for any raw JSON body */
export function runFloorPlanPipeline(raw: unknown, opts: RunPipelineOptions = {}): PipelineResult {
  const debugSteps: PipelineDebugStep[] = [];
  let step = 0;

  const unwrapped = unwrapFloorPlanPayload(raw);
  if (opts.debug && unwrapped !== raw) {
    debugSteps.push({
      step: ++step,
      phase: 'unwrap_payload',
      detail: 'Used body.plan / body.data / body.floorPlan (top-level had no rooms+walls)',
    });
  }

  const coerced = coerceNumericFields(unwrapped);
  if (opts.debug) {
    debugSteps.push({
      step: ++step,
      phase: 'coerce_numeric_strings',
      detail: 'String numbers (e.g. "5.0") → number for Konva',
    });
  }

  const validated: ValidateResult = validateAndNormalizeFloorPlan(coerced);
  if (!validated.ok || !validated.plan) {
    if (opts.debug) {
      debugSteps.push({
        step: ++step,
        phase: 'validate_schema',
        detail: `FAILED: ${validated.errors.join('; ')}`,
      });
    }
    return {
      ok: false,
      errors: validated.errors,
      warnings: validated.warnings,
      plan: null,
      konva: null,
      issues: [],
      debugSteps: opts.debug ? debugSteps : undefined,
    };
  }

  if (opts.debug) {
    const p = validated.plan;
    debugSteps.push({
      step: ++step,
      phase: 'validate_schema',
      detail: 'meta, rooms, walls, doors, windows, stairs, furniture OK',
      counts: {
        rooms: p.rooms.length,
        walls: p.walls.length,
        doors: p.doors.length,
        windows: p.windows.length,
        stairs: p.stairs.length,
        furniture: p.furniture.length,
      },
    });
  }

  const { plan, konva, issues } = finalizePlanForKonva(validated.plan);
  if (opts.debug) {
    debugSteps.push({
      step: ++step,
      phase: 'finalize_konva',
      detail:
        'Round coords; fix door/window wallIds; compute Stage bounds. Use konva.bounds + suggestedPixelsPerMeter for React Stage size/scale.',
      bounds: { width: konva.bounds.width, height: konva.bounds.height },
    });
  }

  return {
    ok: true,
    errors: [],
    warnings: [...validated.warnings, ...issues.map((i) => `[finalize] ${i}`)],
    plan,
    konva,
    issues,
    debugSteps: opts.debug ? debugSteps : undefined,
  };
}
