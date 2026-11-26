import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleHelp,
  Compass,
  Copy,
  Gauge,
  MapPin,
  Move,
  RotateCcw,
  Save,
  Waves,
  Wind,
  Zap
} from "lucide-react";
import { api, resultForTurbine, statusLabel, type Comparison, type FarmProject, type FarmScenario, type ProjectSummary, type SimulationRun } from "./api";
import { validateLayout, type TurbineCommand, type TurbineInput } from "../shared/domain";
import "./styles.css";

type WindDraft = { windSpeedMps: number; windDirectionDeg: number; airDensityKgM3: number };
type PlacementSnapshot = { turbineId: string; xM: number; yM: number };
type MobilePanel = "controls" | "scene" | "details";

const FarmScene = lazy(async () => ({ default: (await import("./components/FarmScene")).FarmScene }));

const directionPresets = [
  { label: "북풍", degrees: 0 },
  { label: "동풍", degrees: 90 },
  { label: "남풍", degrees: 180 },
  { label: "서풍", degrees: 270 }
];

const experimentPresets = [
  { id: "stop", title: "터빈 1대 정지", description: "현재 시나리오를 복제하고 한 대를 수동 정지합니다.", Icon: ArrowDown },
  { id: "gale", title: "강풍 상황", description: "복제한 실험의 풍속을 28 m/s로 설정합니다.", Icon: Wind },
  { id: "direction", title: "풍향 90° 변경", description: "동풍 조건의 후류 정렬을 살펴봅니다.", Icon: Compass }
] as const;

function formatMw(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : value.toFixed(digits);
}

function formatSigned(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function parseNumber(value: string, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function compactTime(): string {
  return new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit" }).format(new Date());
}

function statusClass(status: string | undefined, command?: TurbineCommand): string {
  if (command === "manual_stop" || command === "maintenance_stop" || status === "manual_stop" || status === "maintenance_stop") return "state state--stopped";
  if (status === "high_wind" || status === "low_wind") return "state state--waiting";
  return "state state--operating";
}

function isScenarioEditable(scenario: FarmScenario | null): boolean {
  return scenario?.role === "experiment";
}

function WindCompass({ direction, onChange, disabled }: { direction: number; onChange: (degrees: number) => void; disabled: boolean }) {
  function pickDirection(event: React.MouseEvent<HTMLButtonElement>) {
    if (disabled) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const dx = event.clientX - bounds.left - bounds.width / 2;
    const dy = event.clientY - bounds.top - bounds.height / 2;
    onChange(Math.round((Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360));
  }

  function nudge(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      event.preventDefault();
      onChange((direction + 359) % 360);
    } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      event.preventDefault();
      onChange((direction + 1) % 360);
    }
  }

  return (
    <button
      type="button"
      className="compass-dial"
      onClick={pickDirection}
      onKeyDown={nudge}
      disabled={disabled}
      role="slider"
      aria-label="풍향 다이얼"
      aria-valuemin={0}
      aria-valuemax={359}
      aria-valuenow={Math.round(direction)}
      aria-valuetext={`${Math.round(direction)}도, 바람이 불어오는 방향`}
      title="다이얼을 눌러 풍향을 정하거나 방향키로 1도씩 조절하세요."
    >
      <span className="compass-dial__north">N</span>
      <span className="compass-dial__east">E</span>
      <span className="compass-dial__south">S</span>
      <span className="compass-dial__west">W</span>
      <span className="compass-dial__ring" />
      <span className="compass-dial__needle" style={{ transform: `rotate(${direction}deg)` }}>
        <i />
      </span>
      <span className="compass-dial__center"><Wind size={15} /></span>
    </button>
  );
}

function WindControls({
  draft,
  disabled,
  onChange,
  onPreset,
  onResetLayout,
  onToggleEdit,
  editMode,
  onScenarioDuplicate,
  onApplyPreset,
  scenario,
  busy
}: {
  draft: WindDraft;
  disabled: boolean;
  onChange: (change: Partial<WindDraft>) => void;
  onPreset: (degrees: number) => void;
  onResetLayout: () => void;
  onToggleEdit: () => void;
  editMode: boolean;
  onScenarioDuplicate: () => void;
  onApplyPreset: (presetId: string) => void;
  scenario: FarmScenario | null;
  busy: boolean;
}) {
  const locked = disabled || scenario?.role !== "experiment";
  return (
    <div className="control-stack">
      <section className="panel-section">
        <div className="section-title-row">
          <div className="section-icon"><Wind size={17} /></div>
          <div><h2>바람 조건</h2><p>변경 후 자동 저장 · 재계산</p></div>
          <span className="section-index">01</span>
        </div>
        <div className="control-block">
          <div className="field-heading">
            <label htmlFor="wind-speed">풍속</label>
            <div className="unit-input"><input id="wind-speed" type="number" min={0} max={35} step={0.1} value={draft.windSpeedMps} disabled={locked} onChange={(event) => onChange({ windSpeedMps: parseNumber(event.target.value, draft.windSpeedMps, 0, 35) })} /><span>m/s</span></div>
          </div>
          <input className="range-input range-input--wind" type="range" min={0} max={35} step={0.1} value={draft.windSpeedMps} disabled={locked} aria-label="풍속 m/s" onChange={(event) => onChange({ windSpeedMps: Number(event.target.value) })} />
          <div className="range-labels"><span>0 m/s</span><span>35 m/s</span></div>
          <div className="speed-zones"><span>저풍속</span><span>발전 구간</span><span>강풍 정지</span></div>
        </div>
        <div className="control-divider" />
        <div className="control-block">
          <div className="field-heading">
            <label htmlFor="wind-direction">풍향</label>
            <div className="unit-input unit-input--direction"><input id="wind-direction" type="number" min={0} max={359} step={1} value={Math.round(draft.windDirectionDeg)} disabled={locked} onChange={(event) => onChange({ windDirectionDeg: parseNumber(event.target.value, draft.windDirectionDeg, 0, 359) })} /><span>°</span></div>
          </div>
          <div className="compass-control">
            <WindCompass direction={draft.windDirectionDeg} onChange={onPreset} disabled={locked} />
            <div className="compass-note">
              <strong>{directionPresets.find((preset) => preset.degrees === Math.round(draft.windDirectionDeg))?.label ?? "사용자 풍향"}</strong>
              <span>북쪽 0° · 시계 방향</span>
              <small>풍향은 바람이 불어오는 쪽입니다.</small>
            </div>
          </div>
          <div className="direction-presets">
            {directionPresets.map((preset) => <button type="button" key={preset.degrees} disabled={locked} className={Math.round(draft.windDirectionDeg) === preset.degrees ? "is-active" : ""} onClick={() => onPreset(preset.degrees)}>{preset.label}</button>)}
          </div>
        </div>
        <div className="control-divider" />
        <div className="control-block">
          <div className="field-heading">
            <label htmlFor="air-density">공기 밀도</label>
            <div className="unit-input"><input id="air-density" type="number" min={0.5} max={2} step={0.005} value={draft.airDensityKgM3} disabled={locked} onChange={(event) => onChange({ airDensityKgM3: parseNumber(event.target.value, draft.airDensityKgM3, 0.5, 2) })} /><span>kg/m³</span></div>
          </div>
          <input className="range-input range-input--density" type="range" min={0.5} max={2} step={0.005} value={draft.airDensityKgM3} disabled={locked} aria-label="공기 밀도 kg/m³" onChange={(event) => onChange({ airDensityKgM3: Number(event.target.value) })} />
          <div className="range-labels"><span>0.5</span><span>표준 1.225</span><span>2.0</span></div>
        </div>
        {scenario?.role === "baseline" && <div className="locked-note"><AlertTriangle size={15} /> 기준 시나리오는 읽기 전용입니다. 상단에서 복제해 실험하세요.</div>}
      </section>

      <section className="panel-section panel-section--compact">
        <div className="section-title-row">
          <div className="section-icon section-icon--placement"><MapPin size={17} /></div>
          <div><h2>배치 편집</h2><p>좌표 단위 m · 수평면 이동</p></div>
        </div>
        <div className="layout-actions">
          <button type="button" className={editMode ? "button button--primary" : "button button--quiet"} disabled={locked} onClick={onToggleEdit} aria-pressed={editMode}>
            <Move size={16} /> {editMode ? "편집 모드 켜짐" : "편집 모드"}
          </button>
          <button type="button" className="button button--quiet" disabled={locked || busy} onClick={onResetLayout} title="현재 실험 배치를 기준 배치 좌표로 복원합니다.">
            <RotateCcw size={15} /> 기준 배치 복원
          </button>
        </div>
        <p className="helper-copy">편집 모드에서는 카메라 회전이 잠깁니다. 발전기를 끌어 옮기면 놓을 때 저장됩니다.</p>
      </section>

      <section className="panel-section panel-section--scenario">
        <div className="section-title-row">
          <div className="section-icon section-icon--scenario"><Zap size={16} /></div>
          <div><h2>빠른 실험</h2><p>현재 시나리오를 복제해서 적용</p></div>
        </div>
        <div className="preset-list">
          {experimentPresets.map(({ id, title, description, Icon }) => (
            <button type="button" className="preset-card" key={id} onClick={() => onApplyPreset(id)} disabled={!scenario || busy}>
              <span className="preset-card__icon"><Icon size={16} /></span>
              <span className="preset-card__text"><strong>{title}</strong><small>{description}</small></span>
              <ChevronDown className="preset-card__arrow" size={14} />
            </button>
          ))}
        </div>
        <button type="button" className="button button--outline button--full" onClick={onScenarioDuplicate} disabled={!scenario || busy}>
          <Copy size={15} /> 현재 시나리오 복제
        </button>
      </section>

      <section className="assumption-card">
        <div className="assumption-card__title"><CircleHelp size={15} /><strong>모델 안내</strong></div>
        <p>Jensen형 확장 후류와 원 겹침 근사를 쓴 교육용 추정치입니다. 정지 터빈은 후류를 만들지 않는 것으로 단순화했습니다.</p>
        <span>제조사 곡선·현장 풍황 검증용이 아닙니다.</span>
      </section>
    </div>
  );
}

function TurbineDetail({
  turbine,
  result,
  scenario,
  busy,
  lastPlacement,
  placementWarning,
  onSavePosition,
  onCommand,
  onUndo
}: {
  turbine: TurbineInput | null;
  result: ReturnType<typeof resultForTurbine>;
  scenario: FarmScenario | null;
  busy: boolean;
  lastPlacement: PlacementSnapshot | null;
  placementWarning: string;
  onSavePosition: (position: { xM: number; yM: number }) => void;
  onCommand: (command: TurbineCommand) => void;
  onUndo: () => void;
}) {
  const [xText, setXText] = useState("");
  const [yText, setYText] = useState("");
  const editable = scenario?.role === "experiment";
  useEffect(() => {
    setXText(turbine ? String(Math.round(turbine.xM)) : "");
    setYText(turbine ? String(Math.round(turbine.yM)) : "");
  }, [turbine?.id, turbine?.xM, turbine?.yM]);

  if (!turbine) {
    return <section className="panel-section empty-detail"><div className="empty-detail__icon"><MapPin size={20} /></div><h2>발전기를 선택하세요</h2><p>3D 장면이나 아래 표에서 발전기를 누르면 상태와 예상 출력을 확인할 수 있습니다.</p></section>;
  }
  const resultStatus = result?.status;
  const outputPercent = result ? Math.min(100, Math.max(0, result.powerMW / turbine.ratedPowerMW * 100)) : 0;

  function submitPosition(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const xM = Number(xText);
    const yM = Number(yText);
    if (Number.isFinite(xM) && Number.isFinite(yM)) onSavePosition({ xM, yM });
  }

  return (
    <div className="detail-stack">
      <section className="panel-section turbine-detail-card">
        <div className="detail-title-row">
          <div><span className="eyebrow">SELECTED TURBINE</span><h2>{turbine.name}</h2></div>
          <span className={statusClass(resultStatus, turbine.command)}><i />{statusLabel(resultStatus, turbine.command)}</span>
        </div>
        <div className="detail-output">
          <div><span>예상 출력</span><strong>{formatMw(result?.powerMW)}<small> MW</small></strong></div>
          <div className="detail-output__rated"><span>정격 용량</span><strong>{turbine.ratedPowerMW.toFixed(1)} MW</strong></div>
        </div>
        <div className="output-progress"><i style={{ width: `${outputPercent}%` }} /></div>
        <div className="output-percent"><span>정격 대비</span><strong>{result ? `${outputPercent.toFixed(1)}%` : "계산 대기"}</strong></div>
        <div className="detail-metrics">
          <div><span>유효 풍속</span><strong>{result ? `${result.effectiveWindMps.toFixed(2)} m/s` : "—"}</strong></div>
          <div><span>후류 감속</span><strong>{result ? `${result.wakeDeficitMps.toFixed(2)} m/s` : "—"}</strong></div>
          <div><span>로터 직경</span><strong>{turbine.rotorDiameterM.toFixed(0)} m</strong></div>
          <div><span>허브 높이</span><strong>{turbine.hubHeightM.toFixed(0)} m</strong></div>
        </div>
        {result?.upstreamTurbineIds.length ? (
          <div className="wake-impact"><span>영향을 준 상류 터빈</span><strong>{result.upstreamTurbineIds.length}대</strong><small>{result.upstreamTurbineIds.join(" · ")}</small></div>
        ) : <div className="wake-impact wake-impact--clear"><span>상류 후류 영향</span><strong>뚜렷한 영향 없음</strong></div>}
      </section>

      <section className="panel-section panel-section--compact">
        <div className="section-title-row">
          <div className="section-icon section-icon--placement"><MapPin size={17} /></div>
          <div><h2>위치와 운전 상태</h2><p>선택 시나리오에만 반영됩니다.</p></div>
        </div>
        <label className="form-label" htmlFor="turbine-command">운전 명령</label>
        <select id="turbine-command" className="select-control" value={turbine.command} disabled={!editable || busy} onChange={(event) => onCommand(event.target.value as TurbineCommand)}>
          <option value="operational">정상 가동</option>
          <option value="manual_stop">수동 정지</option>
          <option value="maintenance_stop">고장/정비 정지</option>
        </select>
        <form className="coordinate-form" onSubmit={submitPosition}>
          <div className="coordinate-fields">
            <label><span>X · 동쪽 + (m)</span><input type="number" step={10} value={xText} disabled={!editable || busy} onChange={(event) => setXText(event.target.value)} /></label>
            <label><span>Y · 북쪽 + (m)</span><input type="number" step={10} value={yText} disabled={!editable || busy} onChange={(event) => setYText(event.target.value)} /></label>
          </div>
          <div className="coordinate-actions">
            <button className="button button--primary button--small" type="submit" disabled={!editable || busy}><Save size={14} /> 위치 저장</button>
            <button className="button button--quiet button--small" type="button" disabled={!editable || !lastPlacement || busy} onClick={onUndo} title="이 발전기의 직전 위치로 되돌립니다."><RotateCcw size={14} /> 되돌리기</button>
          </div>
        </form>
        {placementWarning && <div className="inline-warning"><AlertTriangle size={14} />{placementWarning}</div>}
        {!editable && <p className="helper-copy">기준 시나리오에서는 발전기 상태와 좌표를 바꿀 수 없습니다.</p>}
      </section>
    </div>
  );
}

function SummaryAndTable({
  scenario,
  result,
  comparison,
  selectedTurbineId,
  onSelect
}: {
  scenario: FarmScenario | null;
  result: SimulationRun | null;
  comparison: Comparison | null;
  selectedTurbineId: string;
  onSelect: (id: string) => void;
}) {
  if (!scenario) return null;
  const capacityMW = scenario.turbines.reduce((sum, turbine) => sum + turbine.ratedPowerMW, 0);
  const utilization = result && capacityMW > 0 ? result.totalPowerMW / capacityMW * 100 : null;
  const resultById = new Map((result?.turbines ?? []).map((item) => [item.turbineId, item]));

  return (
    <>
      <section className="summary-section" aria-label="단지 전체 요약">
        <div className="summary-heading">
          <div><span className="eyebrow">FARM PERFORMANCE</span><h2>단지 운영 요약</h2></div>
          <span className="summary-run-state">{result ? <><Check size={14} /> 계산 완료 · {new Date(result.calculatedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}</> : <><span className="spinner-dot" /> 조건 저장 후 계산합니다</>}</span>
        </div>
        <div className="kpi-grid">
          <article className="kpi-card kpi-card--hero">
            <div className="kpi-card__top"><span>예상 단지 출력</span><span className="kpi-icon"><Zap size={16} /></span></div>
            <strong>{formatMw(result?.totalPowerMW)}<small> MW</small></strong>
            <span className="kpi-caption">정격 합계 {capacityMW.toFixed(0)} MW · 이용률 {utilization === null ? "—" : `${utilization.toFixed(1)}%`}</span>
          </article>
          <article className="kpi-card">
            <div className="kpi-card__top"><span>기준 대비 변화</span><span className="kpi-icon kpi-icon--blue"><ArrowUpRight size={16} /></span></div>
            <strong className={comparison && comparison.deltaPowerMW < 0 ? "metric-negative" : "metric-positive"}>{formatSigned(comparison?.deltaPowerMW)}<small> MW</small></strong>
            <span className="kpi-caption">기준 {formatMw(comparison?.baseline.totalPowerMW)} MW · 실험 {formatMw(comparison?.experiment.totalPowerMW)} MW</span>
          </article>
          <article className="kpi-card">
            <div className="kpi-card__top"><span>후류 손실 추정</span><span className="kpi-icon kpi-icon--amber"><Waves size={16} /></span></div>
            <strong>{formatMw(result?.wakeLossMW)}<small> MW</small></strong>
            <span className="kpi-caption">무후류 출력 대비 {result?.wakeLossPercent === null || result?.wakeLossPercent === undefined ? "—" : `${result.wakeLossPercent.toFixed(1)}%`}</span>
          </article>
          <article className="kpi-card">
            <div className="kpi-card__top"><span>가동 발전기</span><span className="kpi-icon kpi-icon--mint"><Gauge size={16} /></span></div>
            <strong>{result ? result.turbines.filter((item) => item.status === "operating").length : "—"}<small> / {scenario.turbines.length} 대</small></strong>
            <span className="kpi-caption">강풍·저풍속·수동/정비 정지는 출력 0 MW</span>
          </article>
        </div>
        {comparison && <p className="comparison-definition">{comparison.comparisonDefinition} 기준: {comparison.baseline.name} · 현재: {comparison.experiment.name}</p>}
      </section>

      <section className="turbine-table-card">
        <div className="table-card-heading">
          <div><span className="eyebrow">TURBINE OUTPUT</span><h2>발전기별 결과</h2></div>
          <span>{scenario.turbines.length}기 · 표로 읽을 수 있는 3D 대체 보기</span>
        </div>
        <div className="table-scroll">
          <table>
            <thead><tr><th scope="col">발전기</th><th scope="col">상태</th><th scope="col">예상 출력</th><th scope="col">유효 풍속</th><th scope="col">후류 감속</th><th scope="col">출력률</th></tr></thead>
            <tbody>
              {scenario.turbines.map((turbine) => {
                const turbineResult = resultById.get(turbine.id);
                const percentage = turbineResult ? Math.min(100, turbineResult.powerMW / turbine.ratedPowerMW * 100) : 0;
                return (
                  <tr key={turbine.id} className={selectedTurbineId === turbine.id ? "is-selected" : ""}>
                    <td><button type="button" className="table-select" onClick={() => onSelect(turbine.id)} aria-pressed={selectedTurbineId === turbine.id}><span className="table-turbine-dot" />{turbine.name}<small>{turbine.id}</small></button></td>
                    <td><span className={statusClass(turbineResult?.status, turbine.command)}><i />{statusLabel(turbineResult?.status, turbine.command)}</span></td>
                    <td className="table-number">{formatMw(turbineResult?.powerMW)} <small>MW</small></td>
                    <td className="table-number">{turbineResult ? `${turbineResult.effectiveWindMps.toFixed(2)} m/s` : "—"}</td>
                    <td className="table-number">{turbineResult ? `${turbineResult.wakeDeficitMps.toFixed(2)} m/s` : "—"}</td>
                    <td><div className="table-bar-wrap"><div className="table-bar"><i style={{ width: `${percentage}%` }} /></div><small>{turbineResult ? `${percentage.toFixed(0)}%` : "—"}</small></div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<FarmProject | null>(null);
  const [scenarioId, setScenarioId] = useState("");
  const [scenario, setScenario] = useState<FarmScenario | null>(null);
  const [result, setResult] = useState<SimulationRun | null>(null);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [draft, setDraft] = useState<WindDraft>({ windSpeedMps: 9.5, windDirectionDeg: 0, airDensityKgM3: 1.225 });
  const [selectedTurbineId, setSelectedTurbineId] = useState("");
  const [editMode, setEditMode] = useState(false);
  const [previewPositions, setPreviewPositions] = useState<Record<string, { xM: number; yM: number }>>({});
  const [lastPlacement, setLastPlacement] = useState<PlacementSnapshot | null>(null);
  const [layoutWarning, setLayoutWarning] = useState("");
  const [scenarioNameDraft, setScenarioNameDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saveState, setSaveState] = useState<"saved" | "pending" | "saving" | "error">("saved");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>("scene");
  const [fitVersion, setFitVersion] = useState(0);
  const [resetVersion, setResetVersion] = useState(0);
  const epochRef = useRef(0);
  const saveTimerRef = useRef<number | null>(null);

  const editable = isScenarioEditable(scenario);
  const selectedTurbine = scenario?.turbines.find((turbine) => turbine.id === selectedTurbineId) ?? scenario?.turbines[0] ?? null;
  const selectedTurbineDisplay = selectedTurbine
    ? { ...selectedTurbine, ...(previewPositions[selectedTurbine.id] ?? {}) }
    : null;
  const scenarioIsDirty = Boolean(scenario && (
    Math.abs(scenario.windSpeedMps - draft.windSpeedMps) > 0.001 ||
    Math.abs(scenario.windDirectionDeg - draft.windDirectionDeg) > 0.001 ||
    Math.abs(scenario.airDensityKgM3 - draft.airDensityKgM3) > 0.0001
  ));
  const visibleResult = scenarioIsDirty ? null : result;
  const visibleComparison = scenarioIsDirty ? null : comparison;

  useEffect(() => {
    let alive = true;
    async function bootstrap() {
      setLoading(true);
      setError("");
      try {
        const projectList = await api.getProjects();
        if (!alive) return;
        setProjects(projectList);
        if (!projectList.length) throw new Error("프로젝트가 없습니다. DB 시드가 준비됐는지 확인해 주세요.");
        const firstProject = await api.getProject(projectList[0]!.id);
        if (!alive) return;
        setProject(firstProject);
        const initialScenario = firstProject.scenarios.find((item) => item.role === "experiment") ?? firstProject.scenarios[0];
        if (!initialScenario) throw new Error("사용할 시나리오가 없습니다.");
        setScenarioId(initialScenario.id);
      } catch (caught) {
        if (alive) setError(caught instanceof Error ? caught.message : "프로젝트를 불러오지 못했습니다.");
        if (alive) setLoading(false);
      }
    }
    void bootstrap();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!scenarioId || !project) return;
    const baselineScenarioId = project.baselineScenarioId;
    const epoch = ++epochRef.current;
    setLoading(true);
    setError("");
    setResult(null);
    setComparison(null);
    setEditMode(false);
    setPreviewPositions({});
    setLastPlacement(null);
    setLayoutWarning("");
    async function loadScenario() {
      try {
        const detail = await api.getScenario(scenarioId);
        if (epoch !== epochRef.current) return;
        setScenario(detail);
        setDraft({ windSpeedMps: detail.windSpeedMps, windDirectionDeg: detail.windDirectionDeg, airDensityKgM3: detail.airDensityKgM3 });
        setScenarioNameDraft(detail.name);
        setSelectedTurbineId((selected) => detail.turbines.some((turbine) => turbine.id === selected) ? selected : detail.turbines[0]?.id ?? "");
        setFitVersion((value) => value + 1);
        const latest = await api.simulate(detail.id);
        if (epoch !== epochRef.current) return;
        setResult(latest);
        if (baselineScenarioId) {
          const nextComparison = await api.compare(detail.id, baselineScenarioId);
          if (epoch !== epochRef.current) return;
          setComparison(nextComparison);
        }
        setSaveState("saved");
      } catch (caught) {
        if (epoch === epochRef.current) setError(caught instanceof Error ? caught.message : "시나리오를 불러오지 못했습니다.");
      } finally {
        if (epoch === epochRef.current) setLoading(false);
      }
    }
    void loadScenario();
  }, [scenarioId, project]);

  useEffect(() => {
    if (!scenario || !editable || !scenarioIsDirty) return;
    setSaveState("pending");
    setResult(null);
    setComparison(null);
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      void persistSettings(scenario.id, draft);
    }, 420);
    return () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    };
  }, [draft, editable, scenario?.id, scenario?.windSpeedMps, scenario?.windDirectionDeg, scenario?.airDensityKgM3, scenarioIsDirty]);

  async function runAndCompare(scenarioIdToRun: string, epoch: number) {
    const latest = await api.simulate(scenarioIdToRun);
    if (epoch !== epochRef.current) return;
    setResult(latest);
    if (project?.baselineScenarioId) {
      const nextComparison = await api.compare(scenarioIdToRun, project.baselineScenarioId);
      if (epoch !== epochRef.current) return;
      setComparison(nextComparison);
    }
  }

  async function persistSettings(id: string, settings: WindDraft) {
    const epoch = ++epochRef.current;
    setSaveState("saving");
    setError("");
    try {
      const updated = await api.updateSettings(id, settings);
      if (epoch !== epochRef.current) return;
      setScenario(updated);
      await runAndCompare(id, epoch);
      if (epoch === epochRef.current) setSaveState("saved");
    } catch (caught) {
      if (epoch === epochRef.current) {
        setSaveState("error");
        setError(caught instanceof Error ? caught.message : "조건을 저장하지 못했습니다.");
      }
    }
  }

  function changeDraft(change: Partial<WindDraft>) {
    setDraft((current) => ({ ...current, ...change }));
  }

  async function commitPlacement(turbineId: string, position: { xM: number; yM: number }) {
    if (!scenario || !editable) return;
    const target = scenario.turbines.find((turbine) => turbine.id === turbineId);
    if (!target) return;
    const candidateLayout = scenario.turbines.map((turbine) => turbine.id === turbineId ? { ...turbine, ...position } : turbine);
    const issues = validateLayout(candidateLayout);
    const blockingIssue = issues.find((issue) => issue.severity === "error");
    if (blockingIssue) {
      setPreviewPositions({});
      setLayoutWarning(blockingIssue.message);
      setError(blockingIssue.message);
      return;
    }
    const warning = issues.find((issue) => issue.severity === "warning");
    setLayoutWarning(warning?.message ?? "");
    setError("");
    setBusy(true);
    setSaveState("saving");
    setResult(null);
    setComparison(null);
    setLastPlacement({ turbineId, xM: target.xM, yM: target.yM });
    const epoch = ++epochRef.current;
    try {
      const updated = await api.updatePlacement(scenario.id, turbineId, position);
      if (epoch !== epochRef.current) return;
      setPreviewPositions({});
      setScenario(updated.scenario);
      const serverWarning = updated.layoutIssues.find((issue) => issue.severity === "warning");
      setLayoutWarning(serverWarning?.message ?? warning?.message ?? "");
      await runAndCompare(scenario.id, epoch);
      if (epoch === epochRef.current) setSaveState("saved");
    } catch (caught) {
      if (epoch === epochRef.current) {
        setPreviewPositions({});
        setError(caught instanceof Error ? caught.message : "배치를 저장하지 못했습니다.");
        setSaveState("error");
      }
    } finally {
      if (epoch === epochRef.current) setBusy(false);
    }
  }

  async function changeTurbineCommand(command: TurbineCommand) {
    if (!scenario || !selectedTurbine) return;
    setBusy(true);
    setSaveState("saving");
    setError("");
    setResult(null);
    setComparison(null);
    const epoch = ++epochRef.current;
    try {
      const updated = await api.updatePlacement(scenario.id, selectedTurbine.id, { command });
      if (epoch !== epochRef.current) return;
      setScenario(updated.scenario);
      await runAndCompare(scenario.id, epoch);
      if (epoch === epochRef.current) setSaveState("saved");
    } catch (caught) {
      if (epoch === epochRef.current) {
        setError(caught instanceof Error ? caught.message : "운전 상태를 저장하지 못했습니다.");
        setSaveState("error");
      }
    } finally {
      if (epoch === epochRef.current) setBusy(false);
    }
  }

  async function undoPlacement() {
    if (!lastPlacement) return;
    const snapshot = lastPlacement;
    const current = scenario?.turbines.find((turbine) => turbine.id === snapshot.turbineId);
    if (!current) return;
    await commitPlacement(snapshot.turbineId, { xM: snapshot.xM, yM: snapshot.yM });
  }

  async function resetLayout() {
    if (!scenario || !editable) return;
    setBusy(true);
    setError("");
    setResult(null);
    setComparison(null);
    const epoch = ++epochRef.current;
    try {
      const updated = await api.resetLayout(scenario.id);
      if (epoch !== epochRef.current) return;
      setScenario(updated);
      setLastPlacement(null);
      setPreviewPositions({});
      setLayoutWarning("");
      await runAndCompare(updated.id, epoch);
      if (epoch === epochRef.current) setSaveState("saved");
    } catch (caught) {
      if (epoch === epochRef.current) setError(caught instanceof Error ? caught.message : "기준 배치를 복원하지 못했습니다.");
    } finally {
      if (epoch === epochRef.current) setBusy(false);
    }
  }

  async function duplicateScenario(name?: string) {
    if (!scenario || !project) return;
    setBusy(true);
    setError("");
    try {
      const duplicate = await api.duplicate(scenario.id, name ?? `${scenario.name} 복사 · ${compactTime()}`);
      const freshProject = await api.getProject(project.id);
      setProject(freshProject);
      setScenarioId(duplicate.id);
      setNotice(`“${duplicate.name}” 시나리오를 복제했습니다.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "시나리오를 복제하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function applyExperimentPreset(presetId: string) {
    if (!scenario || !project) return;
    setBusy(true);
    setError("");
    try {
      const label = experimentPresets.find((preset) => preset.id === presetId)?.title ?? "실험";
      let created = await api.duplicate(scenario.id, `${label} · ${compactTime()}`);
      if (presetId === "gale") {
        created = await api.updateSettings(created.id, { windSpeedMps: 28 });
      } else if (presetId === "direction") {
        created = await api.updateSettings(created.id, { windDirectionDeg: 90 });
      } else if (presetId === "stop") {
        const firstActiveTurbine = created.turbines.find((turbine) => turbine.command === "operational");
        if (firstActiveTurbine) created = (await api.updatePlacement(created.id, firstActiveTurbine.id, { command: "manual_stop" })).scenario;
      }
      setProject(await api.getProject(project.id));
      setScenarioId(created.id);
      setNotice(`현재 실험을 보존하고 “${created.name}”을 새로 만들었습니다.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "프리셋을 적용하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function renameScenario() {
    if (!scenario || !editable || !scenarioNameDraft.trim()) return;
    setBusy(true);
    setError("");
    try {
      const renamed = await api.rename(scenario.id, scenarioNameDraft.trim());
      setScenario(renamed);
      setProject(project ? await api.getProject(project.id) : null);
      setNotice("시나리오 이름을 저장했습니다.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "이름을 저장하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function switchProject(projectId: string) {
    setLoading(true);
    setError("");
    try {
      const nextProject = await api.getProject(projectId);
      setProject(nextProject);
      const nextScenario = nextProject.scenarios.find((item) => item.role === "experiment") ?? nextProject.scenarios[0];
      if (nextScenario) setScenarioId(nextScenario.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "프로젝트를 바꾸지 못했습니다.");
      setLoading(false);
    }
  }

  function onPreviewMove(turbineId: string, position: { xM: number; yM: number }) {
    setPreviewPositions((current) => ({ ...current, [turbineId]: position }));
    setLayoutWarning("");
  }

  if (loading && !project) {
    return <div className="loading-screen"><div className="loading-mark"><Wind size={25} /></div><strong>WindScope를 준비하고 있습니다</strong><span>샘플 단지와 시나리오를 불러오는 중</span><div className="loading-line"><i /></div></div>;
  }
  if (!project) {
    return <div className="fatal-screen"><div className="brand-mark"><Wind size={20} /></div><h1>WindScope를 열지 못했습니다</h1><p>{error || "API 서버에 연결할 수 없습니다."}</p><ol><li>터미널에서 <code>npm run dev</code>가 실행 중인지 확인하세요.</li><li>SQLite 파일을 읽고 쓸 수 있는지 확인하세요.</li><li>오류가 계속되면 API 주소와 콘솔 메시지를 확인하세요.</li></ol></div>;
  }

  const currentProject = project;
  const isSettingDirty = scenarioIsDirty;
  const selectedResult = visibleResult ? resultForTurbine(visibleResult.turbines, selectedTurbine?.id ?? "") : undefined;
  const saveLabel = saveState === "saving" ? "저장·계산 중" : saveState === "pending" ? "변경 대기 중" : saveState === "error" ? "저장 확인 필요" : "저장됨";

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <div className="brand-mark"><Wind size={20} strokeWidth={1.8} /></div>
          <div><strong>WindScope</strong><span>OFFSHORE WIND LAB</span></div>
        </div>
        <div className="header-context">
          <label className="header-select-wrap">
            <span>프로젝트</span>
            <select value={currentProject.id} onChange={(event) => void switchProject(event.target.value)} aria-label="프로젝트 선택">
              {projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select><ChevronDown size={13} />
          </label>
          <span className="header-divider" />
          <label className="header-select-wrap header-select-wrap--scenario">
            <span>시나리오</span>
            <select value={scenarioId} onChange={(event) => setScenarioId(event.target.value)} aria-label="시나리오 선택">
              {currentProject.scenarios.map((item) => <option key={item.id} value={item.id}>{item.role === "baseline" ? "기준 · " : "실험 · "}{item.name}</option>)}
            </select><ChevronDown size={13} />
          </label>
          <span className={`save-pill save-pill--${saveState}`}><i />{saveLabel}</span>
          <button type="button" className="header-action" onClick={() => void duplicateScenario()} disabled={busy || !scenario} title="현재 시나리오 복제"><Copy size={15} /><span>실험 복제</span></button>
        </div>
        <a className="header-help" href="#model-assumptions" aria-label="모델 가정 보기"><CircleHelp size={16} /><span>모델 가정</span></a>
      </header>

      <div className="page-intro">
        <div><span className="eyebrow">WIND FARM SIMULATOR <i /></span><h1>해상풍력단지 분석</h1><p>{project.description ?? "풍향과 배치에 따른 예상 출력과 후류 영향을 살펴보세요."}</p></div>
        <div className="page-intro__meta"><span><span className="live-dot" />교육용 추정 모델</span><span>좌표 기준 · X 동쪽 / Y 북쪽</span></div>
      </div>

      {(error || notice) && <div className={`toast-banner ${error ? "toast-banner--error" : "toast-banner--success"}`} role={error ? "alert" : "status"}>
        {error ? <AlertTriangle size={16} /> : <Check size={16} />}
        <span>{error || notice}</span>
        {error && scenarioIsDirty && editable && <button type="button" onClick={() => void persistSettings(scenario!.id, draft)}>다시 저장</button>}
        <button type="button" className="toast-close" aria-label="닫기" onClick={() => { setError(""); setNotice(""); }}>×</button>
      </div>}

      <nav className="mobile-panel-switch" aria-label="대시보드 패널">
        {([ ["controls", "조작"], ["scene", "3D 단지"], ["details", "발전기 정보"] ] as const).map(([id, label]) => <button type="button" key={id} className={mobilePanel === id ? "is-active" : ""} onClick={() => setMobilePanel(id)}>{label}</button>)}
      </nav>

      <main className={`dashboard-grid dashboard-grid--${mobilePanel}`}>
        <aside className="left-panel">
          <WindControls
            draft={draft}
            disabled={!scenario || busy}
            onChange={changeDraft}
            onPreset={(degrees) => changeDraft({ windDirectionDeg: degrees })}
            onResetLayout={() => void resetLayout()}
            onToggleEdit={() => setEditMode((active) => !active)}
            editMode={editMode}
            onScenarioDuplicate={() => void duplicateScenario()}
            onApplyPreset={(id) => void applyExperimentPreset(id)}
            scenario={scenario}
            busy={busy}
          />
        </aside>

        <section className="main-column">
          <div className="scene-toolbar">
            <div className="scene-toolbar__status"><span className="scene-status-icon"><Waves size={17} /></span><div><strong>{scenario?.name ?? "시나리오 불러오는 중"}</strong><small>{scenario?.role === "baseline" ? "읽기 전용 기준 조건" : "현재 실험 조건"}{loading ? " · 계산 중" : " · API 연결"}</small></div></div>
            <div className="scene-toolbar__actions">
              <button type="button" className="icon-button" onClick={() => setFitVersion((value) => value + 1)} title="전체 단지 보기" aria-label="전체 단지 보기"><span className="fit-icon"><i /></span></button>
              <button type="button" className="icon-button" onClick={() => setResetVersion((value) => value + 1)} title="카메라 시점 초기화" aria-label="카메라 시점 초기화"><RotateCcw size={15} /></button>
              <span className="camera-label">궤도 카메라</span>
            </div>
          </div>
          {scenario ? <Suspense fallback={<div className="scene-loading"><div className="loading-line"><i /></div><span>3D 장면을 준비하고 있습니다.</span></div>}><FarmScene
            turbines={scenario.turbines}
            results={visibleResult?.turbines ?? []}
            windSpeedMps={draft.windSpeedMps}
            windDirectionDeg={draft.windDirectionDeg}
            selectedTurbineId={selectedTurbineId}
            editMode={editMode && editable}
            previewPositions={previewPositions}
            onSelect={(id) => { if (id) setSelectedTurbineId(id); }}
            onHover={() => undefined}
            onPreviewMove={onPreviewMove}
            onCommitMove={(id, position) => void commitPlacement(id, position)}
            fitVersion={fitVersion}
            resetVersion={resetVersion}
          /></Suspense> : <div className="scene-loading"><div className="loading-line"><i /></div><span>시나리오 데이터를 불러오고 있습니다.</span></div>}
          <SummaryAndTable
            scenario={scenario}
            result={visibleResult}
            comparison={visibleComparison}
            selectedTurbineId={selectedTurbineId}
            onSelect={setSelectedTurbineId}
          />
        </section>

        <aside className="right-panel">
          <section className="scenario-editor panel-section">
            <div className="section-title-row"><div className="section-icon section-icon--scenario"><Save size={16} /></div><div><h2>시나리오 정보</h2><p>기준과 실험을 독립 보존</p></div></div>
            <label className="form-label" htmlFor="scenario-name">시나리오 이름</label>
            <div className="scenario-name-input"><input id="scenario-name" value={scenarioNameDraft} disabled={!editable || busy} onChange={(event) => setScenarioNameDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void renameScenario(); }} /><button type="button" aria-label="시나리오 이름 저장" title="이름 저장" disabled={!editable || busy || scenarioNameDraft.trim() === scenario?.name} onClick={() => void renameScenario()}><Save size={14} /></button></div>
            <div className="scenario-meta"><span>{scenario?.role === "baseline" ? "기준 배치" : "실험 배치"}</span><span>{scenario?.turbines.length ?? 0}기</span></div>
          </section>
          <TurbineDetail
            turbine={selectedTurbineDisplay}
            result={selectedResult}
            scenario={scenario}
            busy={busy || loading || isSettingDirty}
            lastPlacement={lastPlacement?.turbineId === selectedTurbine?.id ? lastPlacement : null}
            placementWarning={layoutWarning}
            onSavePosition={(position) => void commitPlacement(selectedTurbine!.id, position)}
            onCommand={(command) => void changeTurbineCommand(command)}
            onUndo={() => void undoPlacement()}
          />
          <div className="assumptions-mini" id="model-assumptions">
            <div className="assumptions-mini__title"><CircleHelp size={15} /><strong>계산 가정</strong></div>
            <ul>
              <li>풍향 기준: 북쪽 0°, 시계 방향 증가</li>
              <li>무후류 출력 대비 손실률로 표시</li>
              <li>다중 후류 결손은 RSS로 합성</li>
              <li>정지 터빈의 공력 효과는 미반영</li>
            </ul>
            <p>제조사 성능 곡선·실측 풍황·대기 안정도·지형·파랑을 반영한 인증 설계 도구가 아닙니다.</p>
          </div>
        </aside>
      </main>

      <footer className="app-footer"><span>WindScope <i /> 교육·설계 검토용 추정 도구</span><span>출력 MW · 풍속 m/s · 위치 m · 풍향 deg</span></footer>
    </div>
  );
}

export default App;

