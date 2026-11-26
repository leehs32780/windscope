import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "@playwright/test";
import { openIsolatedScenario } from "./test-helpers";

test.beforeEach(async ({ page, request }, testInfo) => {
  await openIsolatedScenario(page, request, testInfo);
});

test("dashboard has no detectable WCAG A/AA violations", async ({ page }, testInfo) => {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  await testInfo.attach("axe-results", {
    body: JSON.stringify(results.violations, null, 2),
    contentType: "application/json"
  });
  expect(results.violations).toEqual([]);
});

test("primary workflow is reachable by keyboard", async ({ page }) => {
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("프로젝트 선택")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("시나리오 선택")).toBeFocused();
  await page.getByLabel("풍속", { exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".save-pill")).toHaveText("저장됨");
  await page.locator(".table-select").first().focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".turbine-detail-card h2")).toContainText("터빈 01");
  await expect(page.locator(".table-scroll")).toHaveAttribute("tabindex", "0");
});

test("management dialog passes WCAG checks and restores keyboard focus", async ({ page }, testInfo) => {
  const trigger = page.getByTitle("프로젝트와 터빈 관리");
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "프로젝트·터빈 관리" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("관리 창 닫기")).toBeFocused();

  const results = await new AxeBuilder({ page })
    .include(".management-dialog")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  await testInfo.attach("management-axe-results", {
    body: JSON.stringify(results.violations, null, 2),
    contentType: "application/json"
  });
  expect(results.violations).toEqual([]);

  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "사양 저장" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});
