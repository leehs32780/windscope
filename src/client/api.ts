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
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers
      }
    });
  } catch {
    throw new ApiRequestError("WindScope API에 연결할 수 없습니다. 서버가 실행 중인지 확인해 주세요.", 0, "NETWORK_ERROR");
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const payload = body as { error?: { message?: string; code?: string } } | null;
    throw new ApiRequestError(payload?.error?.message ?? "서버 요청에 실패했습니다.", response.status, payload?.error?.code);
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
  async compare(scenarioId: string, baselineScenarioId: string) {
    return (await apiRequest<DataEnvelope<Comparison>>(
      `/scenarios/${encodeURIComponent(scenarioId)}/compare?against=${encodeURIComponent(baselineScenarioId)}`
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
  return "정상 가동";
}

