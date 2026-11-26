import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Group, PerspectiveCamera, Plane, Quaternion, Vector3 } from "three";
import type { TurbineInput, TurbineResult, TurbineStatus } from "../../shared/domain";
import { SCENE_METERS_TO_UNITS, farmToWorld, windFlowVector, worldToFarm } from "../../shared/domain";
import { wakeCenterDeficit } from "../../shared/simulation";
import { dragPosition, fitPerspectiveDistance, getSceneBounds, type FarmPosition, type SceneBounds } from "./scene-math";

type FarmSceneProps = {
  turbines: TurbineInput[];
  results: TurbineResult[];
  windSpeedMps: number;
  windDirectionDeg: number;
  selectedTurbineId: string;
  editMode: boolean;
  previewPositions: Record<string, { xM: number; yM: number }>;
  onSelect: (turbineId: string) => void;
  onHover: (turbineId: string | null) => void;
  onPreviewMove: (turbineId: string, position: { xM: number; yM: number }) => void;
  onCommitMove: (turbineId: string, position: { xM: number; yM: number }) => void;
  fitVersion: number;
  resetVersion: number;
};

type ControlHandle = { target: Vector3; update: () => void };
type SceneTurbine = TurbineInput & { windSpeedMps: number; windDirectionDeg: number };

function Water({ size }: { size: number }) {
  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.04, 0]} receiveShadow>
        <planeGeometry args={[size, size]} />
        <meshStandardMaterial color="#092f40" roughness={0.42} metalness={0.18} />
      </mesh>
      <gridHelper args={[size, Math.min(100, Math.max(24, Math.round(size / 1.5))), "#206073", "#164557"]} position={[0, 0.01, 0]} />
      <gridHelper args={[size, 10, "#4b93a0", "#1d5262"]} position={[0, 0.015, 0]} material-transparent material-opacity={0.18} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <ringGeometry args={[size * 0.48, size * 0.485, 96]} />
        <meshBasicMaterial color="#57949c" transparent opacity={0.3} side={2} />
      </mesh>
    </>
  );
}

function WakeVolume({ turbine, lengthM, windDirectionDeg }: { turbine: TurbineInput; lengthM: number; windDirectionDeg: number }) {
  const flow = useMemo(() => windFlowVector(windDirectionDeg), [windDirectionDeg]);
  const direction = useMemo(() => new Vector3(flow.east, 0, -flow.north).normalize(), [flow.east, flow.north]);
  const rotation = useMemo(() => new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), direction), [direction]);
  const [worldX, worldZ] = farmToWorld(turbine.xM, turbine.yM);
  const hubHeight = turbine.hubHeightM * SCENE_METERS_TO_UNITS;
  const segmentCount = 6;
  const segmentLengthM = lengthM / segmentCount;
  return (
    <group name={`wake-${turbine.id}`}>
      {Array.from({ length: segmentCount }, (_, index) => {
        const startM = index * segmentLengthM;
        const endM = startM + segmentLengthM;
        const middleM = (startM + endM) / 2;
        const deficit = wakeCenterDeficit(turbine.thrustCoefficient, turbine.wakeExpansion, turbine.rotorDiameterM / 2, middleM);
        const startRadius = (turbine.rotorDiameterM / 2 + turbine.wakeExpansion * startM) * SCENE_METERS_TO_UNITS;
        const endRadius = (turbine.rotorDiameterM / 2 + turbine.wakeExpansion * endM) * SCENE_METERS_TO_UNITS;
        const middle = middleM * SCENE_METERS_TO_UNITS;
        return (
          <mesh key={index} position={[worldX + direction.x * middle, hubHeight, worldZ + direction.z * middle]} quaternion={rotation} renderOrder={1}>
            <cylinderGeometry args={[endRadius, startRadius, segmentLengthM * SCENE_METERS_TO_UNITS, 16, 1, true]} />
            <meshBasicMaterial color={deficit >= 0.25 ? "#ee9867" : "#29c8bf"} transparent opacity={deficit * 0.28} depthWrite={false} side={2} />
          </mesh>
        );
      })}
    </group>
  );
}

function WindParticles({ windSpeedMps, windDirectionDeg }: { windSpeedMps: number; windDirectionDeg: number }) {
  const group = useRef<Group>(null);
  const flow = useMemo(() => windFlowVector(windDirectionDeg), [windDirectionDeg]);
  const flowX = flow.east;
  const flowZ = -flow.north;
  const crossX = -flowZ;
  const crossZ = flowX;
  const travel = useRef(0);
  useFrame((_state, delta) => {
    const children = group.current?.children;
    if (!children) return;
    travel.current = (travel.current + Math.min(delta, 0.1) * windSpeedMps * 0.12) % 30;
    const travelDistance = travel.current;
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]!;
      const along = ((travelDistance + index * 2.3) % 30) - 15;
      const across = ((index * 7.17) % 20) - 10;
      child.position.set(flowX * along + crossX * across, 0.19 + (index % 3) * 0.035, flowZ * along + crossZ * across);
    }
  });
  return (
    <group ref={group} name="wind-particles" visible={windSpeedMps > 0}>
      {Array.from({ length: 24 }, (_, index) => (
        <mesh key={index}>
          <sphereGeometry args={[index % 4 === 0 ? 0.055 : 0.035, 7, 7]} />
          <meshBasicMaterial color={index % 5 === 0 ? "#d8fff4" : "#62d7d0"} transparent opacity={index % 4 === 0 ? 0.9 : 0.62} />
        </mesh>
      ))}
    </group>
  );
}

function capturePointer(event: ThreeEvent<PointerEvent>, release = false) {
  const target = event.target as unknown as {
    setPointerCapture?: (pointerId: number) => void;
    releasePointerCapture?: (pointerId: number) => void;
  };
  if (release) target.releasePointerCapture?.(event.pointerId);
  else target.setPointerCapture?.(event.pointerId);
}

function TurbineModel({
  turbine,
  status,
  selected,
  hovered,
  editMode,
  position,
  onSelect,
  onHover,
  onPreviewMove,
  onCommitMove
}: {
  turbine: SceneTurbine;
  status: TurbineStatus | undefined;
  selected: boolean;
  hovered: boolean;
  editMode: boolean;
  position: FarmPosition;
  onSelect: () => void;
  onHover: (hovered: boolean) => void;
  onPreviewMove: (position: FarmPosition) => void;
  onCommitMove: (position: FarmPosition) => void;
}) {
  const rotor = useRef<Group>(null);
  const dragging = useRef(false);
  const dragOrigin = useRef<FarmPosition | null>(null);
  const dragStart = useRef<FarmPosition | null>(null);
  const dragPointerId = useRef<number | null>(null);
  const latestPosition = useRef<FarmPosition | null>(null);
  const running = turbine.command === "operational" && status === "operating";
  const scale = SCENE_METERS_TO_UNITS;
  const hubHeight = turbine.hubHeightM * scale;
  const rotorRadius = turbine.rotorDiameterM * scale * 0.5;
  const bladeLength = rotorRadius * 0.96;
  const yawRadians = (Math.atan2(Math.sin((Math.PI * turbine.windDirectionDeg) / 180), -Math.cos((Math.PI * turbine.windDirectionDeg) / 180)));
  const [worldX, worldZ] = farmToWorld(position.xM, position.yM);
  const plane = useMemo(() => new Plane(new Vector3(0, 1, 0), 0), []);
  useFrame((_state, delta) => {
    if (running && rotor.current) rotor.current.rotation.z += Math.min(delta, 0.1) * (0.32 + Math.min(1, turbine.windSpeedMps / 15) * 0.8);
  });

  useEffect(() => {
    if (!editMode && dragging.current) {
      dragging.current = false;
      if (dragOrigin.current) onPreviewMove(dragOrigin.current);
      dragPointerId.current = null;
      latestPosition.current = null;
    }
  }, [editMode, onPreviewMove]);
  useEffect(() => () => { document.body.style.cursor = ""; }, []);

  function pointToFarm(event: ThreeEvent<PointerEvent>) {
    const point = event.ray.intersectPlane(plane, new Vector3());
    if (!point) return;
    const [xM, yM] = worldToFarm(point.x, point.z);
    if (!dragOrigin.current || !dragStart.current) return;
    const next = dragPosition(dragOrigin.current, dragStart.current, { xM, yM });
    latestPosition.current = next;
    onPreviewMove(next);
  }

  function handleDown(event: ThreeEvent<PointerEvent>) {
    if (event.button !== 0) return;
    event.stopPropagation();
    onSelect();
    if (!editMode) return;
    const point = event.ray.intersectPlane(plane, new Vector3());
    if (!point) return;
    const [xM, yM] = worldToFarm(point.x, point.z);
    dragOrigin.current = { ...position };
    dragStart.current = { xM, yM };
    dragPointerId.current = event.pointerId;
    latestPosition.current = null;
    dragging.current = true;
    capturePointer(event);
    document.body.style.cursor = "grabbing";
  }

  function handleMove(event: ThreeEvent<PointerEvent>) {
    if (!dragging.current || event.pointerId !== dragPointerId.current) return;
    event.stopPropagation();
    pointToFarm(event);
  }

  function handleUp(event: ThreeEvent<PointerEvent>) {
    if (!dragging.current || event.pointerId !== dragPointerId.current) return;
    event.stopPropagation();
    dragging.current = false;
    capturePointer(event, true);
    const next = latestPosition.current;
    const origin = dragOrigin.current;
    if (next && origin && (next.xM !== origin.xM || next.yM !== origin.yM)) onCommitMove(next);
    document.body.style.cursor = editMode ? "grab" : "";
    dragPointerId.current = null;
    latestPosition.current = null;
  }

  function handleCancel(event: ThreeEvent<PointerEvent>) {
    if (!dragging.current || event.pointerId !== dragPointerId.current) return;
    event.stopPropagation();
    dragging.current = false;
    capturePointer(event, true);
    if (dragOrigin.current) onPreviewMove(dragOrigin.current);
    dragPointerId.current = null;
    latestPosition.current = null;
    document.body.style.cursor = "";
  }

  const bodyColor = status === "manual_stop" || status === "maintenance_stop" || turbine.command !== "operational"
    ? "#ee876b"
    : status === "high_wind" || status === "low_wind"
      ? "#e2b778"
      : "#e6f1ed";
  return (
    <group
      name={`turbine-${turbine.id}`}
      position={[worldX, 0, worldZ]}
      rotation={[0, yawRadians, 0]}
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      onPointerUp={handleUp}
      onPointerCancel={handleCancel}
      onLostPointerCapture={handleCancel}
      onPointerOver={(event) => { event.stopPropagation(); onHover(true); document.body.style.cursor = editMode ? "grab" : "pointer"; }}
      onPointerOut={() => { onHover(false); if (document.body.style.cursor === "pointer" || document.body.style.cursor === "grab") document.body.style.cursor = ""; }}
    >
      <mesh position={[0, 0.09, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.44, 0.55, 0.18, 10]} />
        <meshStandardMaterial color="#77949a" metalness={0.3} roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.21, 0]} castShadow>
        <cylinderGeometry args={[0.06, 0.06, 0.08, 8]} />
        <meshStandardMaterial color="#aac4c3" metalness={0.3} roughness={0.45} />
      </mesh>
      <mesh position={[0, hubHeight * 0.5, 0]} castShadow>
        <cylinderGeometry args={[0.045, 0.095, hubHeight * 0.96, 12]} />
        <meshStandardMaterial color={bodyColor} metalness={0.24} roughness={0.46} />
      </mesh>
      <mesh position={[0, hubHeight, 0]} castShadow>
        <boxGeometry args={[0.58, 0.16, 0.2]} />
        <meshStandardMaterial color="#d5e4df" metalness={0.25} roughness={0.4} />
      </mesh>
      <group ref={rotor} name={`rotor-${turbine.id}`} position={[0, hubHeight, 0]}>
        <mesh>
          <sphereGeometry args={[0.12, 12, 12]} />
          <meshStandardMaterial color="#f0f5ef" metalness={0.18} roughness={0.4} />
        </mesh>
        {[0, 1, 2].map((blade) => (
          <group key={blade} rotation={[0, 0, (blade * Math.PI * 2) / 3]}>
            <mesh position={[0, bladeLength * 0.5, 0]} castShadow>
              <cylinderGeometry args={[0.018, 0.075, bladeLength, 7]} />
              <meshStandardMaterial color="#f0f5ef" metalness={0.08} roughness={0.42} />
            </mesh>
          </group>
        ))}
      </group>
      {(selected || hovered) && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.04, 0]}>
          <ringGeometry args={[0.72, 0.81, 40]} />
          <meshBasicMaterial color="#55e4c4" transparent opacity={selected ? 0.95 : 0.5} side={2} />
        </mesh>
      )}
      {editMode && dragging.current && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.035, 0]}>
          <ringGeometry args={[0.88, 0.94, 36]} />
          <meshBasicMaterial color="#eab36e" transparent opacity={0.92} side={2} />
        </mesh>
      )}
    </group>
  );
}

function ViewRig({
  controlsRef,
  bounds,
  fitVersion,
  resetVersion
}: {
  controlsRef: React.RefObject<ControlHandle | null>;
  bounds: SceneBounds;
  fitVersion: number;
  resetVersion: number;
}) {
  const { camera, size } = useThree();
  const viewRef = useRef(bounds);
  viewRef.current = bounds;
  const aspect = size.width / Math.max(1, size.height);
  useEffect(() => {
    const current = viewRef.current;
    if (!(camera instanceof PerspectiveCamera)) return;
    const distance = fitPerspectiveDistance(current.radius, camera.fov, aspect);
    const direction = new Vector3(0.9, 0.9, 1.08).normalize().multiplyScalar(distance);
    camera.position.set(current.centerX + direction.x, current.centerY + direction.y, current.centerZ + direction.z);
    camera.far = Math.max(500, distance * 8);
    camera.updateProjectionMatrix();
    camera.lookAt(current.centerX, current.centerY, current.centerZ);
    if (controlsRef.current) {
      controlsRef.current.target.set(current.centerX, current.centerY, current.centerZ);
      controlsRef.current.update();
    }
  }, [camera, controlsRef, fitVersion, resetVersion, aspect]);
  return null;
}

function SceneContent(props: FarmSceneProps & {
  hoveredId: string | null;
  setHoveredId: (id: string | null) => void;
  labels: React.RefObject<Map<string, HTMLDivElement>>;
  onContextFailure: () => void;
}) {
  const controlsRef = useRef<ControlHandle | null>(null);
  const bounds = getSceneBounds(props.turbines, props.previewPositions);
  const { centerX, centerZ } = bounds;
  const layoutSpan = bounds.span;
  const viewSpan = Math.max(layoutSpan * 1.4, 24);
  const waterSize = viewSpan * 2.45;
  const { size, gl } = useThree();
  const fitDistance = fitPerspectiveDistance(bounds.radius, 42, size.width / Math.max(1, size.height));
  const wakeLengthM = Math.max(800, Math.min(1_600, layoutSpan / SCENE_METERS_TO_UNITS * 0.62));
  const resultById = useMemo(() => new Map(props.results.map((result) => [result.turbineId, result])), [props.results]);
  const flow = useMemo(() => windFlowVector(props.windDirectionDeg), [props.windDirectionDeg]);
  const overlayPositions = useMemo(() => new Set(props.results.filter((item) => item.status === "operating").map((item) => item.turbineId)), [props.results]);
  const labelPoint = useMemo(() => new Vector3(), []);
  useFrame(({ camera }) => {
    for (const turbine of props.turbines) {
      const element = props.labels.current.get(turbine.id);
      if (!element) continue;
      const position = props.previewPositions[turbine.id] ?? turbine;
      const [x, z] = farmToWorld(position.xM, position.yM);
      labelPoint.set(x, (turbine.hubHeightM + turbine.rotorDiameterM / 2) * SCENE_METERS_TO_UNITS + 0.22, z).project(camera);
      element.style.visibility = labelPoint.z > -1 && labelPoint.z < 1 && Math.abs(labelPoint.x) < 1.2 && Math.abs(labelPoint.y) < 1.2 ? "visible" : "hidden";
      element.style.transform = `translate(-50%, -100%) translate(${(labelPoint.x * 0.5 + 0.5) * size.width}px, ${(-labelPoint.y * 0.5 + 0.5) * size.height}px)`;
    }
  });
  useEffect(() => {
    const canvas = gl.domElement;
    const onLost = (event: Event) => { event.preventDefault(); props.onContextFailure(); };
    canvas.addEventListener("webglcontextlost", onLost);
    return () => canvas.removeEventListener("webglcontextlost", onLost);
  }, [gl, props.onContextFailure]);

  return (
    <>
      <color attach="background" args={["#071722"]} />
      <fog attach="fog" args={["#071722", fitDistance + bounds.radius * 2, fitDistance + waterSize * 2]} />
      <ambientLight intensity={1.05} />
      <directionalLight position={[11, 18, 8]} intensity={1.85} castShadow />
      <hemisphereLight args={["#b7e2e5", "#0b2e3e", 0.52]} />
      <group position={[centerX, 0, centerZ]} name="ocean">
        <Water size={waterSize} />
        <WindParticles windSpeedMps={props.windSpeedMps} windDirectionDeg={props.windDirectionDeg} />
      </group>
      {props.turbines.filter((turbine) => turbine.command === "operational" && turbine.thrustCoefficient > 0 && overlayPositions.has(turbine.id)).map((turbine) => {
        const preview = props.previewPositions[turbine.id];
        const wakeTurbine = preview ? { ...turbine, xM: preview.xM, yM: preview.yM } : turbine;
        return <WakeVolume key={`wake-${turbine.id}`} turbine={wakeTurbine} lengthM={wakeLengthM} windDirectionDeg={props.windDirectionDeg} />;
      })}
      {props.turbines.map((turbine) => (
        <TurbineModel
          key={turbine.id}
          turbine={{ ...turbine, windSpeedMps: props.windSpeedMps, windDirectionDeg: props.windDirectionDeg } as TurbineInput & { windSpeedMps: number; windDirectionDeg: number }}
          status={resultById.get(turbine.id)?.status}
          selected={turbine.id === props.selectedTurbineId}
          hovered={turbine.id === props.hoveredId}
          editMode={props.editMode}
          position={props.previewPositions[turbine.id] ?? turbine}
          onSelect={() => props.onSelect(turbine.id)}
          onHover={(hovered) => props.setHoveredId(hovered ? turbine.id : null)}
          onPreviewMove={(position) => props.onPreviewMove(turbine.id, position)}
          onCommitMove={(position) => props.onCommitMove(turbine.id, position)}
        />
      ))}
      <ViewRig
        controlsRef={controlsRef}
        bounds={bounds}
        fitVersion={props.fitVersion}
        resetVersion={props.resetVersion}
      />
      <OrbitControls
        ref={controlsRef as never}
        makeDefault
        enabled={!props.editMode}
        minDistance={7}
        maxDistance={fitDistance * 3}
        maxPolarAngle={Math.PI * 0.48}
        enableDamping
        dampingFactor={0.08}
      />
      <arrowHelper
        name="wind-flow-arrow"
        args={[new Vector3(flow.east, 0, -flow.north), new Vector3(centerX - viewSpan * 0.44, 0.22, centerZ - viewSpan * 0.42), 4.2, "#88e2dc", 0.9, 0.48]}
      />
      <group name="scale-500m" position={[centerX - 3, 0.05, centerZ + layoutSpan * 0.55]}>
        <mesh position={[3, 0, 0]}><boxGeometry args={[500 * SCENE_METERS_TO_UNITS, 0.025, 0.035]} /><meshBasicMaterial color="#c7e9e2" /></mesh>
        {[0, 500 * SCENE_METERS_TO_UNITS].map((x) => <mesh key={x} position={[x, 0, 0]}><boxGeometry args={[0.035, 0.025, 0.45]} /><meshBasicMaterial color="#c7e9e2" /></mesh>)}
      </group>
    </>
  );
}

class SceneErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode; onError: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onError(); }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

export function FarmScene(props: FarmSceneProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [renderState, setRenderState] = useState<"loading" | "ready" | "failed">("loading");
  const [retryVersion, setRetryVersion] = useState(0);
  const [pageVisible, setPageVisible] = useState(document.visibilityState !== "hidden");
  const [reducedMotion, setReducedMotion] = useState(false);
  const labelElements = useRef(new Map<string, HTMLDivElement>());
  const contextFailure = useCallback(() => setRenderState("failed"), []);
  useEffect(() => {
    const updateVisibility = () => setPageVisible(document.visibilityState !== "hidden");
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotion = () => setReducedMotion(preference.matches);
    updateMotion();
    document.addEventListener("visibilitychange", updateVisibility);
    preference.addEventListener("change", updateMotion);
    return () => {
      document.removeEventListener("visibilitychange", updateVisibility);
      preference.removeEventListener("change", updateMotion);
    };
  }, []);
  const fallback = <div className="webgl-fallback" role="status"><strong>3D 화면을 열 수 없습니다.</strong><span>아래 발전기 표와 수치는 계속 사용할 수 있습니다.</span><button type="button" className="secondary-button" onClick={() => { setRenderState("loading"); setRetryVersion((value) => value + 1); }}>3D 다시 열기</button></div>;
  const statusCounts = props.results.reduce<Record<string, number>>((counts, item) => {
    counts[item.status] = (counts[item.status] ?? 0) + 1;
    return counts;
  }, {});
  const stoppedCount = (statusCounts.manual_stop ?? 0) + (statusCounts.maintenance_stop ?? 0) + (statusCounts.high_wind ?? 0);

  return (
    <section className="scene-card" aria-label="해상풍력단지 3D 보기" data-testid="farm-scene" data-render-state={renderState}>
      <div className="scene-card__header">
        <div>
          <span className="eyebrow">OFFSHORE ARRAY · LIVE MODEL</span>
          <h2>단지 조감도</h2>
          <p>북쪽 0° · 시계 방향 · 나침반은 불어오는 쪽(FROM), 해면 화살표·입자는 흘러가는 쪽(FLOW)입니다.</p>
        </div>
        <div className="scene-card__conditions">
          <span><i className="condition-dot" /> {props.windSpeedMps.toFixed(1)} m/s</span>
          <span>풍향 {Math.round(props.windDirectionDeg)}°</span>
          <span className={stoppedCount > 0 ? "condition-warning" : ""}>{props.results.length ? `${stoppedCount}대 정지` : "계산 대기"}</span>
        </div>
      </div>
      <div className="scene-canvas-wrap">
        <SceneErrorBoundary key={retryVersion} fallback={fallback} onError={contextFailure}>
        {renderState === "failed" ? fallback : <Canvas
          shadows="basic"
          frameloop={pageVisible ? reducedMotion ? "demand" : "always" : "never"}
          dpr={[1, 1.45]}
          camera={{ position: [23, 25, 30], fov: 42, near: 0.1, far: 500 }}
          gl={{ antialias: true, powerPreference: "low-power", alpha: false }}
          fallback={fallback}
          onCreated={() => setRenderState("ready")}
          onPointerMissed={() => props.onSelect("")}
        >
          <SceneContent
            {...props}
            hoveredId={hoveredId}
            setHoveredId={setHoveredId}
            labels={labelElements}
            onContextFailure={contextFailure}
          />
        </Canvas>}
        </SceneErrorBoundary>
        {renderState === "ready" && props.turbines.filter((turbine) => turbine.id === props.selectedTurbineId || turbine.id === hoveredId).map((turbine) => {
          const result = props.results.find((item) => item.turbineId === turbine.id);
          const status = turbine.command !== "operational" ? turbine.command : result?.status;
          const label = status === "manual_stop" ? "수동 정지" : status === "maintenance_stop" ? "정비 정지" : status === "high_wind" ? "강풍 정지" : status === "low_wind" ? "저풍속 대기" : status === "operating" ? "가동" : "계산 대기";
          return <div key={turbine.id} ref={(element) => { if (element) labelElements.current.set(turbine.id, element); else labelElements.current.delete(turbine.id); }} className={`scene-turbine-label ${status === "manual_stop" || status === "maintenance_stop" ? "is-stopped" : ""}`} data-turbine-id={turbine.id} data-status={status ?? "pending"} style={{ position: "absolute", left: 0, top: 0, visibility: "hidden", pointerEvents: "none", zIndex: 4 }}><strong>{turbine.name}</strong><span>{label} · {result ? `${result.powerMW.toFixed(2)} MW` : "— MW"}</span></div>;
        })}
        <div className="scene-compass" aria-label={`풍향 ${Math.round(props.windDirectionDeg)}도, 바람이 불어오는 쪽`}>
          <span>N</span>
          <div className="scene-compass__needle" style={{ transform: `rotate(${props.windDirectionDeg}deg)` }}>
            <span />
          </div>
          <small>풍향 FROM</small>
        </div>
        <div className="scene-distance">해면 흰 눈금 <strong>500 m</strong></div>
        <div className="scene-edit-hint">
          {props.editMode ? "발전기를 끌어 위치를 옮기세요 · 카메라 회전 잠금" : "드래그: 회전 · 휠: 확대/축소 · 클릭: 선택"}
        </div>
      </div>
      <div className="scene-legend" aria-label="단지 시각화 범례">
        <span><i className="legend-swatch legend-swatch--wind" /> 바람 흐름</span>
        <span><i className="legend-swatch legend-swatch--wake" /> 정상 후류</span>
        <span><i className="legend-swatch legend-swatch--strong" /> 강한 후류 추정</span>
        <span><i className="legend-swatch legend-swatch--stopped" /> 정지/정비</span>
      </div>
    </section>
  );
}

