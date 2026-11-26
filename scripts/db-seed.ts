import "dotenv/config";
import { applyMigrations, createDatabase } from "../src/server/db/client";
import { seedDemoFarm } from "../src/server/db/seed";

const { client, db } = createDatabase();
try {
  applyMigrations(client);
  await seedDemoFarm(db);
  console.info("[DB] 누락된 North Sea Demo 샘플 데이터 확인/보완 완료");
} finally {
  client.close();
}

