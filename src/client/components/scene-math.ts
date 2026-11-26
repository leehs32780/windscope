import { SCENE_METERS_TO_UNITS, farmToWorld } from "../../shared/domain";
import type { TurbineInput } from "../../shared/domain";

export type FarmPosition = { xM: number; yM: number };
export type SceneBounds = { centerX: number; centerY: number; centerZ: number; span: number; radius: number };

/** Include blade tips so fitting the farm does not clip tall or edge turbines. */
export function getSceneBounds(turbines: TurbineInput[], previews: Record<string, FarmPosition> = {}): SceneBounds {
  if (!turbines.length) return { centerX: 0, centerY: 1, centerZ: 0, span: 12, radius: 9 };
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, maxHeight = 0;
  for (const turbine of turbines) {
    const position = previews[turbine.id] ?? turbine;
    const [x, z] = farmToWorld(position.xM, position.yM);
    const radius = Math.max(0.55, turbine.rotorDiameterM * SCENE_METERS_TO_UNITS / 2);
    minX = Math.min(minX, x - radius);
    maxX = Math.max(maxX, x + radius);
    minZ = Math.min(minZ, z - radius);
    maxZ = Math.max(maxZ, z + radius);
    maxHeight = Math.max(maxHeight, turbine.hubHeightM * SCENE_METERS_TO_UNITS + radius);
  }
  return {
    centerX: (minX + maxX) / 2,
    centerY: maxHeight / 2,
    centerZ: (minZ + maxZ) / 2,
    span: Math.max(maxX - minX, maxZ - minZ, 12),
    radius: Math.max(5, Math.hypot((maxX - minX) / 2, maxHeight / 2, (maxZ - minZ) / 2))
  };
}

/** Sphere fit using the tighter of horizontal and vertical field of view. */
export function fitPerspectiveDistance(radius: number, verticalFovDeg: number, aspect: number): number {
  const verticalHalf = verticalFovDeg * Math.PI / 360;
  const horizontalHalf = Math.atan(Math.tan(verticalHalf) * Math.max(0.1, aspect));
  return Math.max(10, radius / Math.sin(Math.min(verticalHalf, horizontalHalf)) * 1.12);
}

/** Preserve the picked-point offset: a grab on the tower must not jump its base. */
export function dragPosition(origin: FarmPosition, start: FarmPosition, current: FarmPosition): FarmPosition {
  return {
    xM: origin.xM + Math.round((current.xM - start.xM) / 10) * 10,
    yM: origin.yM + Math.round((current.yM - start.yM) / 10) * 10
  };
}
