import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { PowerCurvePoint, SimulationInput, SimulationResult, TurbineInput } from "../shared/domain";
import { validateLayout } from "../shared/domain";
import { powerCurvePointSchema, turbineInputSchema } from "../shared/validation";
import { SIMULATION_MODEL_VERSION, simulateFarm } from "../shared/simulation";
import type { WindScopeDatabase } from "./db/client";
import { withDatabaseAccess } from "./db/access";
import { projects, scenarios, scenarioTurbines, simulationRuns, turbineSimulationResults, turbines } from "./db/schema";
import { ApiError, conflict, notFound } from "./http-error";
import { farmRepository } from "./repositories/farm-repository";

type TurbineSpecification = Pick<TurbineInput,
  "name" | "ratedPowerMW" | "rotorDiameterM" | "hubHeightM" | "cutInMps" |
  "ratedWindMps" | "cutOutMps" | "thrustCoefficient" | "wakeExpansion" | "powerCurve"
>;
type TurbineCreateInput = TurbineSpecification & { xM: number; yM: number; displayOrder?: number };
type TurbineUpdateInput = Partial<TurbineSpecification & { displayOrder: number }>;

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

async function listProjectsImpl(db: WindScopeDatabase) {
  return farmRepository(db).listProjects();
}

async function createProjectImpl(db: WindScopeDatabase, input: { name: string; description?: string }) {
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

async function updateProjectImpl(db: WindScopeDatabase, projectId: string, input: { name?: string; description?: string | null }) {
  const repository = farmRepository(db);
  const project = await repository.findProject(projectId);
  if (!project) notFound("수정할 프로젝트를 찾을 수 없습니다.");
  const now = new Date().toISOString();
  await db.update(projects).set({
    name: input.name ?? project.name,
    description: input.description === undefined ? project.description : input.description || null,
    updatedAt: now
  }).where(eq(projects.id, projectId)).run();
  return getProject(db, projectId);
}

async function getProjectImpl(db: WindScopeDatabase, projectId: string) {
  const repository = farmRepository(db);
  const project = await repository.findProject(projectId);
  if (!project) notFound("프로젝트를 찾을 수 없습니다.");
  const [projectTurbines, projectScenarios] = await Promise.all([
    repository.listProjectTurbines(projectId),
    repository.listProjectScenarios(projectId)
  ]);
  return {
    ...project,
    turbines: projectTurbines.map((turbine) => ({ ...turbine, powerCurve: parsePowerCurve(turbine.powerCurveJson) })),
    scenarios: projectScenarios,
    baselineScenarioId: projectScenarios.find((scenario) => scenario.role === "baseline")?.id ?? null
  };
}

async function listProjectTurbinesImpl(db: WindScopeDatabase, projectId: string) {
  const repository = farmRepository(db);
  const project = await repository.findProject(projectId);
  if (!project) notFound("프로젝트를 찾을 수 없습니다.");
  const rows = await repository.listProjectTurbines(projectId);
  return rows.map((turbine) => ({ ...turbine, powerCurve: parsePowerCurve(turbine.powerCurveJson) }));
}

async function requireScenario(db: WindScopeDatabase, scenarioId: string) {
  const scenario = await farmRepository(db).findScenario(scenarioId);
  if (!scenario) notFound("시나리오를 찾을 수 없습니다.");
  return scenario;
}

async function getScenarioImpl(db: WindScopeDatabase, scenarioId: string) {
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

async function createExperimentScenarioImpl(
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

async function renameScenarioImpl(db: WindScopeDatabase, scenarioId: string, name: string) {
  const scenario = await requireScenario(db, scenarioId);
  if (scenario.role === "baseline") conflict("기준 시나리오는 이름을 바꿀 수 없습니다.");
  await db.update(scenarios).set({ name, updatedAt: new Date().toISOString() }).where(eq(scenarios.id, scenarioId)).run();
  return getScenario(db, scenarioId);
}

async function updateScenarioSettingsImpl(
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

async function updateTurbinePlacementImpl(
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
  const updatedAt = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.update(scenarioTurbines).set({
      xM: update.xM ?? target.xM,
      yM: update.yM ?? target.yM,
      command: update.command ?? target.command,
      updatedAt
    }).where(and(eq(scenarioTurbines.scenarioId, scenarioId), eq(scenarioTurbines.turbineId, turbineId))).run();
    await tx.update(scenarios).set({ updatedAt }).where(eq(scenarios.id, scenarioId)).run();
  });
  return { scenario: await getScenario(db, scenarioId), layoutIssues };
}

async function resetScenarioLayoutImpl(db: WindScopeDatabase, scenarioId: string) {
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
    await tx.update(scenarios).set({ updatedAt: now }).where(eq(scenarios.id, scenarioId)).run();
  });
  return getScenario(db, scenarioId);
}

async function deleteProjectImpl(db: WindScopeDatabase, projectId: string) {
  const repository = farmRepository(db);
  const project = await repository.findProject(projectId);
  if (!project) notFound("삭제할 프로젝트를 찾을 수 없습니다.");
  await repository.deleteProject(projectId);
  return {
    deletedId: projectId,
    deletionPolicy: "프로젝트와 연결된 터빈, 시나리오, 배치 및 저장된 시뮬레이션 결과를 함께 삭제합니다."
  };
}

async function deleteScenarioImpl(db: WindScopeDatabase, scenarioId: string) {
  const repository = farmRepository(db);
  const scenario = await repository.findScenario(scenarioId);
  if (!scenario) notFound("삭제할 시나리오를 찾을 수 없습니다.");
  if (scenario.role === "baseline") conflict("기준 시나리오는 삭제할 수 없습니다. 다른 실험을 새 기준으로 지정한 뒤에도 기준 레코드는 보존됩니다.");
  await repository.deleteScenario(scenarioId);
  await db.update(projects).set({ updatedAt: new Date().toISOString() }).where(eq(projects.id, scenario.projectId)).run();
  return {
    deletedId: scenarioId,
    project: await getProject(db, scenario.projectId),
    deletionPolicy: "실험 시나리오와 연결된 배치 및 저장된 시뮬레이션 결과를 함께 삭제합니다."
  };
}

async function createTurbineImpl(db: WindScopeDatabase, projectId: string, input: TurbineCreateInput) {
  const repository = farmRepository(db);
  const project = await repository.findProject(projectId);
  if (!project) notFound("터빈을 추가할 프로젝트를 찾을 수 없습니다.");
  const [projectTurbines, projectScenarios] = await Promise.all([
    repository.listProjectTurbines(projectId),
    repository.listProjectScenarios(projectId)
  ]);
  if (projectTurbines.length >= 100) conflict("한 프로젝트에는 최대 100대의 터빈을 추가할 수 있습니다.");
  if (projectTurbines.some((turbine) => turbine.name === input.name)) conflict("같은 프로젝트에 동일한 터빈 이름을 사용할 수 없습니다.");
  const turbineId = randomUUID();
  const validated = turbineInputSchema.parse({ ...input, id: turbineId, command: "operational" });
  for (const scenario of projectScenarios) {
    const detail = await getScenarioImpl(db, scenario.id);
    const issue = validateLayout([...detail.turbines, validated]).find((item) => item.severity === "error");
    if (issue) conflict(`${scenario.name}: ${issue.message}`);
  }
  const now = new Date().toISOString();
  const displayOrder = input.displayOrder ?? (projectTurbines.reduce((maximum, turbine) => Math.max(maximum, turbine.displayOrder), -1) + 1);
  await db.transaction(async (tx) => {
    await tx.insert(turbines).values({
      id: turbineId,
      projectId,
      name: validated.name,
      ratedPowerMW: validated.ratedPowerMW,
      rotorDiameterM: validated.rotorDiameterM,
      hubHeightM: validated.hubHeightM,
      cutInMps: validated.cutInMps,
      ratedWindMps: validated.ratedWindMps,
      cutOutMps: validated.cutOutMps,
      thrustCoefficient: validated.thrustCoefficient,
      wakeExpansion: validated.wakeExpansion,
      powerCurveJson: JSON.stringify(validated.powerCurve),
      displayOrder,
      createdAt: now,
      updatedAt: now
    }).run();
    if (projectScenarios.length) {
      await tx.insert(scenarioTurbines).values(projectScenarios.map((scenario) => ({
        scenarioId: scenario.id,
        turbineId,
        xM: validated.xM,
        yM: validated.yM,
        command: "operational" as const,
        updatedAt: now
      }))).run();
    }
    await tx.update(scenarios).set({ updatedAt: now }).where(eq(scenarios.projectId, projectId)).run();
    await tx.update(projects).set({ updatedAt: now }).where(eq(projects.id, projectId)).run();
  });
  const nextProject = await getProject(db, projectId);
  return { turbine: nextProject.turbines.find((turbine) => turbine.id === turbineId)!, project: nextProject };
}

async function updateTurbineImpl(db: WindScopeDatabase, projectId: string, turbineId: string, update: TurbineUpdateInput) {
  const repository = farmRepository(db);
  const [project, current] = await Promise.all([
    repository.findProject(projectId),
    repository.findProjectTurbine(projectId, turbineId)
  ]);
  if (!project) notFound("프로젝트를 찾을 수 없습니다.");
  if (!current) notFound("수정할 터빈을 찾을 수 없습니다.");
  if (update.name && update.name !== current.name) {
    const all = await repository.listProjectTurbines(projectId);
    if (all.some((turbine) => turbine.id !== turbineId && turbine.name === update.name)) conflict("같은 프로젝트에 동일한 터빈 이름을 사용할 수 없습니다.");
  }
  const merged = turbineInputSchema.parse({
    id: current.id,
    name: update.name ?? current.name,
    xM: 0,
    yM: 0,
    command: "operational",
    ratedPowerMW: update.ratedPowerMW ?? current.ratedPowerMW,
    rotorDiameterM: update.rotorDiameterM ?? current.rotorDiameterM,
    hubHeightM: update.hubHeightM ?? current.hubHeightM,
    cutInMps: update.cutInMps ?? current.cutInMps,
    ratedWindMps: update.ratedWindMps ?? current.ratedWindMps,
    cutOutMps: update.cutOutMps ?? current.cutOutMps,
    thrustCoefficient: update.thrustCoefficient ?? current.thrustCoefficient,
    wakeExpansion: update.wakeExpansion ?? current.wakeExpansion,
    powerCurve: update.powerCurve ?? parsePowerCurve(current.powerCurveJson)
  });
  const projectScenarios = await repository.listProjectScenarios(projectId);
  for (const projectScenario of projectScenarios) {
    const detail = await getScenarioImpl(db, projectScenario.id);
    const nextTurbines = detail.turbines.map((turbine) => turbine.id === turbineId
      ? { ...turbine, ...merged, xM: turbine.xM, yM: turbine.yM, command: turbine.command }
      : turbine);
    const issue = validateLayout(nextTurbines).find((item) => item.severity === "error");
    if (issue) conflict(`${projectScenario.name}: ${issue.message}`);
  }
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.update(turbines).set({
      name: merged.name,
      ratedPowerMW: merged.ratedPowerMW,
      rotorDiameterM: merged.rotorDiameterM,
      hubHeightM: merged.hubHeightM,
      cutInMps: merged.cutInMps,
      ratedWindMps: merged.ratedWindMps,
      cutOutMps: merged.cutOutMps,
      thrustCoefficient: merged.thrustCoefficient,
      wakeExpansion: merged.wakeExpansion,
      powerCurveJson: JSON.stringify(merged.powerCurve),
      displayOrder: update.displayOrder ?? current.displayOrder,
      updatedAt: now
    }).where(and(eq(turbines.projectId, projectId), eq(turbines.id, turbineId))).run();
    await tx.update(scenarios).set({ updatedAt: now }).where(eq(scenarios.projectId, projectId)).run();
    await tx.update(projects).set({ updatedAt: now }).where(eq(projects.id, projectId)).run();
  });
  const nextProject = await getProject(db, projectId);
  return { turbine: nextProject.turbines.find((turbine) => turbine.id === turbineId)!, project: nextProject };
}

async function deleteTurbineImpl(db: WindScopeDatabase, projectId: string, turbineId: string) {
  const repository = farmRepository(db);
  const [project, turbine] = await Promise.all([
    repository.findProject(projectId),
    repository.findProjectTurbine(projectId, turbineId)
  ]);
  if (!project) notFound("프로젝트를 찾을 수 없습니다.");
  if (!turbine) notFound("삭제할 터빈을 찾을 수 없습니다.");
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.delete(turbines).where(and(eq(turbines.projectId, projectId), eq(turbines.id, turbineId))).run();
    await tx.update(scenarios).set({ updatedAt: now }).where(eq(scenarios.projectId, projectId)).run();
    await tx.update(projects).set({ updatedAt: now }).where(eq(projects.id, projectId)).run();
  });
  return {
    deletedId: turbineId,
    project: await getProject(db, projectId),
    deletionPolicy: "모든 시나리오의 해당 터빈 배치와 터빈별 저장 결과를 함께 삭제합니다. 기존 Run은 입력 해시가 달라져 재계산됩니다."
  };
}

async function promoteScenarioToBaselineImpl(db: WindScopeDatabase, scenarioId: string) {
  const repository = farmRepository(db);
  const experiment = await repository.findScenario(scenarioId);
  if (!experiment) notFound("새 기준으로 지정할 시나리오를 찾을 수 없습니다.");
  if (experiment.role !== "experiment") conflict("실험 시나리오만 새 기준으로 지정할 수 있습니다.");
  const baseline = await repository.findBaseline(experiment.projectId);
  if (!baseline) notFound("현재 기준 시나리오를 찾을 수 없습니다.");
  const [baselinePlacements, experimentPlacements] = await Promise.all([
    repository.listScenarioPlacements(baseline.id),
    repository.listScenarioPlacements(experiment.id)
  ]);
  const archivedScenarioId = randomUUID();
  const now = new Date().toISOString();
  const archiveName = `이전 기준 · ${now.slice(0, 16).replace("T", " ")}`;
  await db.transaction(async (tx) => {
    await tx.insert(scenarios).values({
      id: archivedScenarioId,
      projectId: baseline.projectId,
      name: archiveName,
      role: "experiment",
      windSpeedMps: baseline.windSpeedMps,
      windDirectionDeg: baseline.windDirectionDeg,
      airDensityKgM3: baseline.airDensityKgM3,
      createdAt: now,
      updatedAt: now
    }).run();
    if (baselinePlacements.length) {
      await tx.insert(scenarioTurbines).values(baselinePlacements.map((placement) => ({
        ...placement,
        scenarioId: archivedScenarioId,
        updatedAt: now
      }))).run();
    }
    await tx.delete(scenarioTurbines).where(eq(scenarioTurbines.scenarioId, baseline.id)).run();
    if (experimentPlacements.length) {
      await tx.insert(scenarioTurbines).values(experimentPlacements.map((placement) => ({
        ...placement,
        scenarioId: baseline.id,
        updatedAt: now
      }))).run();
    }
    await tx.update(scenarios).set({
      windSpeedMps: experiment.windSpeedMps,
      windDirectionDeg: experiment.windDirectionDeg,
      airDensityKgM3: experiment.airDensityKgM3,
      updatedAt: now
    }).where(eq(scenarios.id, baseline.id)).run();
    await tx.update(projects).set({ updatedAt: now }).where(eq(projects.id, experiment.projectId)).run();
  });
  return {
    baselineScenarioId: baseline.id,
    experimentScenarioId: experiment.id,
    archivedScenarioId,
    baseline: await getScenario(db, baseline.id),
    experiment: await getScenario(db, experiment.id),
    archive: await getScenario(db, archivedScenarioId),
    project: await getProject(db, experiment.projectId)
  };
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

function snapshotInput(input: SimulationInput) {
  const stableInput = { ...input, turbines: [...input.turbines].sort((first, second) => first.id.localeCompare(second.id)) };
  const inputJson = JSON.stringify(stableInput);
  return { inputJson, inputHash: createHash("sha256").update(inputJson).digest("hex") };
}

async function runScenarioSimulationImpl(db: WindScopeDatabase, scenarioId: string) {
  const scenario = await getScenario(db, scenarioId);
  const input = toSimulationInput(scenario);
  const result: SimulationResult = simulateFarm(input);
  const { inputJson, inputHash } = snapshotInput(input);
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

async function getLatestSimulationImpl(db: WindScopeDatabase, scenarioId: string) {
  const scenario = await getScenario(db, scenarioId);
  const run = await db.select().from(simulationRuns)
    .where(eq(simulationRuns.scenarioId, scenarioId))
    .orderBy(desc(simulationRuns.calculatedAt), desc(sql`rowid`))
    .limit(1)
    .get();
  if (!run) return null;
  const results = await db.select().from(turbineSimulationResults)
    .where(eq(turbineSimulationResults.simulationRunId, run.id))
    .all();
  const currentInputHash = snapshotInput(toSimulationInput(scenario)).inputHash;
  return {
    ...run,
    runId: run.id,
    currentInputHash,
    isStale: run.inputHash !== currentInputHash || run.modelVersion !== SIMULATION_MODEL_VERSION,
    turbines: results.map((result) => ({
      ...result,
      upstreamTurbineIds: JSON.parse(result.upstreamTurbineIdsJson) as string[]
    }))
  };
}

async function compareScenarioToBaselineImpl(db: WindScopeDatabase, scenarioId: string, baselineScenarioId: string, mode: "layout" | "scenario" = "scenario") {
  const scenario = await getScenario(db, scenarioId);
  const baseline = await getScenario(db, baselineScenarioId);
  if (baseline.role !== "baseline") conflict("비교 대상은 기준 시나리오여야 합니다.");
  if (baseline.projectId !== scenario.projectId) conflict("다른 프로젝트의 시나리오는 비교할 수 없습니다.");
  const [baselineRun, experimentRun] = await Promise.all([
    getLatestSimulation(db, baselineScenarioId),
    getLatestSimulation(db, scenarioId)
  ]);
  const experimentResult = experimentRun && !experimentRun.isStale ? experimentRun : await runScenarioSimulation(db, scenarioId);
  const conditions = (value: typeof scenario) => ({ windSpeedMps: value.windSpeedMps, windDirectionDeg: value.windDirectionDeg, airDensityKgM3: value.airDensityKgM3 });
  const experimentConditions = conditions(scenario);
  const baselineConditions = mode === "layout" ? experimentConditions : conditions(baseline);
  const commands = new Map(scenario.turbines.map((turbine) => [turbine.id, turbine.command]));
  // Layout comparison is transient: use identical weather/commands while keeping
  // baseline coordinates and preserving the immutable baseline in the database.
  const baselineResult = mode === "layout"
    ? simulateFarm({ ...toSimulationInput(baseline), ...experimentConditions, turbines: toSimulationInput(baseline).turbines.map((turbine) => ({ ...turbine, command: commands.get(turbine.id) ?? turbine.command })) })
    : baselineRun && !baselineRun.isStale ? baselineRun : await runScenarioSimulation(db, baselineScenarioId);
  const deltaPowerMW = experimentResult.totalPowerMW - baselineResult.totalPowerMW;
  return {
    mode,
    conditionsDiffer: JSON.stringify(baselineConditions) !== JSON.stringify(experimentConditions),
    baseline: { scenarioId: baseline.id, name: baseline.name, conditions: baselineConditions, totalPowerMW: baselineResult.totalPowerMW, wakeLossMW: baselineResult.wakeLossMW, wakeLossPercent: baselineResult.wakeLossPercent },
    experiment: { scenarioId: scenario.id, name: scenario.name, conditions: experimentConditions, totalPowerMW: experimentResult.totalPowerMW, wakeLossMW: experimentResult.wakeLossMW, wakeLossPercent: experimentResult.wakeLossPercent },
    turbineDeltas: scenario.turbines.map((turbine) => {
      const baselinePowerMW = baselineResult.turbines.find((item) => item.turbineId === turbine.id)?.powerMW ?? 0;
      const experimentPowerMW = experimentResult.turbines.find((item) => item.turbineId === turbine.id)?.powerMW ?? 0;
      return { turbineId: turbine.id, name: turbine.name, baselinePowerMW, experimentPowerMW, deltaPowerMW: experimentPowerMW - baselinePowerMW };
    }),
    deltaPowerMW,
    deltaPowerPercent: baselineResult.totalPowerMW > 0 ? (deltaPowerMW / baselineResult.totalPowerMW) * 100 : null,
    comparisonDefinition: `${mode === "layout" ? "동일한 풍황·운전 명령에서 현재 배치 출력 - 기준 배치 출력." : "각 시나리오에 저장된 전체 조건에서 현재 출력 - 기준 출력."} 후류 손실률은 각각의 무후류 예상 출력을 분모로 계산합니다.`
  };
}

// A service operation may read, validate, and then write multiple rows. Keep
// that whole sequence together, including comparisons and their recalculation.
function serialize<Args extends unknown[], Result>(operation: (db: WindScopeDatabase, ...args: Args) => Promise<Result>) {
  return (db: WindScopeDatabase, ...args: Args): Promise<Result> => withDatabaseAccess(db, () => operation(db, ...args));
}

export const listProjects = serialize(listProjectsImpl);
export const createProject = serialize(createProjectImpl);
export const updateProject = serialize(updateProjectImpl);
export const deleteProject = serialize(deleteProjectImpl);
export const getProject = serialize(getProjectImpl);
export const listProjectTurbines = serialize(listProjectTurbinesImpl);
export const createTurbine = serialize(createTurbineImpl);
export const updateTurbine = serialize(updateTurbineImpl);
export const deleteTurbine = serialize(deleteTurbineImpl);
export const getScenario = serialize(getScenarioImpl);
export const createExperimentScenario = serialize(createExperimentScenarioImpl);
export const deleteScenario = serialize(deleteScenarioImpl);
export const promoteScenarioToBaseline = serialize(promoteScenarioToBaselineImpl);
export const renameScenario = serialize(renameScenarioImpl);
export const updateScenarioSettings = serialize(updateScenarioSettingsImpl);
export const updateTurbinePlacement = serialize(updateTurbinePlacementImpl);
export const resetScenarioLayout = serialize(resetScenarioLayoutImpl);
export const runScenarioSimulation = serialize(runScenarioSimulationImpl);
export const getLatestSimulation = serialize(getLatestSimulationImpl);
export const compareScenarioToBaseline = serialize(compareScenarioToBaselineImpl);

