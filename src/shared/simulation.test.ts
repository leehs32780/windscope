import { describe, expect, it } from "vitest";
import type { SimulationInput, TurbineInput } from "./domain";
import { farmToWorld, normalizeDegrees, validateLayout, windFlowVector, worldToFarm } from "./domain";
import { powerAtWind, simulateFarm, wakeCenterDeficit } from "./simulation";
import { turbineInputSchema } from "./validation";

const curve = [
  { windSpeedMps: 3, powerMW: 0 },
  { windSpeedMps: 5, powerMW: 0.35 },
  { windSpeedMps: 8, powerMW: 2.4 },
  { windSpeedMps: 10, powerMW: 5.2 },
  { windSpeedMps: 12, powerMW: 8 }
];

function turbine(id: string, xM: number, yM: number, command: TurbineInput["command"] = "operational"): TurbineInput {
  return {
    id,
    name: id,
    xM,
    yM,
    ratedPowerMW: 8,
    rotorDiameterM: 160,
    hubHeightM: 105,
    cutInMps: 3,
    ratedWindMps: 12,
    cutOutMps: 25,
    thrustCoefficient: 0.8,
    wakeExpansion: 0.05,
    command,
    powerCurve: curve
  };
}

function input(turbines: TurbineInput[], windSpeedMps = 10, windDirectionDeg = 0): SimulationInput {
  return { windSpeedMps, windDirectionDeg, airDensityKgM3: 1.225, turbines };
}

describe("wind direction conventions", () => {
  it("normalizes negative and wrapped angles", () => {
    expect(normalizeDegrees(-10)).toBe(350);
    expect(normalizeDegrees(370)).toBe(10);
    expect(normalizeDegrees(360)).toBe(0);
  });

  it("uses the direction the wind flows toward for the vector", () => {
    expect(windFlowVector(0).north).toBeCloseTo(-1);
    expect(windFlowVector(90).east).toBeCloseTo(-1);
    expect(windFlowVector(180).north).toBeCloseTo(1);
    expect(windFlowVector(270).east).toBeCloseTo(1);
    expect(windFlowVector(0).east).toBe(0);
    expect(windFlowVector(90).north).toBe(0);
    expect(() => normalizeDegrees(Infinity)).toThrow(RangeError);
  });

  it("round-trips metre coordinates through the scene's east/north mapping", () => {
    const [worldX, worldZ] = farmToWorld(300, 700);
    expect(worldX).toBeGreaterThan(0);
    expect(worldZ).toBeLessThan(0);
    const [xM, yM] = worldToFarm(worldX, worldZ);
    expect(xM).toBeCloseTo(300);
    expect(yM).toBeCloseTo(700);
  });
});

describe("powerAtWind", () => {
  const sample = turbine("sample", 0, 0);

  it("returns zero below cut-in and at or above cut-out", () => {
    expect(powerAtWind(2.9, sample)).toBe(0);
    expect(powerAtWind(3, sample)).toBe(0);
    expect(powerAtWind(25, sample)).toBe(0);
    expect(powerAtWind(30, sample)).toBe(0);
  });

  it("interpolates curve points and caps output at rated power", () => {
    expect(powerAtWind(6.5, sample)).toBeCloseTo(1.375);
    expect(powerAtWind(12, sample)).toBe(8);
    expect(powerAtWind(20, sample)).toBe(8);
  });

  it("applies the configured air-density correction to estimated output", () => {
    expect(powerAtWind(12, sample, 1.225)).toBe(8);
    expect(powerAtWind(12, sample, 1.0)).toBeCloseTo(8 * (1 / 1.225));
  });
});

describe("simulateFarm", () => {
  it("matches the reference Jensen centerline deficit at 700 m", () => {
    // Ct=.8, R=80 m, k=.05: equation 6 in WES 5, 1601 (2020).
    expect(wakeCenterDeficit(0.8, 0.05, 80, 700)).toBeCloseTo(0.2675110010434987, 12);
    const result = simulateFarm(input([turbine("upstream", 0, 700), turbine("target", 0, 0)]));
    expect(result.turbines.find((item) => item.turbineId === "target")!.effectiveWindMps).toBeCloseTo(7.324889989565014, 10);
  });

  it.each([
    { direction: 0, xM: 120, yM: 0 },
    { direction: 90, xM: 0, yM: 120 },
    { direction: 180, xM: 120, yM: 0 },
    { direction: 270, xM: 0, yM: 120 },
    { direction: 45, xM: 120, yM: -120 }
  ])("does not interpret crosswind float residue as downstream distance ($direction degrees)", ({ direction, xM, yM }) => {
    const result = simulateFarm(input([turbine("first", 0, 0), turbine("second", xM, yM)], 10, direction));
    expect(result.turbines.map((item) => item.upstreamTurbineIds)).toEqual([[], []]);
    expect(result.totalPowerMW).toBeCloseTo(10.4);
  });

  it("includes hub-height separation when checking rotor/wake overlap", () => {
    const upper = { ...turbine("upper", 0, 700), hubHeightM: 300 };
    const result = simulateFarm(input([upper, turbine("lower", 0, 0)]));
    const lower = result.turbines.find((item) => item.turbineId === "lower")!;
    expect(lower.effectiveWindMps).toBe(10);
    expect(lower.upstreamTurbineIds).toEqual([]);
  });

  it("handles zero and near-upper-bound thrust without non-finite output", () => {
    const zeroThrust = { ...turbine("upstream", 0, 700), thrustCoefficient: 0 };
    expect(simulateFarm(input([zeroThrust, turbine("target", 0, 0)])).wakeLossMW).toBe(0);
    const highThrust = { ...zeroThrust, thrustCoefficient: 0.99, wakeExpansion: 0 };
    const result = simulateFarm(input([highThrust, turbine("target", 0, 0)]));
    expect(result.turbines.find((item) => item.turbineId === "target")!.effectiveWindMps).toBeCloseTo(1);
    expect(result.turbines.every((item) => Number.isFinite(item.powerMW) && item.powerMW >= 0 && item.powerMW <= 8)).toBe(true);
  });

  it.each([{ speed: 0, status: "low_wind" }, { speed: 25, status: "high_wind" }])("does not emit wakes from $status turbines", ({ speed, status }) => {
    const result = simulateFarm(input([turbine("upstream", 0, 700), turbine("target", 0, 0)], speed));
    expect(result.totalPowerMW).toBe(0);
    expect(result.wakeLossPercent).toBeNull();
    expect(result.turbines.every((item) => item.status === status && item.upstreamTurbineIds.length === 0)).toBe(true);
  });

  it("preserves physical results when input order changes or direction wraps", () => {
    const farm = [turbine("a", 0, 700), turbine("b", 0, 0), turbine("c", 300, -700)];
    const initial = simulateFarm(input(farm));
    const reordered = simulateFarm(input([...farm].reverse(), 10, 360));
    expect(reordered.totalPowerMW).toBeCloseTo(initial.totalPowerMW, 10);
    for (const result of initial.turbines) {
      expect(reordered.turbines.find((item) => item.turbineId === result.turbineId)).toEqual(result);
    }
  });

  it("applies a wake to a downwind aligned turbine and none to a crosswind turbine", () => {
    const aligned = simulateFarm(input([turbine("upstream", 0, 700), turbine("downstream", 0, 0)]));
    const crosswind = simulateFarm(input([turbine("upstream", 0, 700), turbine("downstream", 350, 0)]));
    const alignedDownstream = aligned.turbines.find((item) => item.turbineId === "downstream")!;
    const crosswindDownstream = crosswind.turbines.find((item) => item.turbineId === "downstream")!;
    expect(alignedDownstream.effectiveWindMps).toBeLessThan(10);
    expect(alignedDownstream.upstreamTurbineIds).toEqual(["upstream"]);
    expect(crosswindDownstream.effectiveWindMps).toBeCloseTo(10);
    expect(crosswindDownstream.upstreamTurbineIds).toEqual([]);
  });

  it("does not create a wake from stopped turbines", () => {
    const result = simulateFarm(input([
      turbine("stopped", 0, 700, "manual_stop"),
      turbine("downstream", 0, 0)
    ]));
    const stopped = result.turbines.find((item) => item.turbineId === "stopped")!;
    const downstream = result.turbines.find((item) => item.turbineId === "downstream")!;
    expect(stopped.powerMW).toBe(0);
    expect(stopped.status).toBe("manual_stop");
    expect(downstream.effectiveWindMps).toBeCloseTo(10);
  });

  it("combines two wake deficits with root-sum-square and safely handles coincident locations", () => {
    const result = simulateFarm(input([
      turbine("upstream-a", -55, 700),
      turbine("upstream-b", 55, 700),
      turbine("target", 0, 0),
      turbine("coincident", 0, 0)
    ]));
    expect(result.turbines.every((item) => Number.isFinite(item.effectiveWindMps))).toBe(true);
    expect(result.turbines.find((item) => item.turbineId === "target")!.upstreamTurbineIds).toHaveLength(2);
    expect(result.turbines.find((item) => item.turbineId === "target")!.effectiveWindMps).toBeGreaterThanOrEqual(0);
  });

  it("returns a null wake-loss ratio for an empty or zero-output farm", () => {
    expect(simulateFarm(input([])).wakeLossPercent).toBeNull();
    const stopped = simulateFarm(input([turbine("stopped", 0, 0, "maintenance_stop")]));
    expect(stopped.totalPowerMW).toBe(0);
    expect(stopped.wakeLossPercent).toBeNull();
  });

  it("rejects non-finite and out-of-range simulation inputs", () => {
    expect(() => simulateFarm({ ...input([]), windSpeedMps: Number.NaN })).toThrow();
    expect(() => simulateFarm({ ...input([]), windSpeedMps: 36 })).toThrow();
  });
});

describe("stored turbine and layout validation", () => {
  it("rejects curves that exceed rated power, decrease, omit anchors, or duplicate wind speeds", () => {
    const sample = turbine("sample", 0, 0);
    const malformedCurves = [
      curve.map((point) => point.windSpeedMps === 10 ? { ...point, powerMW: 9 } : point),
      curve.map((point) => point.windSpeedMps === 10 ? { ...point, powerMW: 1 } : point),
      curve.slice(1),
      curve.slice(0, -1),
      [...curve, curve[2]!],
      [...curve, { windSpeedMps: 25, powerMW: 8 }]
    ];
    for (const powerCurve of malformedCurves) {
      expect(turbineInputSchema.safeParse({ ...sample, powerCurve }).success).toBe(false);
    }
    expect(turbineInputSchema.safeParse({ ...sample, powerCurve: [...curve].reverse() }).success).toBe(true);
  });

  it("rejects impossible rotor clearance and invalid coordinate previews", () => {
    expect(turbineInputSchema.safeParse({ ...turbine("sample", 0, 0), hubHeightM: 70 }).success).toBe(false);
    const issues = validateLayout([{ id: "bad", xM: Number.NaN, yM: 0 }, { id: "outside", xM: 10_001, yM: 0 }]);
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ turbineId: "bad", severity: "error" }),
      expect.objectContaining({ turbineId: "outside", severity: "error" })
    ]));
  });

  it("uses each turbine's rotor size for overlap prevention", () => {
    const first = turbine("first", 0, 0);
    expect(validateLayout([first, turbine("second", 150, 0)])[0]!.severity).toBe("error");
    expect(validateLayout([first, turbine("second", 180, 0)])[0]!.severity).toBe("warning");
    expect(validateLayout([first, turbine("second", 220, 0)])).toEqual([]);
    const largeRotor = { ...turbine("large", 250, 0), rotorDiameterM: 300 };
    expect(validateLayout([{ ...first, rotorDiameterM: 300 }, largeRotor])[0]!.severity).toBe("error");
  });
});
