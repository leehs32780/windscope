import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./app";
import { applyMigrations, createDatabase } from "./db/client";
import { seedDemoFarm } from "./db/seed";
import type { WindScopeDatabase } from "./db/client";
import type { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SIMULATION_MODEL_VERSION } from "../shared/simulation";

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

  it("isolates layout effects under identical weather and commands without mutating the baseline", async () => {
    await request(app).patch("/api/scenarios/north-sea-experiment/settings").send({ windSpeedMps: 13, windDirectionDeg: 90 }).expect(200);
    await request(app).put("/api/scenarios/north-sea-experiment/turbines/north-sea-turbine-01").send({ command: "manual_stop" }).expect(200);
    const layout = (await request(app).get("/api/scenarios/north-sea-experiment/compare?against=north-sea-baseline&mode=layout").expect(200)).body.data;
    expect(layout.mode).toBe("layout");
    expect(layout.conditionsDiffer).toBe(false);
    expect(layout.deltaPowerMW).toBeCloseTo(0, 10);
    expect(layout.turbineDeltas).toHaveLength(12);
    expect(layout.turbineDeltas[0]).toMatchObject({ baselinePowerMW: 0, experimentPowerMW: 0 });
    const whole = (await request(app).get("/api/scenarios/north-sea-experiment/compare?against=north-sea-baseline&mode=scenario").expect(200)).body.data;
    expect(whole.conditionsDiffer).toBe(true);
    expect(whole.deltaPowerMW).not.toBe(0);
    const baseline = (await request(app).get("/api/scenarios/north-sea-baseline").expect(200)).body.data;
    expect(baseline.windSpeedMps).toBe(9.5);
    expect(baseline.turbines[0].command).toBe("operational");
    await request(app).get("/api/scenarios/north-sea-experiment/compare?against=north-sea-baseline&mode=invalid").expect(400);
  });

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
    expect(simulated.body.data.modelVersion).toBe(SIMULATION_MODEL_VERSION);

    const latest = await request(app).get("/api/scenarios/north-sea-experiment/results/latest").expect(200);
    expect(latest.body.data.id).toBe(simulated.body.data.runId);
    expect(latest.body.data.turbines).toHaveLength(12);

    const comparison = await request(app)
      .get("/api/scenarios/north-sea-experiment/compare")
      .query({ against: "north-sea-baseline" })
      .expect(200);
    expect(comparison.body.data.baseline.scenarioId).toBe("north-sea-baseline");
    expect(typeof comparison.body.data.deltaPowerMW).toBe("number");
    expect(comparison.body.data.mode).toBe("scenario");
    expect(comparison.body.data.deltaPowerMW).toBeCloseTo(comparison.body.data.experiment.totalPowerMW - comparison.body.data.baseline.totalPowerMW, 10);
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
    const updated = await request(app).patch(`/api/projects/${response.body.data.id}`)
      .send({ name: "이름을 바꾼 단지", description: null }).expect(200);
    expect(updated.body.data).toMatchObject({ name: "이름을 바꾼 단지", description: null });
    await request(app).patch(`/api/projects/${response.body.data.id}`).send({}).expect(400);
  });

  it("creates, validates, updates and deletes turbine definitions across every scenario", async () => {
    const project = (await request(app).post("/api/projects").send({ name: "CRUD 단지" }).expect(201)).body.data;
    const payload = {
      name: "터빈 A",
      xM: 0,
      yM: 0,
      ratedPowerMW: 6,
      rotorDiameterM: 150,
      hubHeightM: 100,
      cutInMps: 3,
      ratedWindMps: 11,
      cutOutMps: 25,
      thrustCoefficient: 0.78,
      wakeExpansion: 0.05,
      powerCurve: [
        { windSpeedMps: 0, powerMW: 0 },
        { windSpeedMps: 3, powerMW: 0 },
        { windSpeedMps: 6, powerMW: 1.2 },
        { windSpeedMps: 9, powerMW: 4.2 },
        { windSpeedMps: 11, powerMW: 6 },
        { windSpeedMps: 24, powerMW: 6 },
        { windSpeedMps: 25, powerMW: 0 }
      ]
    };
    const created = (await request(app).post(`/api/projects/${project.id}/turbines`).send(payload).expect(201)).body.data;
    const turbineId = created.turbine.id as string;
    expect(created.project.turbines).toHaveLength(1);
    for (const scenario of project.scenarios) {
      const detail = (await request(app).get(`/api/scenarios/${scenario.id}`).expect(200)).body.data;
      expect(detail.turbines[0]).toMatchObject({ id: turbineId, xM: 0, yM: 0, command: "operational" });
    }
    await request(app).post(`/api/projects/${project.id}/turbines`).send({ ...payload, name: "잘못된 곡선", ratedWindMps: 2 }).expect(400);
    await request(app).post(`/api/projects/${project.id}/turbines`).send({ ...payload, name: "터빈 A", xM: 500 }).expect(409);
    const neighbor = (await request(app).post(`/api/projects/${project.id}/turbines`)
      .send({ ...payload, name: "터빈 B", xM: 200 }).expect(201)).body.data.turbine;
    await request(app).patch(`/api/projects/${project.id}/turbines/${turbineId}`)
      .send({ rotorDiameterM: 300, hubHeightM: 200 }).expect(409);
    await request(app).delete(`/api/projects/${project.id}/turbines/${neighbor.id}`).expect(200);
    const curve7 = payload.powerCurve.map((point) => ({ ...point, powerMW: point.powerMW === 6 ? 7 : point.powerMW }));
    const updated = (await request(app).patch(`/api/projects/${project.id}/turbines/${turbineId}`)
      .send({ name: "터빈 A-개정", ratedPowerMW: 7, powerCurve: curve7 }).expect(200)).body.data;
    expect(updated.turbine).toMatchObject({ name: "터빈 A-개정", ratedPowerMW: 7 });
    const experimentId = project.scenarios.find((scenario: { role: string }) => scenario.role === "experiment").id;
    const simulated = (await request(app).post(`/api/scenarios/${experimentId}/simulate`).send({}).expect(200)).body.data;
    expect(simulated.turbines).toHaveLength(1);
    const deleted = (await request(app).delete(`/api/projects/${project.id}/turbines/${turbineId}`).expect(200)).body.data;
    expect(deleted.project.turbines).toHaveLength(0);
    expect(deleted.deletionPolicy).toContain("재계산");
    expect((await request(app).get(`/api/scenarios/${experimentId}`).expect(200)).body.data.turbines).toHaveLength(0);
    expect((await request(app).get(`/api/scenarios/${experimentId}/results/latest`).expect(200)).body.data.isStale).toBe(true);
  });

  it("archives the old baseline and promotes an experiment without locking the experiment", async () => {
    await request(app).patch("/api/scenarios/north-sea-experiment/settings").send({ windSpeedMps: 12.4, windDirectionDeg: 90 }).expect(200);
    await request(app).put("/api/scenarios/north-sea-experiment/turbines/north-sea-turbine-01")
      .send({ xM: -900, command: "maintenance_stop" }).expect(200);
    const promoted = (await request(app).post("/api/scenarios/north-sea-experiment/promote-baseline").send({}).expect(200)).body.data;
    expect(promoted.baselineScenarioId).toBe("north-sea-baseline");
    expect(promoted.experimentScenarioId).toBe("north-sea-experiment");
    expect(promoted.baseline).toMatchObject({ role: "baseline", windSpeedMps: 12.4, windDirectionDeg: 90 });
    expect(promoted.baseline.turbines[0]).toMatchObject({ xM: -900, command: "maintenance_stop" });
    expect(promoted.archive).toMatchObject({ role: "experiment", windSpeedMps: 9.5, windDirectionDeg: 0 });
    expect(promoted.archive.turbines[0]).toMatchObject({ xM: -700, command: "operational" });
    expect(promoted.experiment).toMatchObject({ role: "experiment", windSpeedMps: 12.4 });
    await request(app).patch("/api/scenarios/north-sea-experiment/settings").send({ windSpeedMps: 13 }).expect(200);
    expect(client.prepare("SELECT COUNT(*) AS count FROM scenarios WHERE project_id = ? AND role = 'baseline'").get("north-sea-demo")?.count).toBe(1);
    await request(app).post("/api/scenarios/north-sea-baseline/promote-baseline").send({}).expect(409);
  });

  it("deletes experiments and projects according to documented cascade policy", async () => {
    await request(app).delete("/api/scenarios/north-sea-baseline").expect(409);
    const duplicate = (await request(app).post("/api/scenarios/north-sea-experiment/duplicate").send({ name: "삭제 대상" }).expect(201)).body.data;
    const deletedScenario = (await request(app).delete(`/api/scenarios/${duplicate.id}`).expect(200)).body.data;
    expect(deletedScenario.deletionPolicy).toContain("시뮬레이션 결과");
    await request(app).get(`/api/scenarios/${duplicate.id}`).expect(404);
    const project = (await request(app).post("/api/projects").send({ name: "삭제할 단지" }).expect(201)).body.data;
    const deletedProject = (await request(app).delete(`/api/projects/${project.id}`).expect(200)).body.data;
    expect(deletedProject.deletionPolicy).toContain("함께 삭제");
    await request(app).get(`/api/projects/${project.id}`).expect(404);
    expect(client.prepare("SELECT COUNT(*) AS count FROM scenarios WHERE project_id = ?").get(project.id)?.count).toBe(0);
  });

  it("compares fresh scenarios before any saved run without overlapping SQLite transactions", async () => {
    const comparison = await request(app).get("/api/scenarios/north-sea-experiment/compare")
      .query({ against: "north-sea-baseline" }).expect(200);
    expect(comparison.body.data.deltaPowerMW).toBe(0);
    expect(client.prepare("SELECT COUNT(*) AS count FROM simulation_runs").get()?.count).toBe(2);
    expect(client.prepare("SELECT COUNT(*) AS count FROM turbine_simulation_results").get()?.count).toBe(24);
  });

  it("marks obsolete results and recalculates comparison from the current settings", async () => {
    await request(app).post("/api/scenarios/north-sea-experiment/simulate").send({}).expect(200);
    await request(app).patch("/api/scenarios/north-sea-experiment/settings").send({ windSpeedMps: 0 }).expect(200);
    const stale = await request(app).get("/api/scenarios/north-sea-experiment/results/latest").expect(200);
    expect(stale.body.data.isStale).toBe(true);
    const comparison = await request(app).get("/api/scenarios/north-sea-experiment/compare")
      .query({ against: "north-sea-baseline" }).expect(200);
    expect(comparison.body.data.experiment.totalPowerMW).toBe(0);
    const latest = await request(app).get("/api/scenarios/north-sea-experiment/results/latest").expect(200);
    expect(latest.body.data.isStale).toBe(false);
  });

  it("returns client errors for malformed JSON and oversized bodies", async () => {
    const malformed = await request(app).post("/api/projects").set("Content-Type", "application/json").send('{"name":').expect(400);
    expect(malformed.body.error.code).toBe("INVALID_JSON");
    const oversized = await request(app).post("/api/projects").send({ name: "x".repeat(110_000) }).expect(413);
    expect(oversized.body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("serves the production root and client routes, but keeps missing assets as 404", async () => {
    const buildDirectory = mkdtempSync(join(tmpdir(), "windscope-static-"));
    try {
      writeFileSync(join(buildDirectory, "index.html"), '<main id="root">WindScope production</main>');
      const productionApp = createApp(db, buildDirectory);
      expect((await request(productionApp).get("/").expect(200)).text).toContain("WindScope production");
      expect((await request(productionApp).get("/scenario/demo").expect(200)).text).toContain("WindScope production");
      await request(productionApp).get("/assets/missing.js").expect(404);
    } finally {
      rmSync(buildDirectory, { recursive: true, force: true });
    }
  });
});

