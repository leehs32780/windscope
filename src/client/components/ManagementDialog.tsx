import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { AlertTriangle, Plus, Save, Settings, Trash2, X } from "lucide-react";
import type { PowerCurvePoint, TurbineInput } from "../../shared/domain";
import { turbineInputSchema } from "../../shared/validation";
import { api, type FarmProject, type FarmScenario, type TurbineCreateInput, type TurbineDefinitionInput } from "../api";

type Props = {
  open: boolean;
  project: FarmProject | null;
  scenario: FarmScenario | null;
  onClose: () => void;
  onChanged: (projectId?: string, scenarioId?: string, notice?: string) => Promise<void>;
};

type TurbineDraft = TurbineDefinitionInput & { xM: number; yM: number; powerCurveText: string };
type NumericTurbineDraftField = "xM" | "yM" | "ratedPowerMW" | "rotorDiameterM" | "hubHeightM" | "cutInMps" | "ratedWindMps" | "cutOutMps" | "thrustCoefficient" | "wakeExpansion";
type DirtyAreas = { newProject: boolean; currentProject: boolean; turbine: boolean };

const cleanDirtyAreas: DirtyAreas = { newProject: false, currentProject: false, turbine: false };

function curveFor(ratedPowerMW: number, cutInMps: number, ratedWindMps: number, cutOutMps: number): PowerCurvePoint[] {
  const points: PowerCurvePoint[] = [{ windSpeedMps: 0, powerMW: 0 }];
  if (cutInMps > 0) points.push({ windSpeedMps: cutInMps, powerMW: 0 });
  points.push(
    { windSpeedMps: (cutInMps + ratedWindMps) / 2, powerMW: ratedPowerMW * 0.25 },
    { windSpeedMps: ratedWindMps, powerMW: ratedPowerMW },
    { windSpeedMps: (ratedWindMps + cutOutMps) / 2, powerMW: ratedPowerMW },
    { windSpeedMps: cutOutMps, powerMW: 0 }
  );
  return points;
}

function newTurbineDraft(index: number): TurbineDraft {
  const base = {
    name: `터빈 ${String(index + 1).padStart(2, "0")}`,
    xM: (index % 4) * 700,
    yM: Math.floor(index / 4) * 900,
    ratedPowerMW: 8,
    rotorDiameterM: 160,
    hubHeightM: 105,
    cutInMps: 3,
    ratedWindMps: 12,
    cutOutMps: 25,
    thrustCoefficient: 0.8,
    wakeExpansion: 0.05,
    powerCurve: [] as PowerCurvePoint[]
  };
  const powerCurve = curveFor(base.ratedPowerMW, base.cutInMps, base.ratedWindMps, base.cutOutMps);
  return { ...base, powerCurve, powerCurveText: JSON.stringify(powerCurve, null, 2) };
}

function editDraft(turbine: TurbineInput): TurbineDraft {
  return { ...turbine, powerCurveText: JSON.stringify(turbine.powerCurve, null, 2) };
}

function numberValue(value: string): number {
  return value.trim() === "" ? Number.NaN : Number(value);
}

export function ManagementDialog({ open, project, scenario, onClose, onChanged }: Props) {
  const dialog = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(false);
  const [projectName, setProjectName] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [currentProjectName, setCurrentProjectName] = useState("");
  const [currentProjectDescription, setCurrentProjectDescription] = useState("");
  const [selectedTurbineId, setSelectedTurbineId] = useState("");
  const [creatingTurbine, setCreatingTurbine] = useState(false);
  const [draft, setDraft] = useState<TurbineDraft>(() => newTurbineDraft(0));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dirtyAreas, setDirtyAreas] = useState<DirtyAreas>(cleanDirtyAreas);
  const dirtyRef = useRef(false);
  const dirty = dirtyAreas.newProject || dirtyAreas.currentProject || dirtyAreas.turbine;

  const selectedTurbine = useMemo(
    () => scenario?.turbines.find((turbine) => turbine.id === selectedTurbineId) ?? null,
    [scenario, selectedTurbineId]
  );

  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    setProjectName("");
    setProjectDescription("");
    setCurrentProjectName(project?.name ?? "");
    setCurrentProjectDescription(project?.description ?? "");
    setDirtyAreas(cleanDirtyAreas);
    dirtyRef.current = false;
    closeButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) {
        if (!dirtyRef.current || window.confirm("저장하지 않은 프로젝트 또는 터빈 입력을 버리고 닫을까요?")) onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialog.current) return;
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus.current?.focus();
    };
  }, [open]);

  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  useEffect(() => { busyRef.current = busy; }, [busy]);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    setCurrentProjectName(project?.name ?? "");
    setCurrentProjectDescription(project?.description ?? "");
    setDirtyAreas((current) => ({ ...current, currentProject: false }));
  }, [project?.id, project?.name, project?.description]);

  useEffect(() => {
    const first = scenario?.turbines[0];
    if (first) {
      setSelectedTurbineId(first.id);
      setCreatingTurbine(false);
      setDraft(editDraft(first));
    } else {
      setSelectedTurbineId("");
      setCreatingTurbine(true);
      setDraft(newTurbineDraft(0));
    }
    setDirtyAreas((current) => ({ ...current, turbine: false }));
  }, [project?.id, scenario?.id, scenario?.updatedAt, scenario?.turbines]);

  useEffect(() => {
    if (selectedTurbine && !creatingTurbine) setDraft(editDraft(selectedTurbine));
  }, [selectedTurbine, creatingTurbine]);

  if (!open) return null;

  function closeDialog() {
    if (busy) return;
    if (dirty && !window.confirm("저장하지 않은 프로젝트 또는 터빈 입력을 버리고 닫을까요?")) return;
    setDirtyAreas(cleanDirtyAreas);
    onClose();
  }

  function selectTurbine(turbineId: string) {
    if (dirtyAreas.turbine && !window.confirm("저장하지 않은 터빈 사양을 버리고 다른 터빈을 열까요?")) return;
    setSelectedTurbineId(turbineId);
    setDirtyAreas((current) => ({ ...current, turbine: false }));
  }

  function markDirty(area: keyof DirtyAreas) {
    setDirtyAreas((current) => ({ ...current, [area]: true }));
  }

  function setNumber(field: NumericTurbineDraftField, value: string) {
    setDraft((current) => ({ ...current, [field]: numberValue(value) }));
  }

  async function perform(operation: () => Promise<void>) {
    setBusy(true);
    setError("");
    try { await operation(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "요청을 처리하지 못했습니다."); }
    finally { setBusy(false); }
  }

  async function createProject(event: FormEvent) {
    event.preventDefault();
    if (!projectName.trim()) return;
    if ((dirtyAreas.currentProject || dirtyAreas.turbine) && !window.confirm("현재 프로젝트 또는 터빈의 저장하지 않은 입력을 버리고 새 프로젝트로 이동할까요?")) return;
    await perform(async () => {
      const created = await api.createProject({ name: projectName.trim(), description: projectDescription.trim() || undefined });
      setProjectName("");
      setProjectDescription("");
      setDirtyAreas(cleanDirtyAreas);
      await onChanged(created.id, created.scenarios.find((item) => item.role === "experiment")?.id, `“${created.name}” 프로젝트를 만들었습니다.`);
    });
  }

  async function updateCurrentProject(event: FormEvent) {
    event.preventDefault();
    if (!project || !currentProjectName.trim()) return;
    if (dirtyAreas.turbine && !window.confirm("저장하지 않은 터빈 사양을 버리고 프로젝트 정보를 저장할까요?")) return;
    await perform(async () => {
      await api.updateProject(project.id, {
        name: currentProjectName.trim(),
        description: currentProjectDescription.trim() || null
      });
      setDirtyAreas((current) => ({ ...current, currentProject: false, turbine: false }));
      await onChanged(project.id, scenario?.id, "프로젝트 정보를 저장했습니다.");
    });
  }

  async function saveTurbine(event: FormEvent) {
    event.preventDefault();
    if (!project) return;
    await perform(async () => {
      let powerCurve: PowerCurvePoint[];
      try {
        const parsed: unknown = JSON.parse(draft.powerCurveText);
        if (!Array.isArray(parsed)) throw new Error();
        powerCurve = parsed as PowerCurvePoint[];
      } catch {
        throw new Error("출력 곡선은 [{\"windSpeedMps\": 3, \"powerMW\": 0}] 형태의 JSON 배열이어야 합니다.");
      }
      const specification: TurbineDefinitionInput = {
        name: draft.name.trim(),
        ratedPowerMW: draft.ratedPowerMW,
        rotorDiameterM: draft.rotorDiameterM,
        hubHeightM: draft.hubHeightM,
        cutInMps: draft.cutInMps,
        ratedWindMps: draft.ratedWindMps,
        cutOutMps: draft.cutOutMps,
        thrustCoefficient: draft.thrustCoefficient,
        wakeExpansion: draft.wakeExpansion,
        powerCurve
      };
      if (!specification.name) throw new Error("터빈 이름을 입력해 주세요.");
      const candidate = turbineInputSchema.safeParse({
        ...specification,
        id: selectedTurbine?.id ?? "new-turbine",
        xM: creatingTurbine ? draft.xM : selectedTurbine?.xM ?? 0,
        yM: creatingTurbine ? draft.yM : selectedTurbine?.yM ?? 0,
        command: selectedTurbine?.command ?? "operational"
      });
      if (!candidate.success) throw new Error(candidate.error.issues[0]?.message ?? "터빈 사양을 확인해 주세요.");
      if (creatingTurbine) {
        const payload: TurbineCreateInput = { ...specification, xM: draft.xM, yM: draft.yM };
        await api.createTurbine(project.id, payload);
      } else if (selectedTurbine) await api.updateTurbine(project.id, selectedTurbine.id, specification);
      await onChanged(project.id, scenario?.id, creatingTurbine ? "터빈을 추가했습니다." : "터빈 사양을 저장했습니다.");
      setCreatingTurbine(false);
      setDirtyAreas((current) => ({ ...current, turbine: false }));
    });
  }

  function regenerateCurve() {
    const powerCurve = curveFor(draft.ratedPowerMW, draft.cutInMps, draft.ratedWindMps, draft.cutOutMps);
    setDraft((current) => ({ ...current, powerCurve, powerCurveText: JSON.stringify(powerCurve, null, 2) }));
    markDirty("turbine");
  }

  return (
    <div className="management-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDialog(); }}>
      <section ref={dialog} className="management-dialog" role="dialog" aria-modal="true" aria-labelledby="management-title">
        <header className="management-dialog__header">
          <div><span className="eyebrow">PROJECT ADMINISTRATION</span><h2 id="management-title"><Settings size={18} /> 프로젝트·터빈 관리</h2></div>
          <button ref={closeButton} type="button" className="icon-button" aria-label="관리 창 닫기" onClick={closeDialog} disabled={busy}><X size={17} /></button>
        </header>
        {error && <div className="inline-warning" role="alert"><AlertTriangle size={15} />{error}</div>}

        <div className="management-grid">
          <section className="management-section" aria-labelledby="new-project-heading">
            <h3 id="new-project-heading">새 프로젝트</h3>
            <form onSubmit={(event) => void createProject(event)} onInput={() => markDirty("newProject")}>
              <label>프로젝트 이름<input value={projectName} maxLength={120} required onChange={(event) => setProjectName(event.target.value)} /></label>
              <label>설명<textarea value={projectDescription} maxLength={1000} rows={3} onChange={(event) => setProjectDescription(event.target.value)} /></label>
              <button className="button button--primary button--full" type="submit" disabled={busy || !projectName.trim()}><Plus size={15} /> 프로젝트 만들기</button>
            </form>
            {project && <div className="current-project-editor">
              <h4>현재 프로젝트 정보</h4>
              <form onSubmit={(event) => void updateCurrentProject(event)} onInput={() => markDirty("currentProject")}>
                <label>현재 프로젝트 이름<input value={currentProjectName} maxLength={120} required onChange={(event) => setCurrentProjectName(event.target.value)} /></label>
                <label>현재 설명<textarea value={currentProjectDescription} maxLength={1000} rows={3} onChange={(event) => setCurrentProjectDescription(event.target.value)} /></label>
                <button className="button button--outline button--full" type="submit" disabled={busy || !currentProjectName.trim()}><Save size={14} /> 프로젝트 정보 저장</button>
              </form>
            </div>}
            {project && <div className="danger-zone">
              <strong>현재 프로젝트 삭제</strong>
              <p>모든 시나리오, 터빈과 계산 결과가 함께 삭제됩니다.</p>
              <button type="button" className="button button--danger" disabled={busy} onClick={() => {
                if (!window.confirm(`“${project.name}” 프로젝트와 모든 데이터를 삭제할까요? 이 작업은 되돌릴 수 없습니다.`)) return;
                void perform(async () => { await api.deleteProject(project.id); await onChanged(undefined, undefined, "프로젝트를 삭제했습니다."); });
              }}><Trash2 size={14} /> 프로젝트 삭제</button>
            </div>}
          </section>

          <section className="management-section" aria-labelledby="scenario-admin-heading">
            <h3 id="scenario-admin-heading">현재 시나리오</h3>
            {scenario ? <>
              <p><strong>{scenario.name}</strong><br />{scenario.role === "baseline" ? "읽기 전용 기준" : "편집 가능한 실험"}</p>
              {scenario.role === "experiment" && <div className="management-actions">
                <button type="button" className="button button--outline" disabled={busy} onClick={() => {
                  if (dirtyAreas.turbine && !window.confirm("저장하지 않은 터빈 사양을 버리고 기준 시나리오를 변경할까요?")) return;
                  if (!window.confirm("현재 실험을 새 기준 배치로 지정할까요? 기존 기준은 보존용 실험으로 보관됩니다.")) return;
                  void perform(async () => {
                    const promoted = await api.promoteBaseline(scenario.id);
                    await onChanged(project?.id, promoted.experimentScenarioId, "새 기준을 지정하고 편집 가능한 실험을 준비했습니다.");
                  });
                }}>현재 실험을 기준으로 지정</button>
                <button type="button" className="button button--danger" disabled={busy} onClick={() => {
                  if (dirtyAreas.turbine && !window.confirm("저장하지 않은 터빈 사양을 버리고 현재 실험을 삭제할까요?")) return;
                  if (!window.confirm(`“${scenario.name}” 실험을 삭제할까요? 저장된 계산 결과도 함께 삭제됩니다.`)) return;
                  void perform(async () => { await api.deleteScenario(scenario.id); await onChanged(project?.id, undefined, "실험 시나리오를 삭제했습니다."); });
                }}><Trash2 size={14} /> 실험 삭제</button>
              </div>}
            </> : <p>선택된 시나리오가 없습니다.</p>}
          </section>

          <section className="management-section management-section--wide" aria-labelledby="turbine-admin-heading">
            <div className="management-section__heading">
              <div><h3 id="turbine-admin-heading">터빈 사양과 출력 곡선</h3><p>사용자·제조사 제공 값을 입력할 수 있습니다. 저장 전 단위와 곡선 범위를 검증합니다.</p></div>
              <button type="button" className="button button--outline" disabled={!project || busy} onClick={() => { if (dirtyAreas.turbine && !window.confirm("저장하지 않은 터빈 사양을 버리고 새 터빈을 추가할까요?")) return; setCreatingTurbine(true); setSelectedTurbineId(""); setDraft(newTurbineDraft(scenario?.turbines.length ?? 0)); setDirtyAreas((current) => ({ ...current, turbine: false })); }}><Plus size={14} /> 터빈 추가</button>
            </div>
            {!project ? <p>먼저 프로젝트를 만들어 주세요.</p> : <form className="turbine-spec-form" onSubmit={(event) => void saveTurbine(event)} onInput={() => markDirty("turbine")}>
              {!creatingTurbine && <label className="field-span-2">편집할 터빈<select value={selectedTurbineId} onChange={(event) => selectTurbine(event.target.value)}>{scenario?.turbines.map((turbine) => <option key={turbine.id} value={turbine.id}>{turbine.name}</option>)}</select></label>}
              <label>이름<input required maxLength={120} value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></label>
              <label>정격 출력 (MW)<input type="number" required min={0.1} max={50} step="any" value={draft.ratedPowerMW} onChange={(event) => setNumber("ratedPowerMW", event.target.value)} /></label>
              {creatingTurbine && <><label>X · 동쪽 + (m)<input type="number" required min={-10000} max={10000} step="any" value={draft.xM} onChange={(event) => setNumber("xM", event.target.value)} /></label><label>Y · 북쪽 + (m)<input type="number" required min={-10000} max={10000} step="any" value={draft.yM} onChange={(event) => setNumber("yM", event.target.value)} /></label></>}
              <label>로터 직경 (m)<input type="number" required min={20} max={300} step="any" value={draft.rotorDiameterM} onChange={(event) => setNumber("rotorDiameterM", event.target.value)} /></label>
              <label>허브 높이 (m)<input type="number" required min={20} max={300} step="any" value={draft.hubHeightM} onChange={(event) => setNumber("hubHeightM", event.target.value)} /></label>
              <label>컷인 풍속 (m/s)<input type="number" required min={0} max={25} step="any" value={draft.cutInMps} onChange={(event) => setNumber("cutInMps", event.target.value)} /></label>
              <label>정격 풍속 (m/s)<input type="number" required min={1} max={35} step="any" value={draft.ratedWindMps} onChange={(event) => setNumber("ratedWindMps", event.target.value)} /></label>
              <label>컷아웃 풍속 (m/s)<input type="number" required min={5} max={50} step="any" value={draft.cutOutMps} onChange={(event) => setNumber("cutOutMps", event.target.value)} /></label>
              <label>추력계수 Ct<input type="number" required min={0} max={0.99} step={0.01} value={draft.thrustCoefficient} onChange={(event) => setNumber("thrustCoefficient", event.target.value)} /></label>
              <label>후류 확장계수 k<input type="number" required min={0} max={0.3} step={0.005} value={draft.wakeExpansion} onChange={(event) => setNumber("wakeExpansion", event.target.value)} /></label>
              <label className="field-span-2">출력 곡선 JSON<textarea rows={9} spellCheck={false} value={draft.powerCurveText} onChange={(event) => setDraft((current) => ({ ...current, powerCurveText: event.target.value }))} /><small>각 점은 windSpeedMps와 powerMW를 가집니다. 컷인 0 MW, 정격 출력, 컷아웃 0 MW 점이 필요합니다.</small></label>
              <div className="field-span-2 turbine-form-actions">
                <button type="button" className="button button--quiet" onClick={regenerateCurve} disabled={busy}>현재 사양으로 예시 곡선 생성</button>
                {!creatingTurbine && selectedTurbine && <button type="button" className="button button--danger" disabled={busy} onClick={() => {
                  if (!window.confirm(`“${selectedTurbine.name}” 터빈을 모든 시나리오에서 삭제할까요?`)) return;
                  void perform(async () => { await api.deleteTurbine(project.id, selectedTurbine.id); await onChanged(project.id, scenario?.id, "터빈을 삭제했습니다."); });
                }}><Trash2 size={14} /> 터빈 삭제</button>}
                <button type="submit" className="button button--primary" disabled={busy}><Save size={14} /> {creatingTurbine ? "터빈 추가" : "사양 저장"}</button>
              </div>
            </form>}
          </section>
        </div>
      </section>
    </div>
  );
}
