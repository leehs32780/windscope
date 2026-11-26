import "dotenv/config";
import { applyMigrations, createDatabase } from "../src/server/db/client";
import { seedDemoFarm } from "../src/server/db/seed";

const { client, db } = createDatabase();
try {
  applyMigrations(client);
  await seedDemoFarm(db);
  console.info(`[DB] WindScope SQLite 준비 완료: ${process.env.DATABASE_URL ?? "file:./data/windscope.db"}`);
} finally {
  client.close();
}

