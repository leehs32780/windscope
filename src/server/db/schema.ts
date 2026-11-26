import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`)
});

export const turbines = sqliteTable("turbines", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  ratedPowerMW: real("rated_power_mw").notNull(),
  rotorDiameterM: real("rotor_diameter_m").notNull(),
  hubHeightM: real("hub_height_m").notNull(),
  cutInMps: real("cut_in_mps").notNull(),
  ratedWindMps: real("rated_wind_mps").notNull(),
  cutOutMps: real("cut_out_mps").notNull(),
  thrustCoefficient: real("thrust_coefficient").notNull(),
  wakeExpansion: real("wake_expansion").notNull(),
  powerCurveJson: text("power_curve_json").notNull(),
  displayOrder: integer("display_order").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`)
}, (table) => ({
  projectNameUnique: uniqueIndex("turbines_project_name_unique").on(table.projectId, table.name),
  projectOrderIdx: index("turbines_project_order_idx").on(table.projectId, table.displayOrder)
}));

export const scenarios = sqliteTable("scenarios", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  role: text("role", { enum: ["baseline", "experiment"] }).notNull(),
  windSpeedMps: real("wind_speed_mps").notNull().default(9.5),
  windDirectionDeg: real("wind_direction_deg").notNull().default(0),
  airDensityKgM3: real("air_density_kg_m3").notNull().default(1.225),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`)
}, (table) => ({
  projectRoleIdx: index("scenarios_project_role_idx").on(table.projectId, table.role)
}));

export const scenarioTurbines = sqliteTable("scenario_turbines", {
  scenarioId: text("scenario_id").notNull().references(() => scenarios.id, { onDelete: "cascade" }),
  turbineId: text("turbine_id").notNull().references(() => turbines.id, { onDelete: "cascade" }),
  xM: real("x_m").notNull(),
  yM: real("y_m").notNull(),
  command: text("command", { enum: ["operational", "manual_stop", "maintenance_stop"] }).notNull().default("operational"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`)
}, (table) => ({
  pk: primaryKey({ columns: [table.scenarioId, table.turbineId] }),
  turbineIdx: index("scenario_turbines_turbine_idx").on(table.turbineId)
}));

export const simulationRuns = sqliteTable("simulation_runs", {
  id: text("id").primaryKey(),
  scenarioId: text("scenario_id").notNull().references(() => scenarios.id, { onDelete: "cascade" }),
  modelVersion: text("model_version").notNull(),
  inputHash: text("input_hash").notNull(),
  inputJson: text("input_json").notNull(),
  totalPowerMW: real("total_power_mw").notNull(),
  noWakePowerMW: real("no_wake_power_mw").notNull(),
  wakeLossMW: real("wake_loss_mw").notNull(),
  wakeLossPercent: real("wake_loss_percent"),
  calculatedAt: text("calculated_at").notNull().default(sql`CURRENT_TIMESTAMP`)
}, (table) => ({
  scenarioRunIdx: index("simulation_runs_scenario_calculated_idx").on(table.scenarioId, table.calculatedAt)
}));

export const turbineSimulationResults = sqliteTable("turbine_simulation_results", {
  simulationRunId: text("simulation_run_id").notNull().references(() => simulationRuns.id, { onDelete: "cascade" }),
  turbineId: text("turbine_id").notNull().references(() => turbines.id, { onDelete: "cascade" }),
  effectiveWindMps: real("effective_wind_mps").notNull(),
  wakeDeficitMps: real("wake_deficit_mps").notNull(),
  powerMW: real("power_mw").notNull(),
  noWakePowerMW: real("no_wake_power_mw").notNull(),
  status: text("status", { enum: ["operating", "manual_stop", "maintenance_stop", "low_wind", "high_wind"] }).notNull(),
  upstreamTurbineIdsJson: text("upstream_turbine_ids_json").notNull()
}, (table) => ({
  pk: primaryKey({ columns: [table.simulationRunId, table.turbineId] })
}));

