/**
 * Maps DXF block names (INSERT) to floor-plan furniture defaults.
 * Used when parsing DXF so furniture from FURNITURE layer or non-door/window INSERTs get correct type and dimensions.
 */
import type { FloorPlanFurniture } from './types/floorPlan';

/** Default dimensions and display by furniture type (from Villa Variant B schema). */
const FURNITURE_DEFAULTS: Record<string, { label: string; width: number; depth: number; height3d: number; color3d: string }> = {
  sofa: { label: 'Sofa', width: 2, depth: 0.9, height3d: 0.7, color3d: '#7a6a5a' },
  armchair: { label: 'Armchair', width: 0.8, depth: 0.8, height3d: 0.7, color3d: '#7a6a5a' },
  'coffee-table': { label: 'Coffee Table', width: 1.2, depth: 0.6, height3d: 0.45, color3d: '#a08060' },
  'tv-unit': { label: 'TV Unit', width: 1.5, depth: 0.4, height3d: 0.5, color3d: '#8b7355' },
  bookshelf: { label: 'Bookshelf', width: 1, depth: 0.3, height3d: 1.8, color3d: '#8b7355' },
  fridge: { label: 'Fridge', width: 0.7, depth: 0.7, height3d: 1.7, color3d: '#c0c0c0' },
  stove: { label: 'Stove', width: 0.6, depth: 0.6, height3d: 0.9, color3d: '#c0c0c0' },
  oven: { label: 'Oven', width: 0.6, depth: 0.6, height3d: 0.9, color3d: '#c0c0c0' },
  sink: { label: 'Sink', width: 0.6, depth: 0.5, height3d: 0.85, color3d: '#e8e8e8' },
  counter: { label: 'Counter', width: 1.2, depth: 0.6, height3d: 0.9, color3d: '#a08060' },
  dishwasher: { label: 'Dishwasher', width: 0.6, depth: 0.6, height3d: 0.85, color3d: '#c0c0c0' },
  'dining-table': { label: 'Dining Table', width: 1.6, depth: 0.9, height3d: 0.75, color3d: '#a08060' },
  'dining-chair': { label: 'Chair', width: 0.45, depth: 0.45, height3d: 0.45, color3d: '#7a6a5a' },
  buffet: { label: 'Buffet', width: 0.5, depth: 1.5, height3d: 0.85, color3d: '#8b7355' },
  'bed-double': { label: 'Double Bed', width: 1.6, depth: 2, height3d: 0.55, color3d: '#f5f0e8' },
  'bed-single': { label: 'Single Bed', width: 1, depth: 2, height3d: 0.55, color3d: '#f5f0e8' },
  nightstand: { label: 'Nightstand', width: 0.5, depth: 0.4, height3d: 0.55, color3d: '#a08060' },
  wardrobe: { label: 'Wardrobe', width: 1.2, depth: 0.6, height3d: 1.8, color3d: '#8b7355' },
  dresser: { label: 'Dresser', width: 1, depth: 0.5, height3d: 0.75, color3d: '#8b7355' },
  toilet: { label: 'Toilet', width: 0.4, depth: 0.7, height3d: 0.4, color3d: '#e8e8e8' },
  basin: { label: 'Basin', width: 0.5, depth: 0.4, height3d: 0.85, color3d: '#e8e8e8' },
  shower: { label: 'Shower', width: 0.9, depth: 0.9, height3d: 2, color3d: '#e8e8e8' },
  table: { label: 'Table', width: 1.2, depth: 0.8, height3d: 0.75, color3d: '#a08060' },
  chair: { label: 'Chair', width: 0.5, depth: 0.5, height3d: 0.45, color3d: '#7a6a5a' },
  desk: { label: 'Desk', width: 1.2, depth: 0.6, height3d: 0.75, color3d: '#8b7355' },
  bed: { label: 'Bed', width: 1.6, depth: 2, height3d: 0.55, color3d: '#f5f0e8' },
};

/** Normalize type string (e.g. "SOFA", "COFFEE-TABLE") to key for FURNITURE_DEFAULTS. */
export function normalizeFurnitureType(typeStr: string): string {
  const n = String(typeStr || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  return n || 'furniture';
}

/** Get label, height3d, color3d for a furniture type (e.g. from FURNITURETYPE:TEXT in DXF). */
export function getFurnitureStyle(typeStr: string): { label: string; height3d: number; color3d: string } {
  const type = normalizeFurnitureType(typeStr);
  const def = FURNITURE_DEFAULTS[type] ?? {
    label: type.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    height3d: 0.8,
    color3d: '#8b7355',
  };
  return { label: def.label, height3d: def.height3d, color3d: def.color3d };
}

/** Normalize block name to key for FURNITURE_DEFAULTS (lowercase, hyphenate spaces). */
function blockNameToType(blockName: string): string {
  const n = String(blockName || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  if (!n) return 'furniture';
  if (FURNITURE_DEFAULTS[n]) return n;
  if (/sofa|couch/.test(n)) return 'sofa';
  if (/armchair|arm-chair/.test(n)) return 'armchair';
  if (/coffee|table/.test(n) && !/dining|dinner/.test(n)) return 'coffee-table';
  if (/tv|television/.test(n)) return 'tv-unit';
  if (/book shelf|bookshelf/.test(n)) return 'bookshelf';
  if (/fridge|refrigerator/.test(n)) return 'fridge';
  if (/stove|cooker/.test(n)) return 'stove';
  if (/oven/.test(n)) return 'oven';
  if (/sink/.test(n)) return 'sink';
  if (/counter|worktop/.test(n)) return 'counter';
  if (/dishwasher/.test(n)) return 'dishwasher';
  if (/dining.*table|dinner.*table/.test(n)) return 'dining-table';
  if (/dining.*chair|dinner.*chair|chair/.test(n)) return 'dining-chair';
  if (/buffet|sideboard/.test(n)) return 'buffet';
  if (/double.*bed|bed.*double|king|queen/.test(n)) return 'bed-double';
  if (/single.*bed|bed.*single|twin/.test(n)) return 'bed-single';
  if (/nightstand|bedside|night-stand/.test(n)) return 'nightstand';
  if (/wardrobe|closet/.test(n)) return 'wardrobe';
  if (/dresser|drawer/.test(n)) return 'dresser';
  if (/toilet|wc|loo/.test(n)) return 'toilet';
  if (/basin|sink/.test(n) && !/kitchen/.test(n)) return 'basin';
  if (/shower/.test(n)) return 'shower';
  if (/table/.test(n)) return 'table';
  if (/desk/.test(n)) return 'desk';
  if (/bed/.test(n)) return 'bed-double';
  return n || 'furniture';
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Build a FloorPlanFurniture from DXF INSERT: position (x,y in plan coords), block name, scale, rotation, and id.
 */
export function insertToFurniture(
  id: string,
  blockName: string,
  x: number,
  y: number,
  xScale: number,
  yScale: number,
  rotation: number
): FloorPlanFurniture {
  const type = blockNameToType(blockName);
  const def = FURNITURE_DEFAULTS[type] ?? {
    label: type.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    width: 1,
    depth: 0.6,
    height3d: 0.8,
    color3d: '#8b7355',
  };
  const width = xScale >= 0.2 && xScale <= 5 ? xScale : def.width;
  const depth = yScale >= 0.2 && yScale <= 5 ? yScale : def.depth;
  return {
    id,
    furnitureType: type,
    label: def.label,
    x: round3(x),
    y: round3(y),
    width: round3(width),
    depth: round3(depth),
    rotation: round3(rotation),
    height3d: round3(def.height3d),
    color3d: def.color3d,
  };
}
