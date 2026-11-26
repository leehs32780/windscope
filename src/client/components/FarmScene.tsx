import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Html, OrbitControls } from "@react-three/drei";
import { useEffect, useMemo, useRef, useState } from "react";
import { Group, Plane, Quaternion, Vector3 } from "three";
import type { TurbineInput, TurbineResult, TurbineStatus } from "../../shared/domain";
import { SCENE_METERS_TO_UNITS, farmToWorld, windFlowVector, worldToFarm } from "../../shared/domain";

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
type FarmPosition = { xM: number; yM: number };
type SceneTurbine = TurbineInput & { windSpeedMps: number; windDirectionDeg: number };

function Water({ size }: { size: number }) {
  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.04, 0]} receiveShadow>
        <planeGeometry args={[size, size]} />
        <meshStandardMaterial color="#092f40" roughness={0.42} metalness={0.18} />
      </mesh>
      <gridHelper args={[size, Math.max(24, Math.round(size / 1.5)), "#206073", "#164557"]} position={[0, 0.01, 0]} />
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
  const length = lengthM * SCENE_METERS_TO_UNITS;
  const startRadius = (turbine.rotorDiameterM / 2) * SCENE_METERS_TO_UNITS;
  const endRadius = (turbine.rotorDiameterM / 2 + turbine.wakeExpansion * lengthM) * SCENE_METERS_TO_UNITS;
  const position: [number, number, number] = [
    worldX + direction.x * length * 0.5,
    hubHeight,
    worldZ + direction.z * length * 0.5
  ];
  const isStrong = turbine.thrustCoefficient >= 0.75;
  return (
    <mesh position={position} quaternion={rotation} renderOrder={1}>
      <cylinderGeometry args={[endRadius, startRadius, length, 24, 1, true]} />
      <meshStandardMaterial
        color={isStrong ? "#ee9867" : "#29c8bf"}
        transparent
        opacity={isStrong ? 0.105 : 0.07}
        depthWrite={false}
        side={2}
        roughness={0.78}
      />
    </mesh>
  );
}

function WindParticles({ windSpeedMps, windDirectionDeg }: { windSpeedMps: number; windDirectionDeg: number }) {
  const group = useRef<Group>(null);
  const flow = useMemo(() => windFlowVector(windDirectionDeg), [windDirectionDeg]);
  const flowX = flow.east;
  const flowZ = -flow.north;
  const crossX = -flowZ;
  const crossZ = flowX;
  useFrame((state) => {
    const children = group.current?.children;
    if (!children) return;
    const travelDistance = (state.clock.elapsedTime * (0.7 + windSpeedMps * 0.055)) % 30;
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]!;
      const along = ((travelDistance + index * 2.3) % 30) - 15;
      const across = ((index * 7.17) % 20) - 10;
      child.position.set(flowX * along + crossX * across, 0.19 + (index % 3) * 0.035, flowZ * along + crossZ * across);
    }
  });
  return (
    <group ref={group}>
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
  const latestPosition = useRef<FarmPosition | null>(null);
  const running = turbine.command === "operational" && (status === undefined || status === "operating");
  const scale = SCENE_METERS_TO_UNITS;
  const hubHeight = turbine.hubHeightM * scale;
  const rotorRadius = turbine.rotorDiameterM * scale * 0.5;
  const bladeLength = rotorRadius * 0.96;
  const yawRadians = (Math.atan2(Math.sin((Math.PI * turbine.windDirectionDeg) / 180), -Math.cos((Math.PI * turbine.windDirectionDeg) / 180)));
  const [worldX, worldZ] = farmToWorld(position.xM, position.yM);
  const plane = useMemo(() => new Plane(new Vector3(0, 1, 0), 0), []);
  useFrame((_state, delta) => {
    if (running && rotor.current) rotor.current.rotation.z += delta * (0.32 + Math.min(1, turbine.windSpeedMps / 15) * 0.8);
  });

  function pointToFarm(event: ThreeEvent<PointerEvent>) {
    const point = event.ray.intersectPlane(plane, new Vector3());
    if (!point) return;
    const [xM, yM] = worldToFarm(point.x, point.z);
    const next = { xM: Math.round(xM / 10) * 10, yM: Math.round(yM / 10) * 10 };
    latestPosition.current = next;
    onPreviewMove(next);
  }

  function handleDown(event: ThreeEvent<PointerEvent>) {
    event.stopPropagation();
    onSelect();
    if (!editMode) return;
    dragging.current = true;
    capturePointer(event);
    pointToFarm(event);
  }

  function handleMove(event: ThreeEvent<PointerEvent>) {
    if (!dragging.current) return;
    event.stopPropagation();
    pointToFarm(event);
  }

  function handleUp(event: ThreeEvent<PointerEvent>) {
    if (!dragging.current) return;
    event.stopPropagation();
    dragging.current = false;
    capturePointer(event, true);
    if (latestPosition.current) onCommitMove(latestPosition.current);
    latestPosition.current = null;
  }

  const bodyColor = status === "manual_stop" || status === "maintenance_stop" || turbine.command !== "operational"
    ? "#ee876b"
    : status === "high_wind" || status === "low_wind"
      ? "#e2b778"
      : "#e6f1ed";
  const label = status === "manual_stop" || turbine.command === "manual_stop"
    ? "정지"
    : status === "maintenance_stop" || turbine.command === "maintenance_stop"
      ? "정비"
      : status === "high_wind"
        ? "강풍 대기"
        : status === "low_wind"
          ? "저풍속 대기"
          : "가동";

  return (
    <group
      position={[worldX, 0, worldZ]}
      rotation={[0, yawRadians, 0]}
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      onPointerUp={handleUp}
      onPointerCancel={handleUp}
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
      <group ref={rotor} position={[0, hubHeight, 0]}>
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
      {selected && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.04, 0]}>
          <ringGeometry args={[0.72, 0.81, 40]} />
          <meshBasicMaterial color="#55e4c4" transparent opacity={0.95} side={2} />
        </mesh>
      )}
      {editMode && dragging.current && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.035, 0]}>
          <ringGeometry args={[0.88, 0.94, 36]} />
          <meshBasicMaterial color="#eab36e" transparent opacity={0.92} side={2} />
        </mesh>
      )}
      {(selected || hovered) && (
        <Html position={[0, hubHeight + rotorRadius + 0.22, 0]} center distanceFactor={12} zIndexRange={[30, 0]}>
          <div className={`scene-turbine-label ${status === "manual_stop" || status === "maintenance_stop" ? "is-stopped" : ""}`}>
            <strong>{turbine.name}</strong><span>{label}</span>
          </div>
        </Html>
      )}
    </group>
  );
}

function ViewRig({
  controlsRef,
  centerX,
  centerZ,
  span,
  fitVersion,
  resetVersion
}: {
  controlsRef: React.RefObject<ControlHandle | null>;
  centerX: number;
  centerZ: number;
  span: number;
  fitVersion: number;
  resetVersion: number;
}) {
  const { camera } = useThree();
  const viewRef = useRef({ centerX, centerZ, span });
  const lastFitVersion = useRef(fitVersion);
  viewRef.current = { centerX, centerZ, span };
  const initialRef = useRef(true);
  useEffect(() => {
    const current = viewRef.current;
    const isFit = initialRef.current || fitVersion !== lastFitVersion.current;
    const distance = Math.max(17, current.span * (isFit ? 1.03 : 0.76));
    camera.position.set(current.centerX + distance * 0.9, distance * 0.9, current.centerZ + distance * 1.08);
    camera.lookAt(current.centerX, 0, current.centerZ);
    if (controlsRef.current) {
      controlsRef.current.target.set(current.centerX, 0, current.centerZ);
      controlsRef.current.update();
    }
    initialRef.current = false;
    lastFitVersion.current = fitVersion;
  }, [camera, controlsRef, fitVersion, resetVersion]);
  return null;
}

function SceneContent(props: FarmSceneProps & { hoveredId: string | null; setHoveredId: (id: string | null) => void }) {
  const controlsRef = useRef<ControlHandle | null>(null);
  const positions = props.turbines.map((turbine) => props.previewPositions[turbine.id] ?? turbine);
  const xs = positions.map((turbine) => turbine.xM * SCENE_METERS_TO_UNITS);
  const zs = positions.map((turbine) => -turbine.yM * SCENE_METERS_TO_UNITS);
  const minX = xs.length ? Math.min(...xs) : -9;
  const maxX = xs.length ? Math.max(...xs) : 9;
  const minZ = zs.length ? Math.min(...zs) : -9;
  const maxZ = zs.length ? Math.max(...zs) : 9;
  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const layoutSpan = Math.max(maxX - minX, maxZ - minZ, 12);
  const viewSpan = Math.max(layoutSpan * 1.75, 30);
  const waterSize = viewSpan * 2.45;
  const wakeLengthM = Math.max(800, Math.min(1_600, layoutSpan / SCENE_METERS_TO_UNITS * 0.62));
  const resultById = useMemo(() => new Map(props.results.map((result) => [result.turbineId, result])), [props.results]);
  const flow = useMemo(() => windFlowVector(props.windDirectionDeg), [props.windDirectionDeg]);
  const overlayPositions = useMemo(() => new Set(props.results.filter((item) => item.status === "operating").map((item) => item.turbineId)), [props.results]);

  return (
    <>
      <color attach="background" args={["#071722"]} />
      <fog attach="fog" args={["#071722", 34, waterSize * 0.86]} />
      <ambientLight intensity={1.05} />
      <directionalLight position={[11, 18, 8]} intensity={1.85} castShadow />
      <hemisphereLight args={["#b7e2e5", "#0b2e3e", 0.52]} />
      <Water size={waterSize} />
      {props.turbines.filter((turbine) => overlayPositions.has(turbine.id)).map((turbine) => {
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
      <WindParticles windSpeedMps={props.windSpeedMps} windDirectionDeg={props.windDirectionDeg} />
      <ViewRig
        controlsRef={controlsRef}
        centerX={centerX}
        centerZ={centerZ}
        span={viewSpan}
        fitVersion={props.fitVersion}
        resetVersion={props.resetVersion}
      />
      <OrbitControls
        ref={controlsRef as never}
        makeDefault
        enabled={!props.editMode}
        target={[centerX, 0, centerZ]}
        minDistance={7}
        maxDistance={viewSpan * 2.8}
        maxPolarAngle={Math.PI * 0.48}
        enableDamping
        dampingFactor={0.08}
      />
      <arrowHelper
        args={[new Vector3(flow.east, 0, -flow.north), new Vector3(centerX - viewSpan * 0.44, 0.22, centerZ - viewSpan * 0.42), 4.2, "#88e2dc", 0.9, 0.48]}
      />
    </>
  );
}

export function FarmScene(props: FarmSceneProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const statusCounts = props.results.reduce<Record<string, number>>((counts, item) => {
    counts[item.status] = (counts[item.status] ?? 0) + 1;
    return counts;
  }, {});
  const stoppedCount = (statusCounts.manual_stop ?? 0) + (statusCounts.maintenance_stop ?? 0) + (statusCounts.high_wind ?? 0);

  return (
    <section className="scene-card" aria-label="해상풍력단지 3D 보기">
      <div className="scene-card__header">
        <div>
          <span className="eyebrow">OFFSHORE ARRAY · LIVE MODEL</span>
          <h2>단지 조감도</h2>
          <p>북쪽 0° · 시계 방향 · 화살표는 바람이 불어오는 방향을 가리킵니다.</p>
        </div>
        <div className="scene-card__conditions">
          <span><i className="condition-dot" /> {props.windSpeedMps.toFixed(1)} m/s</span>
          <span>풍향 {Math.round(props.windDirectionDeg)}°</span>
          <span className={stoppedCount > 0 ? "condition-warning" : ""}>{stoppedCount}대 정지</span>
        </div>
      </div>
      <div className="scene-canvas-wrap">
        <Canvas
          shadows
          dpr={[1, 1.45]}
          camera={{ position: [23, 25, 30], fov: 42, near: 0.1, far: 500 }}
          gl={{ antialias: true, powerPreference: "low-power", alpha: false }}
          fallback={<div className="webgl-fallback"><strong>3D 화면을 열 수 없습니다.</strong><span>아래 발전기 표와 수치는 계속 사용할 수 있습니다.</span></div>}
          onPointerMissed={() => props.onSelect("")}
        >
          <SceneContent
            {...props}
            hoveredId={hoveredId}
            setHoveredId={setHoveredId}
          />
        </Canvas>
        <div className="scene-compass" aria-label={`풍향 ${Math.round(props.windDirectionDeg)}도, 바람이 불어오는 쪽`}>
          <span>N</span>
          <div className="scene-compass__needle" style={{ transform: `rotate(${props.windDirectionDeg}deg)` }}>
            <span />
          </div>
          <small>풍향 FROM</small>
        </div>
        <div className="scene-distance">축척 기준 <strong>500 m</strong></div>
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

