export interface FloorPlanMeta {
  version: number;
  unit: string;
  defaultWallHeight: number;
  defaultWallThickness: number;
  defaultInnerWallThickness: number;
  slabThickness: number;
  floorLevel: number;
  projectName: string;
}

export interface FloorPlanRoomFloor {
  color: string;
  material: string;
}

export interface FloorPlanRoom {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  floor: FloorPlanRoomFloor;
}

export interface FloorPlanWall {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  thickness: number;
  isOuter: boolean;
  wallHeight: number;
  wallThickness3d: number;
}

export interface FloorPlanDoor {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  wallId: string;
  rotation: number;
  type: string;
  openDirection: 'left' | 'right';
  swingAngle: number;
}

export interface FloorPlanWindow {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  height: number;
  sillHeight: number;
  wallId: string;
}

export interface FloorPlanStairs {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  direction: string;
}

export interface FloorPlanFurniture {
  id: string;
  furnitureType: string;
  label: string;
  x: number;
  y: number;
  width: number;
  depth: number;
  rotation: number;
  height3d: number;
  color3d: string;
}

export interface FloorPlan {
  meta: FloorPlanMeta;
  rooms: FloorPlanRoom[];
  walls: FloorPlanWall[];
  doors: FloorPlanDoor[];
  windows: FloorPlanWindow[];
  stairs: FloorPlanStairs[];
  /** FURNITURE (DXF layer name, any case) maps to this array. Key is lowercase "furniture" in JSON. */
  furniture: FloorPlanFurniture[];
}
