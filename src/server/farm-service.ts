import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import type { PowerCurvePoint, SimulationInput, SimulationResult, TurbineInput } from "../shared/domain";
import { validateLayout } from "../shared/domain";
import { powerCurvePointSchema } from "../shared/validation";
import { simulateFarm } from "../shared/simulation";
import type { WindScopeDatabase } from "./db/client";
import { projects, scenarios, scenarioTurbines, simulationRuns, turbineSimulationResults, turbines } from "./db/schema";
import { ApiError, conflict, notFound } from "./http-error";

function parsePowerCurve(value: string): PowerCurvePoint[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new ApiError(500, "INVALID_STORED_CURVE", "저장된 터빈 출력 곡선을 읽을 수 없습니다.");
  }
  const parsed = powerCurvePointSchema.array().safeParse(decoded);
  if (!parsed.success) throw new ApiError(500, "INVALID_STORED_CURVE", "저장된 터빈 출력 곡선이 올바르지 않습니다.");
  return parsed.data;
}

export async function listProjects(db: WindScopeDatabase) {
  return db.select({ id: projects.id, name: projects.name, description: projects.description })
    .from(projects)
    .orderBy(asc(projects.createdAt))
    .all();
}

export async function createProject(db: WindScopeDatabase, input: { name: string; description?: string }) {
  const projectId = randomUUID();
  const baselineId = randomUUID();
  const experimentId = randomUUID();
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.insert(projects).values({ id: projectId, name: input.name, description: input.description ?? null, createdAt: now, updatedAt: now }).run();
    await tx.insert(scenarios).values([
      { id: baselineId, projectId, name: "기준 배치", role: "baseline", windSpeedMps: 9.5, windDirectionDeg: 0, airDensityKgM3: 1.225, createdAt: now, updatedAt: now },
      { id: experimentId, projectId, name: "실험 시나리오", role: "experiment", windSpeedMps: 9.5, windDirectionDeg: 0, airDensityKgM3: 1.225, createdAt: now, updatedAt: now }
    ]).run();
  });
  return getProject(db, projectId);
}

export async function getProject(db: WindScopeDatabase, projectId: string) {
  const project = await db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) notFound("프로젝트를 찾을 수 없습니다.");
  const [projectTurbines, projectScenarios] = await Promise.all([
    db.select().from(turbines).where(eq(turbines.projectId, projectId)).orderBy(asc(turbines.displayOrder)).all(),
    db.select().from(scenarios).where(eq(scenarios.projectId, projectId)).orderBy(asc(scenarios.createdAt)).all()
  ]);
  return {
    ...project,
    turbines: projectTurbines.map((turbine) => ({ ...turbine, powerCurve: parsePowerCurve(turbine.powerCurveJson) })),
    scenarios: projectScenarios,
    baselineScenarioId: projectScenarios.find((scenario) => scenario.role === "baseline")?.id ?? null
  };
}

export async function listProjectTurbines(db: WindScopeDatabase, projectId: string) {
  const project = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get();
  if (!project) notFound("프로젝트를 찾을 수 없습니다.");
  const rows = await db.select().from(turbines).where(eq(turbines.projectId, projectId)).orderBy(asc(turbines.displayOrder)).all();
  return rows.map((turbine) => ({ ...turbine, powerCurve: parsePowerCurve(turbine.powerCurveJson) }));
}

async function requireScenario(db: WindScopeDatabase, scenarioId: string) {
  const scenario = await db.select().from(scenarios).where(eq(scenarios.id, scenarioId)).get();
  if (!scenario) notFound("시나리오를 찾을 수 없습니다.");
  return scenario;
}

export async function getScenario(db: WindScopeDatabase, scenarioId: string) {
  const scenario = await requireScenario(db, scenarioId);
  const placements = await db.select({
    id: turbines.id,
    name: turbines.name,
    projectId: turbines.projectId,
    xM: scenarioTurbines.xM,
    yM: scenarioTurbines.yM,
    command: scenarioTurbines.command,
    ratedPowerMW: turbines.ratedPowerMW,
    rotorDiameterM: turbines.rotorDiameterM,
    hubHeightM: turbines.hubHeightM,
    cutInMps: turbines.cutInMps,
    ratedWindMps: turbines.ratedWindMps,
    cutOutMps: turbines.cutOutMps,
    thrustCoefficient: turbines.thrustCoefficient,
    wakeExpansion: turbines.wakeExpansion,
    powerCurveJson: turbines.powerCurveJson,
    displayOrder: turbines.displayOrder
  }).from(scenarioTurbines)
    .innerJoin(turbines, eq(scenarioTurbines.turbineId, turbines.id))
    .where(eq(scenarioTurbines.scenarioId, scenarioId))
    .orderBy(asc(turbines.displayOrder))
    .all();
  return {
    ...scenario,
    turbines: placements.map((placement) => ({
      ...placement,
      powerCurve: parsePowerCurve(placement.powerCurveJson)
    }))
  };
}

export async function createExperimentScenario(
  db: WindScopeDatabase,
  projectId: string,
  name: string,
  sourceScenarioId?: string
) {
  const project = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get();
  if (!project) notFound("프로젝트를 찾을 수 없습니다.");
  const source = sourceScenarioId
    ? await requireScenario(db, sourceScenarioId)
    : await db.select().from(scenarios).where(and(eq(scenarios.projectId, projectId), eq(scenarios.role, "baseline"))).get();
  if (!source) notFound("복제할 기준 시나리오를 찾을 수 없습니다.");
  if (source.projectId !== projectId) conflict("다른 프로젝트의 시나리오는 복제할 수 없습니다.");
  const sourcePlacements = await db.select().from(scenarioTurbines).where(eq(scenarioTurbines.scenarioId, source.id)).all();
  const scenarioId = randomUUID();
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.insert(scenarios).values({
      id: scenarioId,
      projectId,
      name,
      role: "experiment",
      windSpeedMps: source.windSpeedMps,
      windDirectionDeg: source.windDirectionDeg,
      airDensityKgM3: source.airDensityKgM3,
      createdAt: now,
      updatedAt: now
    }).run();
    if (sourcePlacements.length > 0) {
      await tx.insert(scenarioTurbines).values(sourcePlacements.map((placement) => ({
        scenarioId,
        turbineId: placement.turbineId,
        xM: placement.xM,
        yM: placement.yM,
        command: placement.command,
        updatedAt: now
      }))).run();
    }
  });
  return getScenario(db, scenarioId);
}

export async function renameScenario(db: WindScopeDatabase, scenarioId: string, name: string) {
  const scenario = await requireScenario(db, scenarioId);
  if (scenario.role === "baseline") conflict("기준 시나리오는 이름을 바꿀 수 없습니다.");
  await db.update(scenarios).set({ name, updatedAt: new Date().toISOString() }).where(eq(scenarios.id, scenarioId)).run();
  return getScenario(db, scenarioId);
}

export async function updateScenarioSettings(
  db: WindScopeDatabase,
  scenarioId: string,
  settings: Partial<Pick<typeof scenarios.$inferSelect, "windSpeedMps" | "windDirectionDeg" | "airDensityKgM3">>
) {
  const scenario = await requireScenario(db, scenarioId);
  if (scenario.role === "baseline") conflict("기준 시나리오는 변경할 수 없습니다. 실험 시나리오를 복제해 사용해 주세요.");
  const update = {
    ...settings,
    windDirectionDeg: settings.windDirectionDeg === undefined ? undefined : ((settings.windDirectionDeg % 360) + 360) % 360,
    updatedAt: new Date().toISOString()
  };
  await db.update(scenarios).set(update).where(eq(scenarios.id, scenarioId)).run();
  return getScenario(db, scenarioId);
}

export async function updateTurbinePlacement(
  db: WindScopeDatabase,
  scenarioId: string,
  turbineId: string,
  update: { xM?: number; yM?: number; command?: "operational" | "manual_stop" | "maintenance_stop" }
) {
  const scenario = await requireScenario(db, scenarioId);
  if (scenario.role === "baseline") conflict("기준 배치는 읽기 전용입니다. 실험 시나리오에서 위치를 바꿔 주세요.");
  const detail = await getScenario(db, scenarioId);
  const target = detail.turbines.find((turbine) => turbine.id === turbineId);
  if (!target) notFound("이 시나리오에서 발전기를 찾을 수 없습니다.");
  const nextTurbines = detail.turbines.map((turbine) => turbine.id === turbineId
    ? { ...turbine, xM: update.xM ?? turbine.xM, yM: update.yM ?? turbine.yM }
    : turbine
  );
  const layoutIssues = validateLayout(nextTurbines);
  const errors = layoutIssues.filter((issue) => issue.severity === "error");
  if (errors.length > 0) conflict(errors[0]!.message);
  await db.update(scenarioTurbines).set({
    xM: update.xM ?? target.xM,
    yM: update.yM ?? target.yM,
    command: update.command ?? target.command,
    updatedAt: new Date().toISOString()
  }).where(and(eq(scenarioTurbines.scenarioId, scenarioId), eq(scenarioTurbines.turbineId, turbineId))).run();
  return { scenario: await getScenario(db, scenarioId), layoutIssues };
}

export async function resetScenarioLayout(db: WindScopeDatabase, scenarioId: string) {
  const scenario = await requireScenario(db, scenarioId);
  if (scenario.role === "baseline") conflict("기준 배치는 읽기 전용입니다.");
  const baseline = await db.select().from(scenarios)
    .where(and(eq(scenarios.projectId, scenario.projectId), eq(scenarios.role, "baseline")))
    .get();
  if (!baseline) notFound("프로젝트 기준 배치를 찾을 수 없습니다.");
  const baselinePlacements = await db.select().from(scenarioTurbines).where(eq(scenarioTurbines.scenarioId, baseline.id)).all();
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.delete(scenarioTurbines).where(eq(scenarioTurbines.scenarioId, scenarioId)).run();
    if (baselinePlacements.length > 0) {
      await tx.insert(scenarioTurbines).values(baselinePlacements.map((placement) => ({
        scenarioId,
        turbineId: placement.turbineId,
        xM: placement.xM,
        yM: placement.yM,
        command: placement.command,
        updatedAt: now
      }))).run();
    }
  });
  return getScenario(db, scenarioId);
}

function toSimulationInput(scenario: Awaited<ReturnType<typeof getScenario>>): SimulationInput {
  const scenarioTurbinesInput: TurbineInput[] = scenario.turbines.map((turbine) => ({
    id: turbine.id,
    name: turbine.name,
    xM: turbine.xM,
    yM: turbine.yM,
    ratedPowerMW: turbine.ratedPowerMW,
    rotorDiameterM: turbine.rotorDiameterM,
    hubHeightM: turbine.hubHeightM,
    cutInMps: turbine.cutInMps,
    ratedWindMps: turbine.ratedWindMps,
    cutOutMps: turbine.cutOutMps,
    thrustCoefficient: turbine.thrustCoefficient,
    wakeExpansion: turbine.wakeExpansion,
    command: turbine.command,
    powerCurve: turbine.powerCurve
  }));
  return {
    windSpeedMps: scenario.windSpeedMps,
    windDirectionDeg: scenario.windDirectionDeg,
    airDensityKgM3: scenario.airDensityKgM3,
    turbines: scenarioTurbinesInput
  };
}

export async function runScenarioSimulation(db: WindScopeDatabase, scenarioId: string) {
  const scenario = await getScenario(db, scenarioId);
  const input = toSimulationInput(scenario);
  const result: SimulationResult = simulateFarm(input);
  const stableInput = { ...input, turbines: [...input.turbines].sort((first, second) => first.id.localeCompare(second.id)) };
  const inputJson = JSON.stringify(stableInput);
  const inputHash = createHash("sha256").update(inputJson).digest("hex");
  const runId = randomUUID();
  const calculatedAt = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.insert(simulationRuns).values({
      id: runId,
      scenarioId,
      modelVersion: result.modelVersion,
      inputHash,
      inputJson,
      totalPowerMW: result.totalPowerMW,
      noWakePowerMW: result.noWakePowerMW,
      wakeLossMW: result.wakeLossMW,
      wakeLossPercent: result.wakeLossPercent,
      calculatedAt
    }).run();
    if (result.turbines.length > 0) {
      await tx.insert(turbineSimulationResults).values(result.turbines.map((turbineResult) => ({
        simulationRunId: runId,
        turbineId: turbineResult.turbineId,
        effectiveWindMps: turbineResult.effectiveWindMps,
        wakeDeficitMps: turbineResult.wakeDeficitMps,
        powerMW: turbineResult.powerMW,
        noWakePowerMW: turbineResult.noWakePowerMW,
        status: turbineResult.status,
        upstreamTurbineIdsJson: JSON.stringify(turbineResult.upstreamTurbineIds)
      }))).run();
    }
  });
  return { ...result, runId, inputHash, calculatedAt };
}

export async function getLatestSimulation(db: WindScopeDatabase, scenarioId: string) {
  await requireScenario(db, scenarioId);
  const run = await db.select().from(simulationRuns)
    .where(eq(simulationRuns.scenarioId, scenarioId))
    .orderBy(desc(simulationRuns.calculatedAt))
    .limit(1)
    .get();
  if (!run) return null;
  const results = await db.select().from(turbineSimulationResults)
    .where(eq(turbineSimulationResults.simulationRunId, run.id))
    .all();
  return {
    ...run,
    turbines: results.map((result) => ({
      ...result,
      upstreamTurbineIds: JSON.parse(result.upstreamTurbineIdsJson) as string[]
    }))
  };
}

export async function compareScenarioToBaseline(db: WindScopeDatabase, scenarioId: string, baselineScenarioId: string) {
  const scenario = await requireScenario(db, scenarioId);
  const baseline = await requireScenario(db, baselineScenarioId);
  if (baseline.role !== "baseline") conflict("비교 대상은 기준 시나리오여야 합니다.");
  if (baseline.projectId !== scenario.projectId) conflict("다른 프로젝트의 시나리오는 비교할 수 없습니다.");
  const [baselineRun, experimentRun] = await Promise.all([
    getLatestSimulation(db, baselineScenarioId),
    getLatestSimulation(db, scenarioId)
  ]);
  const [baselineResult, experimentResult] = await Promise.all([
    baselineRun ?? runScenarioSimulation(db, baselineScenarioId),
    experimentRun ?? runScenarioSimulation(db, scenarioId)
  ]);
  const deltaPowerMW = experimentResult.totalPowerMW - baselineResult.totalPowerMW;
  return {
    baseline: { scenarioId: baseline.id, name: baseline.name, totalPowerMW: baselineResult.totalPowerMW, wakeLossMW: baselineResult.wakeLossMW, wakeLossPercent: baselineResult.wakeLossPercent },
    experiment: { scenarioId: scenario.id, name: scenario.name, totalPowerMW: experimentResult.totalPowerMW, wakeLossMW: experimentResult.wakeLossMW, wakeLossPercent: experimentResult.wakeLossPercent },
    deltaPowerMW,
    deltaPowerPercent: baselineResult.totalPowerMW > 0 ? (deltaPowerMW / baselineResult.totalPowerMW) * 100 : null,
    comparisonDefinition: "현재 실험 총 출력 - 기준 시나리오 총 출력. 후류 손실률은 각 시나리오의 무후류 예상 출력을 분모로 계산합니다."
  };
}

