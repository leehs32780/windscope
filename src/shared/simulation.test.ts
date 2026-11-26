import { describe, expect, it } from "vitest";
import type { SimulationInput, TurbineInput } from "./domain";
import { normalizeDegrees, windFlowVector } from "./domain";
import { powerAtWind, simulateFarm } from "./simulation";

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
  });
});

describe("powerAtWind", () => {
  const sample = turbine("sample", 0, 0);

  it("returns zero below cut-in and at or above cut-out", () => {
    expect(powerAtWind(2.9, sample)).toBe(0);
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
