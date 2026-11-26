import type { PowerCurvePoint, SimulationInput, SimulationResult, TurbineInput, TurbineResult } from "./domain";
import { normalizeDegrees, windFlowVector } from "./domain";
import { simulationInputSchema } from "./validation";

export const SIMULATION_MODEL_VERSION = "jensen-circle-overlap-rss-v2";
const DOWNWIND_TOLERANCE_M = 1e-7;

function sortedCurve(points: PowerCurvePoint[]): PowerCurvePoint[] {
  return [...points].sort((a, b) => a.windSpeedMps - b.windSpeedMps);
}

export function powerAtWind(
  windSpeedMps: number,
  turbine: Pick<TurbineInput, "cutInMps" | "ratedWindMps" | "cutOutMps" | "ratedPowerMW" | "powerCurve">,
  airDensityKgM3 = 1.225
): number {
  if (!Number.isFinite(windSpeedMps) || windSpeedMps <= turbine.cutInMps || windSpeedMps >= turbine.cutOutMps) return 0;
  const densityRatio = Math.max(0, airDensityKgM3 / 1.225);
  if (windSpeedMps >= turbine.ratedWindMps) return Math.min(turbine.ratedPowerMW, turbine.ratedPowerMW * densityRatio);

  const curve = sortedCurve(turbine.powerCurve);
  if (curve.length === 0) return 0;
  if (windSpeedMps <= curve[0]!.windSpeedMps) return Math.min(turbine.ratedPowerMW, Math.max(0, curve[0]!.powerMW * densityRatio));
  for (let index = 1; index < curve.length; index += 1) {
    const left = curve[index - 1]!;
    const right = curve[index]!;
    if (windSpeedMps <= right.windSpeedMps) {
      const span = right.windSpeedMps - left.windSpeedMps;
      if (span <= 0) return Math.min(turbine.ratedPowerMW, Math.max(0, right.powerMW));
      const ratio = (windSpeedMps - left.windSpeedMps) / span;
      return Math.min(turbine.ratedPowerMW, Math.max(0, (left.powerMW + ratio * (right.powerMW - left.powerMW)) * densityRatio));
    }
  }
  return Math.min(turbine.ratedPowerMW, Math.max(0, curve[curve.length - 1]!.powerMW * densityRatio));
}

function circleIntersectionArea(firstRadius: number, secondRadius: number, centerDistance: number): number {
  if (firstRadius <= 0 || secondRadius <= 0 || centerDistance >= firstRadius + secondRadius) return 0;
  if (centerDistance <= Math.abs(firstRadius - secondRadius)) {
    const smallerRadius = Math.min(firstRadius, secondRadius);
    return Math.PI * smallerRadius * smallerRadius;
  }
  const firstAngle = Math.acos(Math.max(-1, Math.min(1,
    (centerDistance * centerDistance + firstRadius * firstRadius - secondRadius * secondRadius) /
    (2 * centerDistance * firstRadius)
  )));
  const secondAngle = Math.acos(Math.max(-1, Math.min(1,
    (centerDistance * centerDistance + secondRadius * secondRadius - firstRadius * firstRadius) /
    (2 * centerDistance * secondRadius)
  )));
  const triangularArea = 0.5 * Math.sqrt(Math.max(0,
    (-centerDistance + firstRadius + secondRadius) *
    (centerDistance + firstRadius - secondRadius) *
    (centerDistance - firstRadius + secondRadius) *
    (centerDistance + firstRadius + secondRadius)
  ));
  return firstRadius * firstRadius * firstAngle + secondRadius * secondRadius * secondAngle - triangularArea;
}

function overlapRatio(wakeRadiusM: number, targetRadiusM: number, lateralOffsetM: number): number {
  const targetArea = Math.PI * targetRadiusM * targetRadiusM;
  if (targetArea <= 0) return 0;
  return Math.max(0, Math.min(1, circleIntersectionArea(wakeRadiusM, targetRadiusM, lateralOffsetM) / targetArea));
}

/** Shared centerline velocity deficit for calculation and the 3D wake legend/opacity. */
export function wakeCenterDeficit(thrustCoefficient: number, wakeExpansion: number, rotorRadiusM: number, downwindM: number): number {
  if (![thrustCoefficient, wakeExpansion, rotorRadiusM, downwindM].every(Number.isFinite) || rotorRadiusM <= 0 || downwindM < 0) return 0;
  const ct = Math.max(0, Math.min(0.99, thrustCoefficient));
  const expansion = 1 + (Math.max(0, wakeExpansion) * downwindM) / rotorRadiusM;
  // Jensen/Park: expansion scales the initial deficit, not Ct inside the square root.
  // https://wes.copernicus.org/articles/5/1601/2020/ (equation 6)
  return (1 - Math.sqrt(1 - ct)) / (expansion * expansion);
}

function turbineWakeDeficit(source: TurbineInput, target: TurbineInput, downwindM: number, lateralM: number): number {
  if (downwindM <= DOWNWIND_TOLERANCE_M) return 0;
  const sourceRadiusM = Math.max(0.1, source.rotorDiameterM / 2);
  const targetRadiusM = Math.max(0.1, target.rotorDiameterM / 2);
  const wakeRadiusM = sourceRadiusM + Math.max(0, source.wakeExpansion) * downwindM;
  const rotorCenterDistanceM = Math.hypot(lateralM, target.hubHeightM - source.hubHeightM);
  const overlap = overlapRatio(wakeRadiusM, targetRadiusM, rotorCenterDistanceM);
  if (overlap <= 0) return 0;
  const centerDeficit = wakeCenterDeficit(source.thrustCoefficient, source.wakeExpansion, sourceRadiusM, downwindM);
  return centerDeficit * overlap;
}

function operatingStatus(windMps: number, turbine: TurbineInput): TurbineResult["status"] {
  if (windMps < turbine.cutInMps) return "low_wind";
  if (windMps >= turbine.cutOutMps) return "high_wind";
  return "operating";
}

export function simulateFarm(input: SimulationInput): SimulationResult {
  const validInput = simulationInputSchema.parse(input);
  const windSpeedMps = validInput.windSpeedMps;
  const fromDeg = normalizeDegrees(validInput.windDirectionDeg);
  const flow = windFlowVector(fromDeg);
  const ordered = [...validInput.turbines].sort((first, second) =>
    (first.xM * flow.east + first.yM * flow.north) - (second.xM * flow.east + second.yM * flow.north)
  );
  const results = new Map<string, TurbineResult>();

  for (const target of ordered) {
    const deficitParts: number[] = [];
    const upstreamTurbineIds: string[] = [];
    for (const source of ordered) {
      if (source.id === target.id || source.command !== "operational") continue;
      const deltaEast = target.xM - source.xM;
      const deltaNorth = target.yM - source.yM;
      const downwindM = deltaEast * flow.east + deltaNorth * flow.north;
      if (downwindM <= DOWNWIND_TOLERANCE_M) continue;
      const lateralM = Math.abs(flow.east * deltaNorth - flow.north * deltaEast);
      const sourceResult = results.get(source.id);
      // 수동·정비 정지뿐 아니라 저풍속·강풍 보호 정지 터빈도 후류 원천으로 계산하지 않는다.
      if (!sourceResult || sourceResult.status !== "operating") continue;
      const deficit = turbineWakeDeficit(source, target, downwindM, lateralM);
      if (deficit <= 0) continue;
      deficitParts.push(deficit);
      upstreamTurbineIds.push(source.id);
    }

    const combinedDeficit = Math.min(0.95, Math.sqrt(deficitParts.reduce((sum, deficit) => sum + deficit * deficit, 0)));
    const effectiveWindMps = Math.max(0, windSpeedMps * (1 - combinedDeficit));
    const noWakePowerMW = target.command === "operational"
      ? powerAtWind(windSpeedMps, target, validInput.airDensityKgM3)
      : 0;
    let status: TurbineResult["status"];
    let powerMW = 0;
    if (target.command === "manual_stop") {
      status = "manual_stop";
    } else if (target.command === "maintenance_stop") {
      status = "maintenance_stop";
    } else {
      status = operatingStatus(effectiveWindMps, target);
      if (status === "operating") powerMW = powerAtWind(effectiveWindMps, target, validInput.airDensityKgM3);
    }
    results.set(target.id, {
      turbineId: target.id,
      effectiveWindMps,
      wakeDeficitMps: Math.max(0, windSpeedMps - effectiveWindMps),
      powerMW,
      noWakePowerMW,
      status,
      upstreamTurbineIds
    });
  }

  const turbineResults = ordered.map((turbine) => results.get(turbine.id)!);
  const totalPowerMW = turbineResults.reduce((sum, result) => sum + result.powerMW, 0);
  const noWakePowerMW = turbineResults.reduce((sum, result) => sum + result.noWakePowerMW, 0);
  const wakeLossMW = Math.max(0, noWakePowerMW - totalPowerMW);
  return {
    modelVersion: SIMULATION_MODEL_VERSION,
    totalPowerMW,
    noWakePowerMW,
    wakeLossMW,
    wakeLossPercent: noWakePowerMW > 0 ? (wakeLossMW / noWakePowerMW) * 100 : null,
    turbines: turbineResults
  };
}

