import "dotenv/config";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { applyMigrations, createDatabase } from "./db/client";
import { seedDemoFarm } from "./db/seed";
import { createApp } from "./app";

const { client, db } = createDatabase();
applyMigrations(client);
await seedDemoFarm(db);
const clientBuildDirectory = resolve(process.cwd(), "dist/client");
const app = createApp(db, existsSync(resolve(clientBuildDirectory, "index.html")) ? clientBuildDirectory : undefined);
const port = Number(process.env.API_PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("API_PORT는 1~65535 범위의 정수여야 합니다.");

const server = app.listen(port, "127.0.0.1", () => {
  console.info(`[API] http://localhost:${port}`);
  if (clientBuildDirectory) console.info(`[APP] npm run build 후 http://localhost:${port} 에서 제공됩니다.`);
});

function shutdown() {
  server.close(() => {
    client.close();
    process.exit(0);
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

