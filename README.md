# WindScope

WindScope is a Korean-language offshore wind farm simulator for education and early design exploration. It connects a React/Three.js dashboard to a typed simulation module, an Express API, and a local SQLite database.

The application shows an example 12-turbine farm, wind flow, expanded wakes, per-turbine output, and a comparison between a read-only baseline and editable experiments. The sample farm is fictional and is not measured data from a real project.

## Run on Windows

Use Node.js 24 or later. In PowerShell, check the installed versions from the project folder:

```powershell
node -v
npm -v
npm install
npm run dev
```

`npm run dev` prepares the SQLite database without deleting existing data, adds any missing sample records, and starts the API and Vite development server together. Open the exact local address printed by Vite, usually `http://127.0.0.1:5173/`.

The API is available at `http://localhost:3001`; `GET /api/health` checks its SQLite connection. Vite forwards `/api` requests to that API. The default ports are strict: if 5173 or 3001 is already in use, stop the other process or set `API_PORT` in `.env` before starting again.

The default database is `data/windscope.db`. The `data/` directory and SQLite files are ignored by Git. To use a different local path, copy `.env.example` to `.env` and change `DATABASE_URL`; no API key or external service is needed.

## Use the simulator

- Change wind speed with the slider or number field. Change wind direction with the compass, degree field, or cardinal presets. The angle is measured clockwise from north, and the displayed arrow points to where the wind comes from.
- Select a turbine in the scene or the results table to inspect its current estimated output, effective wind speed, wake deficit, status, and coordinates.
- Use **실험 복제** or a quick experiment preset to make an editable copy. Presets never replace the selected scenario.
- Open **관리** to create, edit or delete projects; add/edit/delete turbine definitions; enter a manufacturer-supplied power curve as JSON; delete experiments; or promote an experiment to the baseline. A new project intentionally starts empty and guides you to add its first turbine.
- Turn on **편집 모드** to drag turbines on the horizontal plane. You can also save X (east-positive) and Y (north-positive) coordinates in metres. The interface flags close spacing and blocks overlapping placements. **기준 배치 복원** copies baseline positions and commands into the selected experiment.
- Set an individual turbine to normal operation, manual stop, or maintenance stop. Manual and maintenance stops produce no power and are not treated as wake sources by this simplified model.
- Compare the selected experiment with the project's read-only baseline. The output change is `experiment total output - baseline total output`. Wake-loss percentage is each scenario's estimated loss divided by that scenario's no-wake output.
- The turbine comparison chart is keyboard selectable and is paired with the exact-value results table, so the same information remains available without relying on colour or the 3D scene.

## Data lifecycle and deletion policy

- A project owns its turbine definitions, baseline, experiments, placements and stored simulation runs. Deleting a project removes that full owned graph in one database transaction.
- Deleting a turbine removes it from every scenario in the project and removes its stored per-turbine results. The next run is recalculated from the changed input hash.
- Deleting an experiment removes its placements and stored runs. The current baseline cannot be deleted directly.
- Promoting an experiment copies it into the stable baseline record, archives the previous baseline as an experiment, and leaves an editable experiment available. A partial unique SQLite index guarantees one baseline per project.
- Project, scenario and turbine reads are isolated behind `src/server/repositories/farm-repository.ts`; multi-row validation and writes remain in the service transaction layer.

## Model assumptions

All outputs are estimates. They are not certified engineering calculations and should not be used as a substitute for manufacturer power curves, measured site wind data, terrain and wave effects, atmospheric stability, turbulence analysis, or validated flow modelling.

- The demo turbine settings are 8 MW rated output, 160 m rotor diameter, 105 m hub height, 3 m/s cut-in, 12 m/s rated wind speed, and 25 m/s cut-out. Its piecewise-linear power curve is an educational example, not a universal turbine curve.
- A Jensen/Park-style wake expands with a 0.05 expansion coefficient. The model uses a 0.8 thrust coefficient and the circular overlap area between the expanded wake and a target rotor. Overlapping velocity deficits are combined with root-sum-square and limited so effective wind speed cannot become negative.
- Power is interpolated from the configured curve, scaled by air density relative to 1.225 kg/m³, and capped at rated output. Low-wind and cut-out conditions produce zero output.
- Parked, maintenance, low-wind, and high-wind turbines are not used as wake sources. Their full aerodynamic effect is not modelled.
- Wake-loss percentage is shown against the estimated output without wakes. When the no-wake output is zero, the percentage is shown as unavailable instead of dividing by zero.

## Checks

```powershell
npm test
npm run typecheck
npm run build
npm run test:e2e
npm run test:a11y
npm run test:e2e:cross-browser
```

`npm run db:setup` applies pending versioned SQLite migrations and inserts only missing demo records. `npm run db:seed` repeats the non-destructive sample-data check. Neither command drops tables or resets the database.

Browser checks use installed Microsoft Edge on Windows and an isolated temporary SQLite database. Install the bundled cross-engine browsers with `npx playwright install chromium firefox webkit`; set `PLAYWRIGHT_CHANNEL=chrome` to use an installed Chrome for Chromium projects. Browser tests cover actual WebGL rendering, rotor motion, wake direction, pointer dragging, project/turbine management, baseline promotion, saved state, failed requests, timeouts, WCAG A/AA automation, keyboard flow, mobile layout and WebGL context recovery.

The comparison selector offers **배치만 비교** (identical weather and operating commands, different positions) and **전체 조건 비교** (each scenario's stored conditions). Baseline data is preserved in both modes. Per-turbine baseline output and differences are included in the results table.

The wake model version is `jensen-circle-overlap-rss-v2`. Centerline deficit uses `(1 - sqrt(1 - Ct)) / (1 + k*x/R)^2`, following [the Jensen equation in Wind Energy Science, equation 6](https://wes.copernicus.org/articles/5/1601/2020/). Old saved results are detected as stale after input or model changes.

For a database backup, stop the app and copy the entire `data/` directory to a separate backup directory. Restore only while the app is stopped. If startup fails, check Node version, occupied ports, `.env` values, and write permission for the database directory; the terminal prints the underlying error.

### Audit results (2026-11-26)

- Type checking and the production build pass; 47 numerical, API, database and scene-math tests pass.
- All 16 browser checks pass. The Edge suite covers real WebGL rendering and animation, drag persistence, failure recovery, project/turbine CRUD, baseline promotion, accessibility and keyboard operation. Firefox desktop, WebKit desktop, Edge mobile emulation and WebKit iPhone emulation also pass the core 3D/layout checks.
- A clean source archive installs 238 packages with `npm ci` and reports zero vulnerabilities; fresh database setup, all 47 tests and the production build pass from that copy.
- The production bundle is split into React Three and Three core groups and builds without Vite's former large-chunk warning.
- Three.js is intentionally pinned to r182, within Fiber and Drei's declared compatibility ranges, until React Three Fiber replaces its deprecated internal `Clock` with `Timer`. This removes the runtime deprecation warning without suppressing console output.
- Automated mobile emulation is covered, but physical iOS/Android devices and assistive-technology sessions still require human/device-lab verification. Engineering accuracy still requires manufacturer power curves, site measurements and validated flow-model calibration.

## Main areas

- `src/client/` — dashboard, API client, responsive controls, and React Three Fiber scene.
- `src/server/` — Express routes, transactional scenario/simulation services, and the farm repository boundary.
- `src/server/db/` — typed Drizzle schema, versioned SQL migrations, and sample seed.
- `src/shared/` — domain types, unit/coordinate helpers, validation, and the pure simulation model.
