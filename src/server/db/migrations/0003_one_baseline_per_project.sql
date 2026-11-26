CREATE UNIQUE INDEX IF NOT EXISTS scenarios_one_baseline_per_project
ON scenarios(project_id)
WHERE role = 'baseline';
