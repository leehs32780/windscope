import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDatabase, applyMigrations } from "./client";
import { projects } from "./schema";
import { seedDemoFarm } from "./seed";
import { getScenario, updateScenarioSettings, updateTurbinePlacement } from "../farm-service";

describe("SQLite transaction isolation and persistence", () => {
  const connections: ReturnType<typeof createDatabase>[] = [];
  const directories: string[] = [];
  const open = (url = ":memory:") => {
    const connection = createDatabase(url);
    connections.push(connection);
    applyMigrations(connection.client);
    return connection;
  };

  afterEach(() => {
    for (const connection of connections) connection.client.close();
    connections.length = 0;
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
    directories.length = 0;
  });

  it("serializes concurrent transactions on one SQLite connection", async () => {
    const { db, client } = open();
    await Promise.all(Array.from({ length: 8 }, (_, index) => db.transaction(async (tx) => {
      await tx.insert(projects).values({ id: `project-${index}`, name: `Project ${index}` }).run();
      await tx.update(projects).set({ description: "committed" }).where(eq(projects.id, `project-${index}`)).run();
    })));
    expect(client.prepare("SELECT COUNT(*) AS count FROM projects WHERE description = 'committed'").get()?.count).toBe(8);
  });

  it("does not roll back a separate request's write with a failing transaction", async () => {
    const { db } = open();
    let notifyStarted!: () => void;
    let allowRollback!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const rollbackAllowed = new Promise<void>((resolve) => { allowRollback = resolve; });
    const failing = db.transaction(async (tx) => {
      await tx.insert(projects).values({ id: "rollback", name: "Uncommitted" }).run();
      notifyStarted();
      await rollbackAllowed;
      throw new Error("deliberate rollback");
    });
    await started;
    const independent = db.insert(projects).values({ id: "keep", name: "Separate request" }).run();
    allowRollback();
    await expect(failing).rejects.toThrow("deliberate rollback");
    await independent;
    expect((await db.select().from(projects).all()).map((project) => project.id)).toEqual(["keep"]);
  });

  it("makes competing read-validate-write placements atomic", async () => {
    const { db } = open();
    await seedDemoFarm(db);
    const results = await Promise.allSettled([
      updateTurbinePlacement(db, "north-sea-experiment", "north-sea-turbine-01", { xM: 2_000, yM: 2_000 }),
      updateTurbinePlacement(db, "north-sea-experiment", "north-sea-turbine-02", { xM: 2_000, yM: 2_000 })
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const scenario = await getScenario(db, "north-sea-experiment");
    expect(scenario.turbines.filter((turbine) => turbine.xM === 2_000 && turbine.yM === 2_000)).toHaveLength(1);
  });

  it("preserves edits and row counts after repeated setup and reopening a file database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "windscope-persistence-"));
    directories.push(directory);
    const databaseFile = join(directory, "test.db");
    const first = open(databaseFile);
    await seedDemoFarm(first.db);
    await updateScenarioSettings(first.db, "north-sea-experiment", { windSpeedMps: 13.2 });
    await updateTurbinePlacement(first.db, "north-sea-experiment", "north-sea-turbine-01", { command: "maintenance_stop", xM: -900 });
    await seedDemoFarm(first.db);
    applyMigrations(first.client);
    first.client.close();
    connections.splice(connections.indexOf(first), 1);

    const reopened = open(databaseFile);
    await seedDemoFarm(reopened.db);
    const scenario = await getScenario(reopened.db, "north-sea-experiment");
    expect(scenario.windSpeedMps).toBe(13.2);
    expect(scenario.turbines[0]).toMatchObject({ xM: -900, command: "maintenance_stop" });
    expect(reopened.client.prepare("SELECT COUNT(*) AS count FROM turbines").get()?.count).toBe(12);
    expect(reopened.client.prepare("SELECT COUNT(*) AS count FROM scenarios").get()?.count).toBe(2);
    expect(reopened.client.prepare("SELECT COUNT(*) AS count FROM scenario_turbines").get()?.count).toBe(24);
    expect((await getScenario(reopened.db, "north-sea-baseline")).turbines[0]).toMatchObject({ xM: -700, command: "operational" });
  });
});
