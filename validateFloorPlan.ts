import type {
  FloorPlan,
  FloorPlanMeta,
  FloorPlanRoom,
  FloorPlanWall,
  FloorPlanDoor,
  FloorPlanWindow,
  FloorPlanFurniture,
} from './types/floorPlan';

export interface ValidateResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  plan: FloorPlan | null;
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isStr(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const DEFAULT_META: Omit<FloorPlanMeta, 'projectName'> = {
  version: 1,
  unit: 'm',
  defaultWallHeight: 2.8,
  defaultWallThickness: 0.2,
  defaultInnerWallThickness: 0.1,
  slabThickness: 0.15,
  floorLevel: 0.01,
};

/**
 * Validates and normalizes floor-plan JSON (source of truth for Konva).
 * Fills defaults so rendering is stable even if some fields are omitted.
 */
export function validateAndNormalizeFloorPlan(input: unknown): ValidateResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isObj(input)) {
    return { ok: false, errors: ['Body must be a JSON object'], warnings: [], plan: null };
  }

  const metaIn = isObj(input.meta) ? input.meta : {};
  const projectName = isStr(metaIn.projectName)
    ? metaIn.projectName
    : typeof metaIn.projectName === 'string'
      ? metaIn.projectName || 'Floor plan'
      : process.env.PROJECT_NAME || 'Floor plan';

  const meta: FloorPlanMeta = {
    version: isNum(metaIn.version) ? metaIn.version : DEFAULT_META.version,
    unit: isStr(metaIn.unit) ? metaIn.unit : DEFAULT_META.unit,
    defaultWallHeight: isNum(metaIn.defaultWallHeight) ? metaIn.defaultWallHeight : DEFAULT_META.defaultWallHeight,
    defaultWallThickness: isNum(metaIn.defaultWallThickness) ? metaIn.defaultWallThickness : DEFAULT_META.defaultWallThickness,
    defaultInnerWallThickness: isNum(metaIn.defaultInnerWallThickness)
      ? metaIn.defaultInnerWallThickness
      : DEFAULT_META.defaultInnerWallThickness,
    slabThickness: isNum(metaIn.slabThickness) ? metaIn.slabThickness : DEFAULT_META.slabThickness,
    floorLevel: isNum(metaIn.floorLevel) ? metaIn.floorLevel : DEFAULT_META.floorLevel,
    projectName,
  };

  if (!Array.isArray(input.rooms)) errors.push('rooms must be an array');
  if (!Array.isArray(input.walls)) errors.push('walls must be an array');
  if (!Array.isArray(input.doors)) errors.push('doors must be an array');
  if (!Array.isArray(input.windows)) errors.push('windows must be an array');

  let stairsInput: unknown[] = [];
  if (!Array.isArray(input.stairs)) {
    if (input.stairs === undefined) {
      warnings.push('stairs omitted — using []');
      stairsInput = [];
    } else {
      errors.push('stairs must be an array');
    }
  } else {
    stairsInput = input.stairs as unknown[];
  }

  if (errors.length) {
    return { ok: false, errors, warnings, plan: null };
  }

  const rooms: FloorPlanRoom[] = (input.rooms as unknown[]).map((r, i) => {
    if (!isObj(r)) {
      errors.push(`rooms[${i}] must be an object`);
      return null as unknown as FloorPlanRoom;
    }
    const floor = isObj(r.floor) ? r.floor : {};
    return {
      id: isStr(r.id) ? r.id : `room-${i}`,
      label: typeof r.label === 'string' ? r.label : `Room ${i}`,
      x: isNum(r.x) ? r.x : 0,
      y: isNum(r.y) ? r.y : 0,
      width: isNum(r.width) ? r.width : 0,
      height: isNum(r.height) ? r.height : 0,
      floor: {
        color: isStr(floor.color) ? floor.color : '#ececec',
        material: isStr(floor.material) ? floor.material : 'tile',
      },
    };
  });

  const walls: FloorPlanWall[] = (input.walls as unknown[]).map((w, i) => {
    if (!isObj(w)) {
      errors.push(`walls[${i}] must be an object`);
      return null as unknown as FloorPlanWall;
    }
    const id = isStr(w.id) ? w.id : `w-${i}`;
    const isOuter = typeof w.isOuter === 'boolean' ? w.isOuter : /^ow-/i.test(id);
    const thickness = isNum(w.thickness) ? w.thickness : isOuter ? meta.defaultWallThickness : meta.defaultInnerWallThickness;
    const wh = isNum(w.wallHeight) ? w.wallHeight : meta.defaultWallHeight;
    const wt = isNum(w.wallThickness3d) ? w.wallThickness3d : thickness;
    return {
      id,
      x1: isNum(w.x1) ? w.x1 : 0,
      y1: isNum(w.y1) ? w.y1 : 0,
      x2: isNum(w.x2) ? w.x2 : 0,
      y2: isNum(w.y2) ? w.y2 : 0,
      thickness,
      isOuter,
      wallHeight: wh,
      wallThickness3d: wt,
    };
  });

  const doors: FloorPlanDoor[] = (input.doors as unknown[]).map((d, i) => {
    if (!isObj(d)) {
      errors.push(`doors[${i}] must be an object`);
      return null as unknown as FloorPlanDoor;
    }
    const od = d.openDirection === 'right' ? 'right' : 'left';
    return {
      id: isStr(d.id) ? d.id : `door-${i}`,
      x: isNum(d.x) ? d.x : 0,
      y: isNum(d.y) ? d.y : 0,
      width: isNum(d.width) ? d.width : 0.8,
      height: isNum(d.height) ? d.height : 2.1,
      wallId: typeof d.wallId === 'string' ? d.wallId : '',
      rotation: isNum(d.rotation) ? d.rotation : 0,
      type: isStr(d.type) ? d.type : 'hinged',
      openDirection: od,
      swingAngle: isNum(d.swingAngle) ? d.swingAngle : 90,
    };
  });

  const windows: FloorPlanWindow[] = (input.windows as unknown[]).map((win, i) => {
    if (!isObj(win)) {
      errors.push(`windows[${i}] must be an object`);
      return null as unknown as FloorPlanWindow;
    }
    return {
      id: isStr(win.id) ? win.id : `win-${i}`,
      x1: isNum(win.x1) ? win.x1 : 0,
      y1: isNum(win.y1) ? win.y1 : 0,
      x2: isNum(win.x2) ? win.x2 : 0,
      y2: isNum(win.y2) ? win.y2 : 0,
      height: isNum(win.height) ? win.height : 1.2,
      sillHeight: isNum(win.sillHeight) ? win.sillHeight : 0.9,
      wallId: typeof win.wallId === 'string' ? win.wallId : '',
    };
  });

  const stairs = stairsInput.map((s, i) => {
    if (!isObj(s)) {
      errors.push(`stairs[${i}] must be an object`);
      return null;
    }
    return {
      id: isStr(s.id) ? s.id : `stairs-${i}`,
      x: isNum(s.x) ? s.x : 0,
      y: isNum(s.y) ? s.y : 0,
      width: isNum(s.width) ? s.width : 0,
      height: isNum(s.height) ? s.height : 0,
      direction: isStr(s.direction) ? s.direction : 'up',
    };
  });

  const furnitureInput = Array.isArray(input.furniture) ? input.furniture : [];
  const furniture: FloorPlanFurniture[] = furnitureInput.map((f, i) => {
    if (!isObj(f)) return null as unknown as FloorPlanFurniture;
    return {
      id: isStr(f.id) ? f.id : `f-${i + 1}`,
      furnitureType: typeof f.furnitureType === 'string' ? f.furnitureType : 'furniture',
      label: typeof f.label === 'string' ? f.label : (typeof f.furnitureType === 'string' ? f.furnitureType : 'Furniture'),
      x: isNum(f.x) ? f.x : 0,
      y: isNum(f.y) ? f.y : 0,
      width: isNum(f.width) ? f.width : 1,
      depth: isNum(f.depth) ? f.depth : 0.6,
      rotation: isNum(f.rotation) ? f.rotation : 0,
      height3d: isNum(f.height3d) ? f.height3d : 0.8,
      color3d: isStr(f.color3d) ? f.color3d : '#8b7355',
    };
  }).filter(Boolean) as FloorPlanFurniture[];

  if (errors.length) {
    return { ok: false, errors, warnings, plan: null };
  }

  const anyWallMissing3d = (input.walls as unknown[]).some(
    (w) => isObj(w) && (!isNum(w.wallHeight) || !isNum(w.wallThickness3d))
  );
  if (anyWallMissing3d) {
    warnings.push('Some walls were missing wallHeight/wallThickness3d; defaults from meta were applied.');
  }

  const plan: FloorPlan = {
    meta,
    rooms,
    walls,
    doors,
    windows,
    stairs: stairs.filter(Boolean) as FloorPlan['stairs'],
    furniture,
  };

  return { ok: true, errors: [], warnings, plan };
}
