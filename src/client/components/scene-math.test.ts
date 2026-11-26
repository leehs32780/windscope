import { describe, expect, it } from "vitest";
import { dragPosition, fitPerspectiveDistance, getSceneBounds } from "./scene-math";
import { SCENE_METERS_TO_UNITS } from "../../shared/domain";
import type { TurbineInput } from "../../shared/domain";

const turbine = (id: string, xM: number, yM: number) => ({ id, xM, yM, hubHeightM: 105, rotorDiameterM: 160 } as TurbineInput);

describe("3D placement and camera geometry", () => {
  it("does not move or snap an off-grid turbine when first grabbed", () => {
    expect(dragPosition({ xM: 123, yM: 457 }, { xM: 190, yM: 500 }, { xM: 190, yM: 500 }))
      .toEqual({ xM: 123, yM: 457 });
    expect(dragPosition({ xM: 123, yM: 457 }, { xM: 190, yM: 500 }, { xM: 215, yM: 481 }))
      .toEqual({ xM: 153, yM: 437 });
  });
  it("centers translated farms and contains every turbine blade-tip bound", () => {
    const farm = [turbine("a", 8500, 9000), turbine("b", 9500, 10000)];
    const bounds = getSceneBounds(farm);
    expect(bounds.centerX).toBeCloseTo(9000 * SCENE_METERS_TO_UNITS);
    expect(bounds.centerZ).toBeCloseTo(-9500 * SCENE_METERS_TO_UNITS);
    for (const item of farm) {
      const tipRadius = item.rotorDiameterM * SCENE_METERS_TO_UNITS / 2;
      for (const dx of [-tipRadius, tipRadius]) for (const dz of [-tipRadius, tipRadius]) {
        const distance = Math.hypot(item.xM * SCENE_METERS_TO_UNITS + dx - bounds.centerX,
          -bounds.centerY, -item.yM * SCENE_METERS_TO_UNITS + dz - bounds.centerZ);
        expect(distance).toBeLessThanOrEqual(bounds.radius + 1e-9);
      }
    }
  });
  it("keeps extreme layouts inside portrait and landscape camera fields", () => {
    const bounds = getSceneBounds([turbine("a", -10000, -10000), turbine("b", 10000, 10000)]);
    const portrait = fitPerspectiveDistance(bounds.radius, 42, 0.4);
    const landscape = fitPerspectiveDistance(bounds.radius, 42, 2);
    expect(portrait).toBeGreaterThan(landscape);
    for (const aspect of [0.4, 1, 2]) {
      const distance = fitPerspectiveDistance(bounds.radius, 42, aspect);
      const halfFov = Math.min(42 * Math.PI / 360, Math.atan(Math.tan(42 * Math.PI / 360) * aspect));
      expect(Math.asin(bounds.radius / distance)).toBeLessThan(halfFov);
    }
  });
  it("includes drag previews without changing persisted input", () => {
    const farm = [turbine("a", 0, 0)];
    expect(getSceneBounds(farm, { a: { xM: 2000, yM: -1000 } }).centerX).toBeCloseTo(24);
    expect(farm[0]!.xM).toBe(0);
    expect(Number.isFinite(getSceneBounds([]).radius)).toBe(true);
  });
});
