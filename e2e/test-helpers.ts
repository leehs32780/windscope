import { expect, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";

export async function openIsolatedScenario(page: Page, request: APIRequestContext, testInfo: TestInfo) {
  const response = await request.post("/api/scenarios/north-sea-baseline/duplicate", {
    data: { name: `Cross ${testInfo.project.name} ${testInfo.testId.slice(-8)}` }
  });
  expect(response.ok()).toBeTruthy();
  const scenarioId = (await response.json()).data.id as string;
  await page.addInitScript((id) => {
    localStorage.setItem("windscope.selection", JSON.stringify({ projectId: "north-sea-demo", scenarioId: id }));
  }, scenarioId);
  await page.goto("/");
  await expect(page.getByLabel("시나리오 선택")).toBeEnabled();
  await expect(page.locator(".summary-run-state")).toContainText("계산 완료");
  return scenarioId;
}
