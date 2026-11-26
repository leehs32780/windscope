import { and, asc, eq } from "drizzle-orm";
import type { WindScopeDatabase } from "../db/client";
import { projects, scenarios, scenarioTurbines, turbines } from "../db/schema";

/**
 * Database-only operations for farm resources. Services own validation and
 * business rules; this repository owns query construction and persistence.
 */
export class FarmRepository {
  constructor(private readonly db: WindScopeDatabase) {}

  listProjects() {
    return this.db.select({ id: projects.id, name: projects.name, description: projects.description })
      .from(projects).orderBy(asc(projects.createdAt)).all();
  }

  findProject(projectId: string) {
    return this.db.select().from(projects).where(eq(projects.id, projectId)).get();
  }

  listProjectScenarios(projectId: string) {
    return this.db.select().from(scenarios).where(eq(scenarios.projectId, projectId)).orderBy(asc(scenarios.createdAt)).all();
  }

  listProjectTurbines(projectId: string) {
    return this.db.select().from(turbines).where(eq(turbines.projectId, projectId)).orderBy(asc(turbines.displayOrder)).all();
  }

  findProjectTurbine(projectId: string, turbineId: string) {
    return this.db.select().from(turbines)
      .where(and(eq(turbines.projectId, projectId), eq(turbines.id, turbineId))).get();
  }

  findScenario(scenarioId: string) {
    return this.db.select().from(scenarios).where(eq(scenarios.id, scenarioId)).get();
  }

  findBaseline(projectId: string) {
    return this.db.select().from(scenarios)
      .where(and(eq(scenarios.projectId, projectId), eq(scenarios.role, "baseline"))).get();
  }

  listScenarioPlacements(scenarioId: string) {
    return this.db.select().from(scenarioTurbines).where(eq(scenarioTurbines.scenarioId, scenarioId)).all();
  }

  async deleteProject(projectId: string) {
    await this.db.delete(projects).where(eq(projects.id, projectId)).run();
  }

  async deleteScenario(scenarioId: string) {
    await this.db.delete(scenarios).where(eq(scenarios.id, scenarioId)).run();
  }
}

export function farmRepository(db: WindScopeDatabase) {
  return new FarmRepository(db);
}
