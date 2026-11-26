import { test, expect } from "@playwright/test";
import { openIsolatedScenario } from "./test-helpers";

test("core simulation works without engine-specific errors", async ({ page, request }, testInfo) => {
  const runtimeErrors: string[] = [];
  page.on("pageerror", error => runtimeErrors.push(error.message));
  await openIsolatedScenario(page, request, testInfo);
  await expect(page.locator("canvas")).toBeVisible();
  await expect(page.locator(".table-select")).toHaveCount(12);
  await page.getByLabel("풍속", { exact: true }).fill("10.5");
  await expect(page.getByLabel("시나리오 선택")).toBeEnabled();
  await expect(page.locator(".summary-run-state")).toContainText("계산 완료");
  await expect(page.locator(".kpi-card--hero > strong")).not.toContainText("—");
  expect(runtimeErrors).toEqual([]);
});
