import type { SimulationResult, TurbineCommand, TurbineInput, TurbineResult, TurbineStatus } from "../shared/domain";

export type ProjectSummary = {
  id: string;
  name: string;
  description: string | null;
};

export type ScenarioSummary = {
  id: string;
  projectId: string;
  name: string;
  role: "baseline" | "experiment";
  windSpeedMps: number;
  windDirectionDeg: number;
  airDensityKgM3: number;
  createdAt: string;
  updatedAt: string;
};

export type FarmScenario = ScenarioSummary & { turbines: TurbineInput[] };

export type FarmProject = ProjectSummary & {
  createdAt: string;
  updatedAt: string;
  turbines: Array<Omit<TurbineInput, "xM" | "yM" | "command"> & { projectId: string; displayOrder: number }>;
  scenarios: ScenarioSummary[];
  baselineScenarioId: string | null;
};

export type SimulationRun = SimulationResult & {
  runId: string;
  inputHash: string;
  calculatedAt: string;
};

export type Comparison = {
  mode: "layout" | "scenario";
  conditionsDiffer: boolean;
  turbineDeltas: Array<{ turbineId: string; name: string; baselinePowerMW: number; experimentPowerMW: number; deltaPowerMW: number }>;
  baseline: { scenarioId: string; name: string; totalPowerMW: number; wakeLossMW: number; wakeLossPercent: number | null };
  experiment: { scenarioId: string; name: string; totalPowerMW: number; wakeLossMW: number; wakeLossPercent: number | null };
  deltaPowerMW: number;
  deltaPowerPercent: number | null;
  comparisonDefinition: string;
};

export type PlacementUpdate = {
  xM?: number;
  yM?: number;
  command?: TurbineCommand;
};

export type LayoutIssue = { turbineId: string; message: string; severity: "warning" | "error" };

export type TurbineDefinitionInput = {
  name: string;
  ratedPowerMW: number;
  rotorDiameterM: number;
  hubHeightM: number;
  cutInMps: number;
  ratedWindMps: number;
  cutOutMps: number;
  thrustCoefficient: number;
  wakeExpansion: number;
  powerCurve: TurbineInput["powerCurve"];
};

export type TurbineCreateInput = TurbineDefinitionInput & { xM: number; yM: number };

export type BaselinePromotion = {
  baselineScenarioId: string;
  experimentScenarioId: string;
  archivedScenarioId?: string;
};

export class ApiRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(15_000),
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers
      }
    });
  } catch (error) {
    if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new ApiRequestError("서버 응답 시간이 초과되었습니다. 입력값을 확인한 뒤 다시 시도해 주세요.", 0, "TIMEOUT");
    }
    throw new ApiRequestError("WindScope API에 연결할 수 없습니다. 서버가 실행 중인지 확인해 주세요.", 0, "NETWORK_ERROR");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (response.ok) throw new ApiRequestError("서버 응답을 끝까지 읽지 못했습니다. 잠시 후 다시 시도해 주세요.", response.status, "INVALID_RESPONSE");
    body = null;
  }
  if (!response.ok) {
    const payload = body as { error?: { message?: string; code?: string } } | null;
    throw new ApiRequestError(payload?.error?.message ?? "서버 요청에 실패했습니다.", response.status, payload?.error?.code);
  }
  if (!body || typeof body !== "object" || !("data" in body)) {
    throw new ApiRequestError("서버 응답 형식이 올바르지 않습니다. 다시 시도해 주세요.", response.status, "INVALID_RESPONSE");
  }
  return body as T;
}

type DataEnvelope<T> = { data: T };

export const api = {
  async getProjects() {
    return (await apiRequest<DataEnvelope<ProjectSummary[]>>("/projects")).data;
  },
  async getProject(projectId: string) {
    return (await apiRequest<DataEnvelope<FarmProject>>(`/projects/${encodeURIComponent(projectId)}`)).data;
  },
  async createProject(input: { name: string; description?: string }) {
    return (await apiRequest<DataEnvelope<FarmProject>>("/projects", {
      method: "POST",
      body: JSON.stringify(input)
    })).data;
  },
  async updateProject(projectId: string, input: { name?: string; description?: string | null }) {
    return (await apiRequest<DataEnvelope<FarmProject>>(`/projects/${encodeURIComponent(projectId)}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    })).data;
  },
  async deleteProject(projectId: string) {
    return (await apiRequest<DataEnvelope<{ deletedId: string; deletionPolicy: string }>>(`/projects/${encodeURIComponent(projectId)}`, {
      method: "DELETE"
    })).data;
  },
  async createTurbine(projectId: string, input: TurbineCreateInput) {
    return (await apiRequest<DataEnvelope<unknown>>(`/projects/${encodeURIComponent(projectId)}/turbines`, {
      method: "POST",
      body: JSON.stringify(input)
    })).data;
  },
  async updateTurbine(projectId: string, turbineId: string, input: Partial<TurbineDefinitionInput>) {
    return (await apiRequest<DataEnvelope<unknown>>(`/projects/${encodeURIComponent(projectId)}/turbines/${encodeURIComponent(turbineId)}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    })).data;
  },
  async deleteTurbine(projectId: string, turbineId: string) {
    return (await apiRequest<DataEnvelope<unknown>>(`/projects/${encodeURIComponent(projectId)}/turbines/${encodeURIComponent(turbineId)}`, {
      method: "DELETE"
    })).data;
  },
  async getScenario(scenarioId: string) {
    return (await apiRequest<DataEnvelope<FarmScenario>>(`/scenarios/${encodeURIComponent(scenarioId)}`)).data;
  },
  async updateSettings(scenarioId: string, settings: { windSpeedMps?: number; windDirectionDeg?: number; airDensityKgM3?: number }) {
    return (await apiRequest<DataEnvelope<FarmScenario>>(`/scenarios/${encodeURIComponent(scenarioId)}/settings`, {
      method: "PATCH",
      body: JSON.stringify(settings)
    })).data;
  },
  async updatePlacement(scenarioId: string, turbineId: string, update: PlacementUpdate) {
    return (await apiRequest<DataEnvelope<{ scenario: FarmScenario; layoutIssues: LayoutIssue[] }>>(
      `/scenarios/${encodeURIComponent(scenarioId)}/turbines/${encodeURIComponent(turbineId)}`,
      { method: "PUT", body: JSON.stringify(update) }
    )).data;
  },
  async simulate(scenarioId: string) {
    return (await apiRequest<DataEnvelope<SimulationRun>>(`/scenarios/${encodeURIComponent(scenarioId)}/simulate`, {
      method: "POST",
      body: JSON.stringify({})
    })).data;
  },
  async compare(scenarioId: string, baselineScenarioId: string, mode: "layout" | "scenario" = "layout") {
    return (await apiRequest<DataEnvelope<Comparison>>(
      `/scenarios/${encodeURIComponent(scenarioId)}/compare?against=${encodeURIComponent(baselineScenarioId)}&mode=${mode}`
    )).data;
  },
  async duplicate(scenarioId: string, name: string) {
    return (await apiRequest<DataEnvelope<FarmScenario>>(`/scenarios/${encodeURIComponent(scenarioId)}/duplicate`, {
      method: "POST",
      body: JSON.stringify({ name })
    })).data;
  },
  async rename(scenarioId: string, name: string) {
    return (await apiRequest<DataEnvelope<FarmScenario>>(`/scenarios/${encodeURIComponent(scenarioId)}`, {
      method: "PATCH",
      body: JSON.stringify({ name })
    })).data;
  },
  async deleteScenario(scenarioId: string) {
    return (await apiRequest<DataEnvelope<{ deletedId: string; deletionPolicy: string }>>(`/scenarios/${encodeURIComponent(scenarioId)}`, {
      method: "DELETE"
    })).data;
  },
  async promoteBaseline(scenarioId: string) {
    return (await apiRequest<DataEnvelope<BaselinePromotion>>(`/scenarios/${encodeURIComponent(scenarioId)}/promote-baseline`, {
      method: "POST",
      body: JSON.stringify({})
    })).data;
  },
  async resetLayout(scenarioId: string) {
    return (await apiRequest<DataEnvelope<FarmScenario>>(`/scenarios/${encodeURIComponent(scenarioId)}/reset-layout`, {
      method: "POST",
      body: JSON.stringify({})
    })).data;
  }
};

export function resultForTurbine(results: TurbineResult[] | undefined, turbineId: string): TurbineResult | undefined {
  return results?.find((result) => result.turbineId === turbineId);
}

export function statusLabel(status: TurbineStatus | undefined, command?: TurbineCommand): string {
  if (status === "manual_stop" || command === "manual_stop") return "수동 정지";
  if (status === "maintenance_stop" || command === "maintenance_stop") return "정비 정지";
  if (status === "low_wind") return "저풍속 대기";
  if (status === "high_wind") return "강풍 보호 정지";
  if (!status) return "계산 대기";
  return "정상 가동";
}

