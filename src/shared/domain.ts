export const WIND_SPEED_MIN_MPS = 0;
export const WIND_SPEED_MAX_MPS = 35;
export const FARM_COORDINATE_LIMIT_M = 10_000;
export const MIN_TURBINE_SPACING_M = 220;
export const SCENE_METERS_TO_UNITS = 0.012;

export type TurbineCommand = "operational" | "manual_stop" | "maintenance_stop";

export type TurbineStatus =
  | "operating"
  | "manual_stop"
  | "maintenance_stop"
  | "low_wind"
  | "high_wind";

export type PowerCurvePoint = {
  windSpeedMps: number;
  powerMW: number;
};

export type TurbineInput = {
  id: string;
  name: string;
  xM: number;
  yM: number;
  ratedPowerMW: number;
  rotorDiameterM: number;
  hubHeightM: number;
  cutInMps: number;
  ratedWindMps: number;
  cutOutMps: number;
  thrustCoefficient: number;
  wakeExpansion: number;
  command: TurbineCommand;
  powerCurve: PowerCurvePoint[];
};

export type SimulationInput = {
  windSpeedMps: number;
  /** Direction the wind comes from: north 0°, clockwise. */
  windDirectionDeg: number;
  airDensityKgM3: number;
  turbines: TurbineInput[];
};

export type TurbineResult = {
  turbineId: string;
  effectiveWindMps: number;
  wakeDeficitMps: number;
  powerMW: number;
  noWakePowerMW: number;
  status: TurbineStatus;
  upstreamTurbineIds: string[];
};

export type SimulationResult = {
  modelVersion: string;
  totalPowerMW: number;
  noWakePowerMW: number;
  wakeLossMW: number;
  wakeLossPercent: number | null;
  turbines: TurbineResult[];
};

export type LayoutIssue = {
  turbineId: string;
  message: string;
  severity: "warning" | "error";
};

export function normalizeDegrees(degrees: number): number {
  if (!Number.isFinite(degrees)) {
    throw new RangeError("풍향은 유한한 숫자여야 합니다.");
  }
  return ((degrees % 360) + 360) % 360;
}

/** Converts a north-referenced direction the wind comes from into an east/north flow vector. */
export function windFlowVector(windDirectionDeg: number): { east: number; north: number } {
  const flowRadians = ((normalizeDegrees(windDirectionDeg) + 180) * Math.PI) / 180;
  return {
    east: Math.abs(Math.sin(flowRadians)) < 1e-12 ? 0 : Math.sin(flowRadians),
    north: Math.abs(Math.cos(flowRadians)) < 1e-12 ? 0 : Math.cos(flowRadians)
  };
}

/** Maps farm coordinates (east, north) to the Three.js horizontal plane (x, z). */
export function farmToWorld(xM: number, yM: number, scale = SCENE_METERS_TO_UNITS): [number, number] {
  return [xM * scale, -yM * scale];
}

export function worldToFarm(x: number, z: number, scale = SCENE_METERS_TO_UNITS): [number, number] {
  return [x / scale, -z / scale];
}

export function validateLayout(turbines: (Pick<TurbineInput, "id" | "xM" | "yM"> & Partial<Pick<TurbineInput, "rotorDiameterM">>)[]): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  for (const turbine of turbines) {
    if (!Number.isFinite(turbine.xM) || !Number.isFinite(turbine.yM)) {
      issues.push({ turbineId: turbine.id, severity: "error", message: "발전기 좌표는 유한한 숫자여야 합니다." });
      continue;
    }
    if (Math.abs(turbine.xM) > FARM_COORDINATE_LIMIT_M || Math.abs(turbine.yM) > FARM_COORDINATE_LIMIT_M) {
      issues.push({ turbineId: turbine.id, severity: "error", message: "단지 허용 경계(±10 km)를 벗어났습니다." });
    }
  }
  for (let firstIndex = 0; firstIndex < turbines.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < turbines.length; secondIndex += 1) {
      const first = turbines[firstIndex]!;
      const second = turbines[secondIndex]!;
      const distanceM = Math.hypot(first.xM - second.xM, first.yM - second.yM);
      // Conservative horizontal clearance for any nacelle orientation.
      const rotorClearanceM = ((first.rotorDiameterM ?? 120) + (second.rotorDiameterM ?? 120)) / 2;
      const recommendedSpacingM = Math.max(MIN_TURBINE_SPACING_M, rotorClearanceM);
      if (distanceM < recommendedSpacingM) {
        const overlapping = distanceM < rotorClearanceM;
        issues.push({
          turbineId: second.id,
          severity: overlapping ? "error" : "warning",
          message: overlapping
            ? `${first.id}와 간격이 ${Math.round(distanceM)} m입니다. 로터가 겹치지 않도록 ${Math.round(rotorClearanceM)} m 이상 떨어뜨려 주세요.`
            : `${first.id}와 간격이 ${Math.round(distanceM)} m입니다. 권장 최소 간격은 ${Math.round(recommendedSpacingM)} m입니다.`
        });
      }
    }
  }
  return issues;
}
