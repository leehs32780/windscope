import { expect, test } from "@playwright/test";

test("project, turbine and baseline management works from the dashboard", async ({ page, request }) => {
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto("/");
  await expect(page.getByLabel("프로젝트 선택")).toBeEnabled();

  await page.getByTitle("프로젝트와 터빈 관리").click();
  const dialog = page.getByRole("dialog", { name: "프로젝트·터빈 관리" });
  await expect(dialog).toBeVisible();

  const projectName = `관리 흐름 ${Date.now()}`;
  await dialog.getByLabel("프로젝트 이름", { exact: true }).fill(projectName);
  await dialog.getByLabel("설명", { exact: true }).fill("관리 UI 자동 검증 프로젝트");
  const createProjectResponse = page.waitForResponse((response) => response.request().method() === "POST" && /\/api\/projects$/.test(response.url()));
  await dialog.getByRole("button", { name: "프로젝트 만들기" }).click();
  const projectResponse = await createProjectResponse;
  expect(projectResponse.ok()).toBeTruthy();
  const projectId = (await projectResponse.json()).data.id as string;
  await expect(page.getByLabel("프로젝트 선택")).toHaveValue(projectId);

  const renamedProject = `${projectName} 개정`;
  await dialog.getByLabel("현재 프로젝트 이름").fill(renamedProject);
  await dialog.getByLabel("현재 설명").fill("수정된 프로젝트 설명");
  const updateProjectResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().endsWith(`/api/projects/${projectId}`));
  await dialog.getByRole("button", { name: "프로젝트 정보 저장" }).click();
  expect((await updateProjectResponse).ok()).toBeTruthy();
  await expect(page.getByLabel("프로젝트 선택").locator("option:checked")).toHaveText(renamedProject);

  const turbineForm = dialog.locator("form.turbine-spec-form");
  await expect(turbineForm).toBeVisible();
  await turbineForm.getByLabel("이름", { exact: true }).fill("검증 터빈 01");
  await turbineForm.getByLabel("컷인 풍속 (m/s)").fill("0");
  await turbineForm.getByLabel("정격 풍속 (m/s)").fill("1");
  await turbineForm.getByLabel("컷아웃 풍속 (m/s)").fill("5");
  await turbineForm.getByRole("button", { name: "현재 사양으로 예시 곡선 생성" }).click();
  const createTurbineResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith(`/api/projects/${projectId}/turbines`));
  await turbineForm.getByRole("button", { name: "터빈 추가", exact: true }).click();
  expect((await createTurbineResponse).ok()).toBeTruthy();

  await dialog.getByLabel("관리 창 닫기").click();
  await expect(page.locator("canvas")).toBeVisible();
  await expect(page.locator(".table-select")).toHaveCount(1);

  const duplicateResponse = page.waitForResponse((response) => response.request().method() === "POST" && /\/api\/scenarios\/[^/]+\/duplicate$/.test(response.url()));
  await page.getByTitle("현재 시나리오 복제").click();
  const experimentId = (await (await duplicateResponse).json()).data.id as string;
  await expect(page.getByLabel("시나리오 선택")).toHaveValue(experimentId);

  await page.getByTitle("프로젝트와 터빈 관리").click();
  await dialog.getByRole("button", { name: "현재 실험을 기준으로 지정" }).click();
  await expect(page.getByText("새 기준을 지정하고 편집 가능한 실험을 준비했습니다.")).toBeVisible();

  const deleteTurbineResponse = page.waitForResponse((response) => response.request().method() === "DELETE" && response.url().includes(`/api/projects/${projectId}/turbines/`));
  await dialog.getByRole("button", { name: "터빈 삭제", exact: true }).click();
  expect((await deleteTurbineResponse).ok()).toBeTruthy();
  await dialog.getByLabel("관리 창 닫기").click();
  await expect(page.locator(".empty-farm")).toBeVisible();

  await page.getByTitle("프로젝트와 터빈 관리").click();
  const deleteProjectResponse = page.waitForResponse((response) => response.request().method() === "DELETE" && response.url().endsWith(`/api/projects/${projectId}`));
  await dialog.getByRole("button", { name: "프로젝트 삭제", exact: true }).click();
  expect((await deleteProjectResponse).ok()).toBeTruthy();
  await expect(page.getByLabel("프로젝트 선택")).not.toHaveValue(projectId);
  expect((await request.get(`/api/projects/${projectId}`)).status()).toBe(404);
});
