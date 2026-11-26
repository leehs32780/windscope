CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS turbines (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  rated_power_mw REAL NOT NULL,
  rotor_diameter_m REAL NOT NULL,
  hub_height_m REAL NOT NULL,
  cut_in_mps REAL NOT NULL,
  rated_wind_mps REAL NOT NULL,
  cut_out_mps REAL NOT NULL,
  thrust_coefficient REAL NOT NULL,
  wake_expansion REAL NOT NULL,
  power_curve_json TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS turbines_project_name_unique ON turbines(project_id, name);
CREATE INDEX IF NOT EXISTS turbines_project_order_idx ON turbines(project_id, display_order);

CREATE TABLE IF NOT EXISTS scenarios (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('baseline', 'experiment')),
  wind_speed_mps REAL NOT NULL DEFAULT 9.5,
  wind_direction_deg REAL NOT NULL DEFAULT 0,
  air_density_kg_m3 REAL NOT NULL DEFAULT 1.225,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS scenarios_project_role_idx ON scenarios(project_id, role);

CREATE TABLE IF NOT EXISTS scenario_turbines (
  scenario_id TEXT NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  turbine_id TEXT NOT NULL REFERENCES turbines(id) ON DELETE CASCADE,
  x_m REAL NOT NULL,
  y_m REAL NOT NULL,
  command TEXT NOT NULL DEFAULT 'operational' CHECK (command IN ('operational', 'manual_stop', 'maintenance_stop')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (scenario_id, turbine_id)
);
CREATE INDEX IF NOT EXISTS scenario_turbines_turbine_idx ON scenario_turbines(turbine_id);

CREATE TABLE IF NOT EXISTS simulation_runs (
  id TEXT PRIMARY KEY NOT NULL,
  scenario_id TEXT NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  model_version TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  input_json TEXT NOT NULL,
  total_power_mw REAL NOT NULL,
  no_wake_power_mw REAL NOT NULL,
  wake_loss_mw REAL NOT NULL,
  wake_loss_percent REAL,
  calculated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS simulation_runs_scenario_calculated_idx ON simulation_runs(scenario_id, calculated_at);

CREATE TABLE IF NOT EXISTS turbine_simulation_results (
  simulation_run_id TEXT NOT NULL REFERENCES simulation_runs(id) ON DELETE CASCADE,
  turbine_id TEXT NOT NULL REFERENCES turbines(id) ON DELETE CASCADE,
  effective_wind_mps REAL NOT NULL,
  wake_deficit_mps REAL NOT NULL,
  power_mw REAL NOT NULL,
  no_wake_power_mw REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('operating', 'manual_stop', 'maintenance_stop', 'low_wind', 'high_wind')),
  upstream_turbine_ids_json TEXT NOT NULL,
  PRIMARY KEY (simulation_run_id, turbine_id)
);
