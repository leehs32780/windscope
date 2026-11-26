import { eq } from "drizzle-orm";
import type { WindScopeDatabase } from "./client";
import { projects, scenarios, scenarioTurbines, turbines } from "./schema";
import type { PowerCurvePoint } from "../../shared/domain";

const DEMO_PROJECT_ID = "north-sea-demo";
const BASELINE_ID = "north-sea-baseline";
const EXPERIMENT_ID = "north-sea-experiment";

const demoPowerCurve: PowerCurvePoint[] = [
  { windSpeedMps: 3, powerMW: 0 },
  { windSpeedMps: 5, powerMW: 0.35 },
  { windSpeedMps: 8, powerMW: 2.4 },
  { windSpeedMps: 10, powerMW: 5.2 },
  { windSpeedMps: 12, powerMW: 8 }
];

async function seedDemoFarmRows(db: WindScopeDatabase): Promise<void> {
  await db.insert(projects).values({
    id: DEMO_PROJECT_ID,
    name: "North Sea Demo · 샘플 단지",
    description: "실제 발전단지 측정값이 아닌 교육·설계 검토용 가상 배치입니다."
  }).onConflictDoNothing().run();

  const columns = [-700, 0, 700];
  const rows = [1_200, 400, -400, -1_200];
  const sampleTurbines = rows.flatMap((yM, rowIndex) => columns.map((xM, columnIndex) => {
    const order = rowIndex * columns.length + columnIndex;
    const id = `north-sea-turbine-${String(order + 1).padStart(2, "0")}`;
    return {
      id,
      projectId: DEMO_PROJECT_ID,
      name: `터빈 ${String(order + 1).padStart(2, "02")}`,
      ratedPowerMW: 8,
      rotorDiameterM: 160,
      hubHeightM: 105,
      cutInMps: 3,
      ratedWindMps: 12,
      cutOutMps: 25,
      thrustCoefficient: 0.8,
      wakeExpansion: 0.05,
      powerCurveJson: JSON.stringify(demoPowerCurve),
      displayOrder: order,
      xM: xM + ((rowIndex + columnIndex) % 2 === 0 ? 0 : 55),
      yM
    };
  }));

  for (const turbine of sampleTurbines) {
    const { xM: _xM, yM: _yM, ...storedTurbine } = turbine;
    await db.insert(turbines).values(storedTurbine).onConflictDoNothing().run();
  }

  await db.insert(scenarios).values([
    { id: BASELINE_ID, projectId: DEMO_PROJECT_ID, name: "기준 배치", role: "baseline", windSpeedMps: 9.5, windDirectionDeg: 0, airDensityKgM3: 1.225 },
    { id: EXPERIMENT_ID, projectId: DEMO_PROJECT_ID, name: "실험 시나리오", role: "experiment", windSpeedMps: 9.5, windDirectionDeg: 0, airDensityKgM3: 1.225 }
  ]).onConflictDoNothing().run();

  const baseline = await db.select({ id: scenarios.id }).from(scenarios).where(eq(scenarios.id, BASELINE_ID)).get();
  const experiment = await db.select({ id: scenarios.id }).from(scenarios).where(eq(scenarios.id, EXPERIMENT_ID)).get();
  if (!baseline || !experiment) throw new Error("샘플 기준/실험 시나리오를 준비하지 못했습니다.");

  for (const turbine of sampleTurbines) {
    const placement = { scenarioId: BASELINE_ID, turbineId: turbine.id, xM: turbine.xM, yM: turbine.yM, command: "operational" as const };
    await db.insert(scenarioTurbines).values(placement).onConflictDoNothing().run();
    await db.insert(scenarioTurbines).values({ ...placement, scenarioId: EXPERIMENT_ID }).onConflictDoNothing().run();
  }
}

export async function seedDemoFarm(db: WindScopeDatabase): Promise<void> {
  // The adapter holds the shared connection for this entire transaction. All
  // bootstrap statements succeed together; existing rows are never overwritten.
  await db.transaction(async () => seedDemoFarmRows(db));
}

