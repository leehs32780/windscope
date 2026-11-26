import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./app";
import { applyMigrations, createDatabase } from "./db/client";
import { seedDemoFarm } from "./db/seed";
import type { WindScopeDatabase } from "./db/client";
import type { DatabaseSync } from "node:sqlite";

describe("WindScope API", () => {
  let db: WindScopeDatabase;
  let client: DatabaseSync;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    const connection = createDatabase(":memory:");
    client = connection.client;
    db = connection.db;
    applyMigrations(client);
    await seedDemoFarm(db);
    app = createApp(db);
  });

  afterEach(() => client.close());

  it("reports the API/database and returns the seeded project with scenarios", async () => {
    const health = await request(app).get("/api/health").expect(200);
    expect(health.body.data).toMatchObject({ ok: true, service: "windscope-api", database: "ok" });

    const response = await request(app).get("/api/projects/north-sea-demo").expect(200);
    expect(response.body.data.turbines).toHaveLength(12);
    expect(response.body.data.scenarios.map((scenario: { role: string }) => scenario.role)).toEqual(["baseline", "experiment"]);
  });

  it("validates scenario inputs and protects the read-only baseline", async () => {
    await request(app)
      .patch("/api/scenarios/north-sea-experiment/settings")
      .send({ windSpeedMps: 36 })
      .expect(400);
    await request(app)
      .patch("/api/scenarios/north-sea-baseline/settings")
      .send({ windSpeedMps: 10 })
      .expect(409);
    await request(app)
      .put("/api/scenarios/north-sea-baseline/turbines/north-sea-turbine-01")
      .send({ command: "manual_stop" })
      .expect(409);
  });

  it("saves a simulation run, returns the latest result, and compares it with baseline", async () => {
    const simulated = await request(app).post("/api/scenarios/north-sea-experiment/simulate").send({}).expect(200);
    expect(simulated.body.data.totalPowerMW).toBeGreaterThan(0);
    expect(simulated.body.data.wakeLossPercent).not.toBeNull();
    expect(simulated.body.data.modelVersion).toBe("jensen-circle-overlap-rss-v1");

    const latest = await request(app).get("/api/scenarios/north-sea-experiment/results/latest").expect(200);
    expect(latest.body.data.id).toBe(simulated.body.data.runId);
    expect(latest.body.data.turbines).toHaveLength(12);

    const comparison = await request(app)
      .get("/api/scenarios/north-sea-experiment/compare")
      .query({ against: "north-sea-baseline" })
      .expect(200);
    expect(comparison.body.data.baseline.scenarioId).toBe("north-sea-baseline");
    expect(typeof comparison.body.data.deltaPowerMW).toBe("number");
    expect(comparison.body.data.comparisonDefinition).toContain("현재 실험 총 출력");
  });

  it("duplicates settings and layout without changing the baseline or source experiment", async () => {
    const duplicated = await request(app)
      .post("/api/scenarios/north-sea-experiment/duplicate")
      .send({ name: "정지 실험" })
      .expect(201);
    const duplicateId = duplicated.body.data.id as string;
    const oldX = duplicated.body.data.turbines[0].xM as number;

    const changed = await request(app)
      .put(`/api/scenarios/${duplicateId}/turbines/north-sea-turbine-01`)
      .send({ xM: oldX + 100 })
      .expect(200);
    expect(changed.body.data.scenario.turbines[0].xM).toBe(oldX + 100);

    const source = await request(app).get("/api/scenarios/north-sea-experiment").expect(200);
    const baseline = await request(app).get("/api/scenarios/north-sea-baseline").expect(200);
    expect(source.body.data.turbines[0].xM).toBe(oldX);
    expect(baseline.body.data.turbines[0].xM).toBe(oldX);
  });

  it("blocks overlapping moves and restores an experiment from its baseline", async () => {
    await request(app)
      .put("/api/scenarios/north-sea-experiment/turbines/north-sea-turbine-02")
      .send({ xM: -700, yM: 1_200 })
      .expect(409);

    await request(app)
      .put("/api/scenarios/north-sea-experiment/turbines/north-sea-turbine-01")
      .send({ xM: -500, yM: 900 })
      .expect(200);
    const restored = await request(app).post("/api/scenarios/north-sea-experiment/reset-layout").send({}).expect(200);
    const baseline = await request(app).get("/api/scenarios/north-sea-baseline").expect(200);
    expect(restored.body.data.turbines[0].xM).toBe(baseline.body.data.turbines[0].xM);
    expect(restored.body.data.turbines[0].yM).toBe(baseline.body.data.turbines[0].yM);
  });

  it("creates projects with separate read-only baseline and editable experiment scenarios", async () => {
    const response = await request(app).post("/api/projects").send({ name: "새 단지", description: "직접 만든 프로젝트" }).expect(201);
    expect(response.body.data.scenarios).toHaveLength(2);
    expect(response.body.data.baselineScenarioId).toBeTruthy();
    expect(response.body.data.turbines).toHaveLength(0);
  });
});

