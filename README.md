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
- Turn on **편집 모드** to drag turbines on the horizontal plane. You can also save X (east-positive) and Y (north-positive) coordinates in metres. The interface flags close spacing and blocks overlapping placements. **기준 배치 복원** copies baseline positions and commands into the selected experiment.
- Set an individual turbine to normal operation, manual stop, or maintenance stop. Manual and maintenance stops produce no power and are not treated as wake sources by this simplified model.
- Compare the selected experiment with the project's read-only baseline. The output change is `experiment total output - baseline total output`. Wake-loss percentage is each scenario's estimated loss divided by that scenario's no-wake output.

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
```

`npm run db:setup` applies pending versioned SQLite migrations and inserts only missing demo records. `npm run db:seed` repeats the non-destructive sample-data check. Neither command drops tables or resets the database.

Browser checks use installed Microsoft Edge on Windows and an isolated temporary SQLite database. On other systems, install Chromium with `npx playwright install chromium`. Set `PLAYWRIGHT_CHANNEL=chrome` to check an installed Chrome instead. Browser tests cover actual WebGL rendering, rotor motion, wake direction, pointer dragging, baseline protection, saved state, failed requests, timeouts, mobile layout and WebGL context recovery.

The comparison selector offers **배치만 비교** (identical weather and operating commands, different positions) and **전체 조건 비교** (each scenario's stored conditions). Baseline data is preserved in both modes. Per-turbine baseline output and differences are included in the results table.

The wake model version is `jensen-circle-overlap-rss-v2`. Centerline deficit uses `(1 - sqrt(1 - Ct)) / (1 + k*x/R)^2`, following [the Jensen equation in Wind Energy Science, equation 6](https://wes.copernicus.org/articles/5/1601/2020/). Old saved results are detected as stale after input or model changes.

For a database backup, stop the app and copy the entire `data/` directory to a separate backup directory. Restore only while the app is stopped. If startup fails, check Node version, occupied ports, `.env` values, and write permission for the database directory; the terminal prints the underlying error.

### Audit results (2026-11-26)

- Type checking and production build passed; 44 numerical, API, database and scene-math tests passed.
- Eight Edge browser scenarios passed across the full run and targeted timeout rerun. The timeout harness was corrected to avoid aborting a request already cancelled by the app.
- Fresh `npm run dev` prepared an isolated database, served the frontend and proxied API health with HTTP 200; both services stopped with Ctrl+C.
- Screenshots were inspected at desktop and 390 px mobile widths. Browser checks use a headless Edge context; physical mobile devices and other browser engines have not been checked.
- Remaining non-fatal warnings: Fiber uses the deprecated `THREE.Clock`; the lazily loaded 3D chunk exceeds Vite's 500 KB warning threshold (about 277 KB gzip). Engineering accuracy still requires manufacturer/site calibration.

## Main areas

- `src/client/` — dashboard, API client, responsive controls, and React Three Fiber scene.
- `src/server/` — Express routes and scenario/simulation services.
- `src/server/db/` — typed Drizzle schema, versioned SQL migrations, and sample seed.
- `src/shared/` — domain types, unit/coordinate helpers, validation, and the pure simulation model.
