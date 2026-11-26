import express, { type ErrorRequestHandler, type Request, type Response } from "express";
import { ZodError } from "zod";
import { extname } from "node:path";
import type { WindScopeDatabase } from "./db/client";
import { projects } from "./db/schema";
import {
  compareScenarioToBaseline,
  createExperimentScenario,
  createProject,
  createTurbine,
  deleteProject,
  deleteScenario,
  deleteTurbine,
  getLatestSimulation,
  getProject,
  getScenario,
  listProjects,
  listProjectTurbines,
  promoteScenarioToBaseline,
  renameScenario,
  resetScenarioLayout,
  runScenarioSimulation,
  updateScenarioSettings,
  updateProject,
  updateTurbine,
  updateTurbinePlacement
} from "./farm-service";
import { ApiError } from "./http-error";
import { placementUpdateSchema, projectCreateSchema, projectUpdateSchema, scenarioCreateSchema, scenarioRenameSchema, scenarioSettingsSchema, turbineCreateSchema, turbineUpdateSchema } from "../shared/validation";

function respond<T>(response: Response, data: T, status = 200): void {
  response.status(status).json({ data });
}

function errorHandler(): ErrorRequestHandler {
  return (error: unknown, _request: Request, response: Response, _next) => {
    const bodyErrorType = error && typeof error === "object" && "type" in error ? error.type : undefined;
    if (bodyErrorType === "entity.parse.failed") {
      response.status(400).json({ error: { code: "INVALID_JSON", message: "올바른 JSON 요청 본문을 보내 주세요." } });
      return;
    }
    if (bodyErrorType === "entity.too.large") {
      response.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "요청 본문은 100 KB 이하여야 합니다." } });
      return;
    }
    if (error instanceof ZodError) {
      response.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: error.issues[0]?.message ?? "입력값을 확인해 주세요.",
          details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
        }
      });
      return;
    }
    if (error instanceof ApiError) {
      response.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    console.error("[API] 요청 처리 실패", error);
    response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요." } });
  };
}

export function createApp(db: WindScopeDatabase, clientBuildDirectory?: string) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));

  app.get("/api/health", async (_request, response) => {
    await db.select({ id: projects.id }).from(projects).limit(1).all();
    respond(response, { ok: true, service: "windscope-api", database: "ok" });
  });

  app.get("/api/projects", async (_request, response) => respond(response, await listProjects(db)));
  app.post("/api/projects", async (request, response) => {
    const input = projectCreateSchema.parse(request.body);
    respond(response, await createProject(db, input), 201);
  });
  app.patch("/api/projects/:projectId", async (request, response) => {
    const input = projectUpdateSchema.parse(request.body);
    respond(response, await updateProject(db, request.params.projectId!, input));
  });
  app.delete("/api/projects/:projectId", async (request, response) => {
    respond(response, await deleteProject(db, request.params.projectId!));
  });
  app.get("/api/projects/:projectId", async (request, response) => respond(response, await getProject(db, request.params.projectId!)));
  app.get("/api/projects/:projectId/turbines", async (request, response) => respond(response, await listProjectTurbines(db, request.params.projectId!)));
  app.post("/api/projects/:projectId/turbines", async (request, response) => {
    const input = turbineCreateSchema.parse(request.body);
    respond(response, await createTurbine(db, request.params.projectId!, input), 201);
  });
  app.patch("/api/projects/:projectId/turbines/:turbineId", async (request, response) => {
    const input = turbineUpdateSchema.parse(request.body);
    respond(response, await updateTurbine(db, request.params.projectId!, request.params.turbineId!, input));
  });
  app.delete("/api/projects/:projectId/turbines/:turbineId", async (request, response) => {
    respond(response, await deleteTurbine(db, request.params.projectId!, request.params.turbineId!));
  });
  app.post("/api/projects/:projectId/scenarios", async (request, response) => {
    const input = scenarioCreateSchema.parse(request.body);
    respond(response, await createExperimentScenario(db, request.params.projectId!, input.name, input.sourceScenarioId), 201);
  });
  app.get("/api/scenarios/:scenarioId", async (request, response) => respond(response, await getScenario(db, request.params.scenarioId!)));
  app.patch("/api/scenarios/:scenarioId", async (request, response) => {
    const input = scenarioRenameSchema.parse(request.body);
    respond(response, await renameScenario(db, request.params.scenarioId!, input.name));
  });
  app.delete("/api/scenarios/:scenarioId", async (request, response) => {
    respond(response, await deleteScenario(db, request.params.scenarioId!));
  });
  app.post("/api/scenarios/:scenarioId/promote-baseline", async (request, response) => {
    respond(response, await promoteScenarioToBaseline(db, request.params.scenarioId!));
  });
  app.patch("/api/scenarios/:scenarioId/settings", async (request, response) => {
    const input = scenarioSettingsSchema.parse(request.body);
    respond(response, await updateScenarioSettings(db, request.params.scenarioId!, input));
  });
  app.put("/api/scenarios/:scenarioId/turbines/:turbineId", async (request, response) => {
    const input = placementUpdateSchema.parse(request.body);
    respond(response, await updateTurbinePlacement(db, request.params.scenarioId!, request.params.turbineId!, input));
  });
  app.post("/api/scenarios/:scenarioId/reset-layout", async (request, response) => {
    respond(response, await resetScenarioLayout(db, request.params.scenarioId!));
  });
  app.post("/api/scenarios/:scenarioId/simulate", async (request, response) => {
    respond(response, await runScenarioSimulation(db, request.params.scenarioId!));
  });
  app.get("/api/scenarios/:scenarioId/results/latest", async (request, response) => {
    respond(response, await getLatestSimulation(db, request.params.scenarioId!));
  });
  app.get("/api/scenarios/:scenarioId/compare", async (request, response) => {
    const against = request.query.against;
    if (typeof against !== "string" || against.length === 0) {
      throw new ApiError(400, "VALIDATION_ERROR", "against 기준 시나리오 ID가 필요합니다.");
    }
    const mode = request.query.mode ?? "scenario";
    if (mode !== "layout" && mode !== "scenario") throw new ApiError(400, "VALIDATION_ERROR", "비교 방식은 layout 또는 scenario여야 합니다.");
    respond(response, await compareScenarioToBaseline(db, request.params.scenarioId!, against, mode));
  });
  app.post("/api/scenarios/:scenarioId/duplicate", async (request, response) => {
    const input = scenarioCreateSchema.parse(request.body);
    const source = await getScenario(db, request.params.scenarioId!);
    respond(response, await createExperimentScenario(db, source.projectId, input.name, source.id), 201);
  });

  app.use("/api", (_request, response) => {
    response.status(404).json({ error: { code: "NOT_FOUND", message: "API 경로를 찾을 수 없습니다." } });
  });
  if (clientBuildDirectory) {
    app.use(express.static(clientBuildDirectory, { index: false, maxAge: "1h" }));
    app.get("/{*splat}", (request, response, next) => {
      if (extname(request.path)) {
        response.status(404).send("파일을 찾을 수 없습니다.");
        return;
      }
      response.setHeader("Cache-Control", "no-cache");
      response.sendFile("index.html", { root: clientBuildDirectory }, (error) => {
        if (error) next(error);
      });
    });
  }
  app.use(errorHandler());
  return app;
}

