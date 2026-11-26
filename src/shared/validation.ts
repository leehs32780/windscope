import { z } from "zod";
import { FARM_COORDINATE_LIMIT_M, WIND_SPEED_MAX_MPS } from "./domain";

export const powerCurvePointSchema = z.object({
  windSpeedMps: z.number().finite().min(0).max(50),
  powerMW: z.number().finite().min(0).max(100)
});

export const turbineInputSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(120),
  xM: z.number().finite().min(-FARM_COORDINATE_LIMIT_M).max(FARM_COORDINATE_LIMIT_M),
  yM: z.number().finite().min(-FARM_COORDINATE_LIMIT_M).max(FARM_COORDINATE_LIMIT_M),
  ratedPowerMW: z.number().finite().positive().max(50),
  rotorDiameterM: z.number().finite().min(20).max(300),
  hubHeightM: z.number().finite().min(20).max(300),
  cutInMps: z.number().finite().min(0).max(25),
  ratedWindMps: z.number().finite().min(1).max(WIND_SPEED_MAX_MPS),
  cutOutMps: z.number().finite().min(5).max(50),
  thrustCoefficient: z.number().finite().min(0).max(0.99),
  wakeExpansion: z.number().finite().min(0).max(0.3),
  command: z.enum(["operational", "manual_stop", "maintenance_stop"]),
  powerCurve: z.array(powerCurvePointSchema).min(2).max(30)
}).superRefine((turbine, context) => {
  if (!(turbine.cutInMps < turbine.ratedWindMps && turbine.ratedWindMps < turbine.cutOutMps)) {
    context.addIssue({ code: "custom", message: "컷인 < 정격 풍속 < 컷아웃 순서여야 합니다.", path: ["ratedWindMps"] });
  }
  const speeds = turbine.powerCurve.map((point) => point.windSpeedMps);
  if (new Set(speeds).size !== speeds.length) {
    context.addIssue({ code: "custom", message: "출력 곡선의 풍속 값은 중복될 수 없습니다.", path: ["powerCurve"] });
  }
});

export const simulationInputSchema = z.object({
  windSpeedMps: z.number().finite().min(0).max(WIND_SPEED_MAX_MPS),
  windDirectionDeg: z.number().finite(),
  airDensityKgM3: z.number().finite().min(0.5).max(2),
  turbines: z.array(turbineInputSchema).max(100)
}).superRefine((input, context) => {
  const ids = input.turbines.map((turbine) => turbine.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", message: "터빈 ID는 시뮬레이션 내에서 고유해야 합니다.", path: ["turbines"] });
  }
});

export const projectCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1_000).optional()
});

export const scenarioCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  sourceScenarioId: z.string().min(1).optional()
});

export const scenarioRenameSchema = z.object({
  name: z.string().trim().min(1).max(120)
});

export const scenarioSettingsSchema = z.object({
  windSpeedMps: z.number().finite().min(0).max(WIND_SPEED_MAX_MPS).optional(),
  windDirectionDeg: z.number().finite().optional(),
  airDensityKgM3: z.number().finite().min(0.5).max(2).optional()
}).refine((settings) => Object.keys(settings).length > 0, "한 가지 이상의 설정을 입력해 주세요.");

export const placementUpdateSchema = z.object({
  xM: z.number().finite().min(-FARM_COORDINATE_LIMIT_M).max(FARM_COORDINATE_LIMIT_M).optional(),
  yM: z.number().finite().min(-FARM_COORDINATE_LIMIT_M).max(FARM_COORDINATE_LIMIT_M).optional(),
  command: z.enum(["operational", "manual_stop", "maintenance_stop"]).optional()
}).refine((placement) => Object.keys(placement).length > 0, "위치 또는 운전 상태를 입력해 주세요.");

