import { test, expect } from "@playwright/test";
import { openIsolatedScenario } from "./test-helpers";

test("mobile navigation and details fit without page overflow", async ({ page, request }, testInfo) => {
  await openIsolatedScenario(page, request, testInfo);
  await expect(page.locator("canvas")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.getByRole("button", { name: "조작", exact: true }).click();
  await expect(page.getByLabel("풍속", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "발전기 정보", exact: true }).click();
  await expect(page.locator(".turbine-detail-card")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
