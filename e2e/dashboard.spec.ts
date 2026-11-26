import { test, expect, type Page } from "@playwright/test";

const firstTurbine = "north-sea-turbine-01";
let runtimeErrors: string[];
let scenarioId: string;

async function saved(page: Page) {
  await expect(page.getByLabel("시나리오 선택")).toBeEnabled();
  await expect(page.locator(".summary-run-state")).toContainText("계산 완료");
  await expect(page.locator(".save-pill")).toHaveText("저장됨");
}

async function scene(page: Page, turbineId = firstTurbine) {
  return page.evaluate(async (id) => {
    const modulePath = "/node_modules/.vite/deps/@react-three_fiber.js";
    const fiber = await import(modulePath) as typeof import("@react-three/fiber");
    const canvas = document.querySelector("canvas")!;
    const state = fiber._roots.get(canvas)!.store.getState();
    const rotor = state.scene.getObjectByName(`rotor-${id}`)!;
    const point = rotor.getWorldPosition(rotor.position.clone()).project(state.camera);
    const rect = canvas.getBoundingClientRect();
    const names: string[] = [];
    state.scene.traverse((object) => { if (object.name) names.push(object.name); });
    const wake = state.scene.getObjectByName(`wake-${id}`)?.children[0];
    const wakeDirection = wake ? rotor.position.clone().set(0, 1, 0).applyQuaternion(wake.quaternion).toArray() : null;
    const context = state.gl.getContext();
    const rendererInfo = context.getExtension("WEBGL_debug_renderer_info");
    return {
      rotorAngle: rotor.rotation.z,
      wakeCount: names.filter((name) => name.startsWith("wake-")).length,
      turbineCount: names.filter((name) => name.startsWith("turbine-")).length,
      drawCalls: state.gl.info.render.calls,
      point: { x: rect.left + (point.x + 1) * rect.width / 2, y: rect.top + (1 - point.y) * rect.height / 2 },
      ndc: { x: point.x, y: point.y, z: point.z },
      camera: state.camera.position.toArray(),
      renderer: rendererInfo ? context.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL) as string : "unavailable",
      wakeDirection,
      hasWake: names.includes(`wake-${id}`),
      particleVisible: state.scene.getObjectByName("wind-particles")?.visible
    };
  }, turbineId);
}

test.beforeEach(async ({ page, request }, testInfo) => {
  runtimeErrors = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("Failed to load resource")) runtimeErrors.push(message.text());
  });
  const response = await request.post("/api/scenarios/north-sea-baseline/duplicate", { data: { name: `Audit ${testInfo.testId.slice(-12)}` } });
  expect(response.ok()).toBeTruthy();
  scenarioId = (await response.json()).data.id;
  await page.addInitScript((id) => {
    if (!localStorage.getItem("windscope.selection")) localStorage.setItem("windscope.selection", JSON.stringify({ projectId: "north-sea-demo", scenarioId: id }));
  }, scenarioId);
  await page.goto("/");
  await saved(page);
  await expect(page.getByTestId("farm-scene")).toHaveAttribute("data-render-state", "ready");
});

test.afterEach(() => expect(runtimeErrors).toEqual([]));

test("renders and animates twelve actual WebGL turbines with fitted camera", async ({ page }, testInfo) => {
  const initial = await scene(page);
  expect(initial.turbineCount).toBe(12);
  expect(initial.wakeCount).toBe(12);
  expect(initial.drawCalls).toBeGreaterThan(20);
  expect(Math.abs(initial.ndc.x)).toBeLessThan(0.95);
  expect(Math.abs(initial.ndc.y)).toBeLessThan(0.95);
  await expect.poll(async () => (await scene(page)).rotorAngle).not.toBe(initial.rotorAngle);
  await page.screenshot({ path: testInfo.outputPath("desktop.png"), fullPage: true });
  await testInfo.attach("WebGL scene evidence", { body: JSON.stringify(initial, null, 2), contentType: "application/json" });
});

test("wind persists, stopped rotors and wakes stop, presets preserve the source", async ({ page, request }) => {
  await page.getByLabel("풍속", { exact: true }).fill("12");
  await saved(page);
  await page.getByLabel("풍향", { exact: true }).fill("360");
  await expect(page.getByLabel("풍향", { exact: true })).toHaveValue("0");
  await saved(page);
  await page.getByRole("button", { name: "동풍", exact: true }).click();
  await saved(page);
  await expect(page.getByLabel("풍향", { exact: true })).toHaveValue("90");
  const eastWind = await scene(page);
  expect(eastWind.wakeDirection![0]).toBeCloseTo(-1, 5);
  expect(eastWind.wakeDirection![2]).toBeCloseTo(0, 5);
  await page.getByLabel("운전 명령").selectOption("manual_stop");
  await saved(page);
  await expect(page.locator(".detail-output > div").first()).toContainText("0.00");
  const stopped = await scene(page);
  expect(stopped.hasWake).toBe(false);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect((await scene(page)).rotorAngle).toBe(stopped.rotorAngle);
  await page.reload();
  await saved(page);
  await expect(page.getByLabel("시나리오 선택")).toHaveValue(scenarioId);
  await expect(page.getByLabel("풍속", { exact: true })).toHaveValue("12");
  await expect(page.getByLabel("운전 명령")).toHaveValue("manual_stop");
  await page.getByRole("button", { name: /강풍 상황/ }).click();
  await saved(page);
  await expect(page.getByLabel("시나리오 선택")).not.toHaveValue(scenarioId);
  await expect(page.getByLabel("풍속", { exact: true })).toHaveValue("28");
  expect((await scene(page)).wakeCount).toBe(0);
  const original = (await (await request.get(`/api/scenarios/${scenarioId}`)).json()).data;
  expect(original.windSpeedMps).toBe(12);
  expect(original.turbines[0].command).toBe("manual_stop");
});

test("real pointer drag saves on release and reset requires confirmation", async ({ page, request }) => {
  await page.getByRole("button", { name: "편집 모드", exact: true }).click();
  const before = (await (await request.get(`/api/scenarios/${scenarioId}`)).json()).data.turbines[0];
  const initial = await scene(page);
  await page.mouse.move(initial.point.x, initial.point.y);
  await page.mouse.down();
  await page.mouse.move(initial.point.x + 45, initial.point.y + 15, { steps: 8 });
  const during = (await (await request.get(`/api/scenarios/${scenarioId}`)).json()).data.turbines[0];
  expect(during.xM).toBe(before.xM);
  await page.mouse.up();
  await saved(page);
  const after = (await (await request.get(`/api/scenarios/${scenarioId}`)).json()).data.turbines[0];
  expect(Math.hypot(after.xM - before.xM, after.yM - before.yM)).toBeGreaterThan(10);
  expect(Math.hypot(after.xM - before.xM, after.yM - before.yM)).toBeLessThan(1_000);
  expect((await (await request.get("/api/scenarios/north-sea-baseline")).json()).data.turbines[0].xM).toBe(before.xM);
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("button", { name: "기준 배치 복원", exact: true }).click();
  expect((await (await request.get(`/api/scenarios/${scenarioId}`)).json()).data.turbines[0].xM).toBe(after.xM);
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "기준 배치 복원", exact: true }).click();
  await saved(page);
  expect((await (await request.get(`/api/scenarios/${scenarioId}`)).json()).data.turbines[0].xM).toBe(before.xM);
});

test("API failure retains draft and retry succeeds; comparison modes differ", async ({ page }) => {
  let attempted = 0;
  await page.route("**/settings", async route => {
    attempted++;
    if (attempted === 1) return route.fulfill({ status: 503, json: { error: { message: "검증용 일시 오류" } } });
    return route.continue();
  });
  await page.getByLabel("풍속", { exact: true }).fill("13.4");
  await expect(page.getByRole("alert")).toContainText("검증용 일시 오류");
  await expect(page.getByLabel("풍속", { exact: true })).toHaveValue("13.4");
  await expect(page.getByLabel("시나리오 선택")).toBeDisabled();
  await expect(page.locator(".kpi-card--hero > strong")).toContainText("—");
  expect(attempted).toBe(1);
  await page.getByRole("button", { name: "다시 저장" }).click();
  await saved(page);
  expect(attempted).toBe(2);
  await page.getByLabel("비교 방식").selectOption("scenario");
  await expect(page.getByText("풍속·풍향·공기 밀도가 서로 다릅니다.", { exact: false })).toBeVisible();
  await page.getByLabel("비교 방식").selectOption("layout");
  await expect(page.locator(".comparison-definition")).toContainText("동일한 풍황");
});

test("mobile controls, details and results fit the viewport", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("canvas")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("mobile-scene.png"), fullPage: true });
  await page.getByRole("button", { name: "조작", exact: true }).click();
  await expect(page.getByLabel("풍속", { exact: true })).toBeVisible();
  await page.getByLabel("풍속", { exact: true }).fill("0");
  await expect(page.getByLabel("시나리오 선택")).toBeEnabled();
  await page.getByRole("button", { name: "발전기 정보", exact: true }).click();
  await expect(page.locator(".detail-output")).toContainText("0.00");
  await page.screenshot({ path: testInfo.outputPath("mobile-details.png"), fullPage: true });
  await page.getByRole("button", { name: "3D 단지", exact: true }).click();
  await saved(page);
  expect((await scene(page)).particleVisible).toBe(false);
});

test("reverting a draft preserves results and an in-flight save locks conflicting actions", async ({ page }) => {
  const previous = await page.locator(".kpi-card--hero > strong").innerText();
  await page.getByLabel("풍속", { exact: true }).fill("12");
  await page.getByLabel("풍속", { exact: true }).fill("9.5");
  await saved(page);
  await expect(page.locator(".kpi-card--hero > strong")).toHaveText(previous);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/settings", async route => { await gate; await route.continue(); });
  try {
    await page.getByLabel("풍속", { exact: true }).fill("14");
    await expect(page.getByLabel("풍속", { exact: true })).toBeDisabled();
    await expect(page.getByLabel("시나리오 선택")).toBeDisabled();
    await expect(page.getByRole("button", { name: /강풍 상황/ })).toBeDisabled();
    await expect(page.locator(".kpi-card--hero > strong")).toContainText("—");
  } finally { release(); }
  await saved(page);
});

test("stalled API request times out with a recoverable draft", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  // The application aborts this request itself when its timeout elapses.
  await page.route("**/settings", async () => { await gate; });
  try {
    await page.getByLabel("풍속", { exact: true }).fill("10.2");
    await expect(page.getByRole("alert")).toContainText("응답 시간이 초과", { timeout: 20_000 });
    await expect(page.getByLabel("풍속", { exact: true })).toHaveValue("10.2");
    await expect(page.getByRole("button", { name: "다시 저장" })).toBeEnabled();
  } finally { release(); }
  await page.unroute("**/settings");
  await page.getByRole("button", { name: "다시 저장" }).click();
  await saved(page);
});

test("WebGL context loss keeps controls usable and scene can be reopened", async ({ page }) => {
  await page.evaluate(async () => {
    const modulePath = "/node_modules/.vite/deps/@react-three_fiber.js";
    const fiber = await import(modulePath) as typeof import("@react-three/fiber");
    fiber._roots.get(document.querySelector("canvas")!)!.store.getState().gl.getContext().getExtension("WEBGL_lose_context")!.loseContext();
  });
  await expect(page.getByTestId("farm-scene")).toHaveAttribute("data-render-state", "failed");
  await expect(page.locator(".table-select")).toHaveCount(12);
  await page.getByLabel("풍속", { exact: true }).fill("11");
  await saved(page);
  await page.getByRole("button", { name: "3D 다시 열기" }).click();
  await expect(page.getByTestId("farm-scene")).toHaveAttribute("data-render-state", "ready");
  expect((await scene(page)).drawCalls).toBeGreaterThan(0);
});
