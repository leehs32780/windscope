import "dotenv/config";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle, type SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import { projects, scenarios, scenarioTurbines, simulationRuns, turbineSimulationResults, turbines } from "./schema";

const schema = { projects, turbines, scenarios, scenarioTurbines, simulationRuns, turbineSimulationResults };

export type WindScopeDatabase = SqliteRemoteDatabase<typeof schema>;

export function resolveDatabasePath(databaseUrl = process.env.DATABASE_URL ?? "file:./data/windscope.db"): string {
  if (databaseUrl === ":memory:") return databaseUrl;
  const filePath = databaseUrl.startsWith("file:") ? decodeURIComponent(databaseUrl.slice("file:".length)) : databaseUrl;
  return isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
}

export function createDatabase(databaseUrl?: string): { client: DatabaseSync; db: WindScopeDatabase } {
  const databasePath = resolveDatabasePath(databaseUrl);
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
  const client = new DatabaseSync(databasePath);
  client.exec("PRAGMA foreign_keys = ON;");
  client.exec("PRAGMA journal_mode = WAL;");
  const db = drizzle(async (query, params, method) => {
    const statement = client.prepare(query);
    if (method === "run") {
      statement.run(...params);
      return { rows: [] };
    }
    if (method === "get") {
      const row = statement.get(...params);
      return { rows: row ? [row] : [] };
    }
    const rows = statement.all(...params);
    return { rows: method === "values" ? rows.map((row) => Object.values(row)) : rows };
  }, { schema });
  return { client, db };
}

export function applyMigrations(client: DatabaseSync): void {
  client.exec(`CREATE TABLE IF NOT EXISTS windscope_migrations (
    name TEXT PRIMARY KEY NOT NULL,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const migrationDirectory = resolve(process.cwd(), "src/server/db/migrations");
  const migrationNames = readdirSync(migrationDirectory).filter((name) => name.endsWith(".sql")).sort();
  const isApplied = client.prepare("SELECT name FROM windscope_migrations WHERE name = ?");
  const markApplied = client.prepare("INSERT INTO windscope_migrations(name) VALUES (?)");

  for (const migrationName of migrationNames) {
    if (isApplied.get(migrationName)) continue;
    const migrationSql = readFileSync(resolve(migrationDirectory, migrationName), "utf8");
    client.exec("BEGIN IMMEDIATE;");
    try {
      client.exec(migrationSql);
      markApplied.run(migrationName);
      client.exec("COMMIT;");
    } catch (error) {
      client.exec("ROLLBACK;");
      throw error;
    }
  }
}

