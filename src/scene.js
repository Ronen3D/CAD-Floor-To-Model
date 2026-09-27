import {
  ACESFilmicToneMapping,
  AmbientLight,
  BoxGeometry,
  CanvasTexture,
  Clock,
  Color,
  DirectionalLight,
  Euler,
  Group,
  HemisphereLight,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Raycaster,
  RepeatWrapping,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export function createViewer(canvas, buildingModel, config) {
  const scene = new Scene();
  scene.background = new Color("#9cafb7");
  const events = new EventTarget();

  const eyeHeight = Math.max(0.08, Math.min(config.eyeHeightMeters, config.wallHeightMeters * 0.72));
  const startPosition = resolveStartPosition(buildingModel);
  const camera = new PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.05, 1200);
  camera.position.set(startPosition.x, eyeHeight, startPosition.z);

  const renderer = new WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;

  scene.add(new HemisphereLight("#e8f4ff", "#867363", 1.25));
  scene.add(new AmbientLight("#fff5e6", 0.24));
  const sun = new DirectionalLight("#fff2d4", 2.25);
  sun.position.set(18, 28, 9);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -45;
  sun.shadow.camera.right = 45;
  sun.shadow.camera.top = 45;
  sun.shadow.camera.bottom = -45;
  sun.shadow.bias = -0.0002;
  scene.add(sun);

  const building = new Group();
  building.name = "building";
  scene.add(building);

  const wallsGroup = new Group();
  wallsGroup.name = "walls";
  building.add(wallsGroup);

  const floorsGroup = new Group();
  floorsGroup.name = "floors";
  building.add(floorsGroup);

  const floorMeshes = [];

  const walkableWallSegments = splitWallsAtDoorOpenings(buildingModel.walls, buildingModel.doors, config);
  const wallMesh = buildWallsMesh(walkableWallSegments, config);
  if (wallMesh) {
    wallsGroup.add(wallMesh);
  }

  const wallTrim = buildWallTrim(walkableWallSegments, config);
  if (wallTrim) {
    wallsGroup.add(wallTrim);
  }

  for (const floor of buildingModel.floors) {
    const floorMesh = buildFloorMesh(floor);
    floorsGroup.add(floorMesh);
    floorMeshes.push(floorMesh);
  }

  const { group: doorsGroup, interactiveMeshes: doorMeshes, states: doorStates } = buildDoorAssemblies(
    buildingModel.doors,
    config,
  );
  building.add(doorsGroup);

  const controls = createWalkControls(camera);

  const keyboard = {
    forward: false,
    backward: false,
    strafeLeft: false,
    strafeRight: false,
    up: false,
    down: false,
    turnLeft: false,
    turnRight: false,
  };

  attachKeyboardListeners(keyboard);

  const collisionWalls = buildCollisionSegments(walkableWallSegments);
  const collisionRadius = resolveCollisionRadius(config);
  const wallCollisionRadius = collisionRadius + config.wallThicknessMeters * 0.5;
  const collisionIterations = 4;

  const modelBounds = getModelBounds(buildingModel);
  const topViewFocus = resolveTopViewFocus(modelBounds, startPosition);
  let topViewHeight = resolveTopViewHeight(modelBounds, camera, config);
  const orbitControls = new OrbitControls(camera, renderer.domElement);
  orbitControls.enabled = false;
  orbitControls.enableDamping = true;
  orbitControls.dampingFactor = 0.08;
  orbitControls.enablePan = true;
  orbitControls.minDistance = Math.max(config.wallHeightMeters * 3, 2);
  orbitControls.maxDistance = Math.max(topViewHeight * 3, 20);
  orbitControls.maxPolarAngle = Math.PI * 0.495;
  orbitControls.target.set(topViewFocus.x, 0, topViewFocus.z);
  orbitControls.update();
  const savedWalkPosition = new Vector3();
  const savedWalkQuaternion = new Quaternion();
  const transitionTargetPosition = new Vector3();
  const transitionTargetQuaternion = new Quaternion();
  const lookTarget = new Vector3();
  const lookMatrix = new Matrix4();
  const cameraTransition = {
    active: false,
    elapsed: 0,
    duration: 0.7,
    startPosition: new Vector3(),
    startQuaternion: new Quaternion(),
    targetPosition: new Vector3(),
    targetQuaternion: new Quaternion(),
    onComplete: null,
  };
  const pickRay = new Raycaster();
  const pointerNdc = new Vector2();
  let topViewActive = false;

  const velocity = new Vector3();
  const direction = new Vector3();
  const forward = new Vector3();
  const right = new Vector3();
  const levelLookDirection = new Vector3();
  const up = new Vector3(0, 1, 0);
  const proposedPosition = new Vector3();
  const lookState = createLookState(camera);
  const clock = new Clock();
  const walkSpeed = 3.8;
  const turnSpeed = Math.PI * 0.75;
  const dragLookSensitivity = 0.0022;
  const maxPitch = Math.PI * 0.49;
  const dragState = {
    isDown: false,
    dragWalkLook: false,
    moved: false,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    suppressClick: false,
  };

  resolveCameraCollision(controls.object.position, collisionWalls, doorStates, wallCollisionRadius, collisionIterations);

  function emitModeChange() {
    events.dispatchEvent(new CustomEvent("modechange", { detail: { topViewActive } }));
  }

  function enterTopView(options = {}) {
    if (topViewActive) {
      return;
    }

    const { immediate = false, fitToModel = true } = options;

    topViewActive = true;
    savedWalkPosition.copy(controls.object.position);
    savedWalkQuaternion.copy(camera.quaternion);

    if (fitToModel) {
      topViewHeight = resolveTopViewHeight(modelBounds, camera, config);
      orbitControls.maxDistance = Math.max(topViewHeight * 3, 20);
    }

    setTopViewCameraPose(transitionTargetPosition, topViewFocus, topViewHeight);
    lookTarget.set(topViewFocus.x, 0, topViewFocus.z);
    setCameraLookQuaternion(transitionTargetPosition, lookTarget, transitionTargetQuaternion);

    const activateTopViewOrbit = () => {
      orbitControls.target.set(topViewFocus.x, 0, topViewFocus.z);
      orbitControls.enabled = true;
      orbitControls.update();
    };

    if (immediate) {
      cameraTransition.active = false;
      cameraTransition.onComplete = null;
      controls.object.position.copy(transitionTargetPosition);
      camera.quaternion.copy(transitionTargetQuaternion);
      activateTopViewOrbit();
    } else {
      startCameraTransition(transitionTargetPosition, transitionTargetQuaternion, activateTopViewOrbit);
    }

    emitModeChange();
  }

  function exitTopView(options = {}) {
    if (!topViewActive) {
      return;
    }

    const { restoreWalkPose = true, levelWalkView = false } = options;
    topViewActive = false;
    orbitControls.enabled = false;

    if (restoreWalkPose) {
      transitionTargetPosition.copy(savedWalkPosition);
    } else {
      transitionTargetPosition.copy(controls.object.position);
    }

    if (levelWalkView) {
      setLevelWalkQuaternion(transitionTargetPosition, savedWalkQuaternion, transitionTargetQuaternion);
    } else {
      transitionTargetQuaternion.copy(savedWalkQuaternion);
    }

    startCameraTransition(transitionTargetPosition, transitionTargetQuaternion);
    emitModeChange();
  }

  function isTopViewActive() {
    return topViewActive;
  }

  function pickFloorAndEnterWalk(event) {
    if (!topViewActive || cameraTransition.active || floorMeshes.length === 0) {
      return;
    }

    const rect = renderer.domElement.getBoundingClientRect();
    pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    pickRay.setFromCamera(pointerNdc, camera);
    const hits = pickRay.intersectObjects(floorMeshes, false);
    if (hits.length === 0) {
      return;
    }

    const hit = hits[0].point;
    proposedPosition.set(hit.x, eyeHeight, hit.z);
    resolveCameraCollision(proposedPosition, collisionWalls, doorStates, wallCollisionRadius, collisionIterations);
    controls.object.position.copy(proposedPosition);

    events.dispatchEvent(
      new CustomEvent("teleport", {
        detail: {
          x: proposedPosition.x,
          z: proposedPosition.z,
        },
      }),
    );

    exitTopView({ restoreWalkPose: false, levelWalkView: true });
  }

  function openDoorAtPointer(event) {
    if (topViewActive || cameraTransition.active || doorMeshes.length === 0) {
      return;
    }

    const rect = renderer.domElement.getBoundingClientRect();
    pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    pickRay.setFromCamera(pointerNdc, camera);
    const hit = pickRay.intersectObjects(doorMeshes, false)[0];
    if (hit) {
      hit.object.userData.doorState.opening = true;
    }
  }

  function handleCanvasClick(event) {
    if (consumeSuppressedClick()) {
      return;
    }

    if (topViewActive) {
      pickFloorAndEnterWalk(event);
      return;
    }

    openDoorAtPointer(event);
  }

  function setLevelWalkQuaternion(position, sourceQuaternion, targetQuaternion) {
    levelLookDirection.set(0, 0, -1).applyQuaternion(sourceQuaternion);
    levelLookDirection.y = 0;

    if (levelLookDirection.lengthSq() < 1e-6) {
      levelLookDirection.set(0, 0, -1);
    } else {
      levelLookDirection.normalize();
    }

    lookTarget.copy(position).add(levelLookDirection);
    setCameraLookQuaternion(position, lookTarget, targetQuaternion);
  }

  function setCameraLookQuaternion(position, target, targetQuaternion) {
    lookMatrix.lookAt(position, target, up);
    targetQuaternion.setFromRotationMatrix(lookMatrix);
  }

  function startCameraTransition(targetPosition, targetQuaternion, onComplete) {
    cameraTransition.active = true;
    cameraTransition.elapsed = 0;
    cameraTransition.startPosition.copy(controls.object.position);
    cameraTransition.startQuaternion.copy(camera.quaternion);
    cameraTransition.targetPosition.copy(targetPosition);
    cameraTransition.targetQuaternion.copy(targetQuaternion);
    cameraTransition.onComplete = onComplete;
  }

  function updateCameraTransition(dt) {
    cameraTransition.elapsed = Math.min(cameraTransition.elapsed + dt, cameraTransition.duration);
    const progress = cameraTransition.elapsed / cameraTransition.duration;
    const easedProgress = progress < 0.5 ? 2 * progress * progress : 1 - (-2 * progress + 2) ** 2 / 2;

    controls.object.position.lerpVectors(
      cameraTransition.startPosition,
      cameraTransition.targetPosition,
      easedProgress,
    );
    camera.quaternion.slerpQuaternions(
      cameraTransition.startQuaternion,
      cameraTransition.targetQuaternion,
      easedProgress,
    );

    if (progress === 1) {
      controls.object.position.copy(cameraTransition.targetPosition);
      camera.quaternion.copy(cameraTransition.targetQuaternion);
      cameraTransition.active = false;

      const onComplete = cameraTransition.onComplete;
      cameraTransition.onComplete = null;
      onComplete?.();

      if (!topViewActive) {
        syncLookState(lookState, camera);
      }
    }
  }

  function onMouseDown(event) {
    if (event.button !== 0) {
      return;
    }

    dragState.isDown = true;
    dragState.moved = false;
    dragState.startX = event.clientX;
    dragState.startY = event.clientY;
    dragState.lastX = event.clientX;
    dragState.lastY = event.clientY;
    dragState.dragWalkLook = !topViewActive && !cameraTransition.active;
  }

  function onMouseMove(event) {
    if (!dragState.isDown) {
      return;
    }

    const dx = event.clientX - dragState.lastX;
    const dy = event.clientY - dragState.lastY;
    dragState.lastX = event.clientX;
    dragState.lastY = event.clientY;

    const movedDistance = Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY);
    if (movedDistance > 3) {
      dragState.moved = true;
    }

    if (!dragState.dragWalkLook || topViewActive || cameraTransition.active) {
      return;
    }

    lookState.yaw -= dx * dragLookSensitivity;
    lookState.pitch = clamp(lookState.pitch - dy * dragLookSensitivity, -maxPitch, maxPitch);
    applyLookState(camera, lookState);
  }

  function onMouseUp(event) {
    if (event.button !== 0) {
      return;
    }

    if (dragState.isDown && dragState.moved) {
      dragState.suppressClick = true;
    }

    dragState.isDown = false;
    dragState.dragWalkLook = false;
  }

  function cancelMouseDrag() {
    dragState.isDown = false;
    dragState.dragWalkLook = false;
  }

  function consumeSuppressedClick() {
    if (!dragState.suppressClick) {
      return false;
    }

    dragState.suppressClick = false;
    return true;
  }

  renderer.domElement.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);
  window.addEventListener("blur", cancelMouseDrag);
  renderer.domElement.addEventListener("click", handleCanvasClick);

  emitModeChange();

  function animate() {
    const dt = Math.min(clock.getDelta(), 0.033);
    const walkModeActive = !topViewActive && !cameraTransition.active;

    if (walkModeActive) {
      let turned = false;
      if (keyboard.turnLeft) {
        lookState.yaw += turnSpeed * dt;
        turned = true;
      }
      if (keyboard.turnRight) {
        lookState.yaw -= turnSpeed * dt;
        turned = true;
      }

      if (turned) {
        applyLookState(camera, lookState);
      }
    }

    direction.set(0, 0, 0);
    if (keyboard.forward) direction.z -= 1;
    if (keyboard.backward) direction.z += 1;
    if (keyboard.strafeLeft) direction.x -= 1;
    if (keyboard.strafeRight) direction.x += 1;
    if (keyboard.up) direction.y += 1;
    if (keyboard.down) direction.y -= 1;

    updateDoorAnimations(doorStates, dt);

    if (cameraTransition.active) {
      updateCameraTransition(dt);
    } else if (topViewActive) {
      orbitControls.update();
    } else if (direction.lengthSq() > 0) {
      direction.normalize();
      controls.object.getWorldDirection(forward);
      forward.y = 0;
      forward.normalize();
      right.crossVectors(forward, up).normalize();

      proposedPosition.copy(controls.object.position);

      velocity.copy(right).multiplyScalar(direction.x * walkSpeed * dt);
      proposedPosition.add(velocity);

      velocity.copy(forward).multiplyScalar(direction.z * walkSpeed * dt);
      proposedPosition.add(velocity);

      resolveCameraCollision(proposedPosition, collisionWalls, doorStates, wallCollisionRadius, collisionIterations);
      controls.object.position.x = proposedPosition.x;
      controls.object.position.z = proposedPosition.z;

      controls.object.position.y += direction.y * walkSpeed * dt;
    }

    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }

  animate();

  function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);

    if (topViewActive) {
      orbitControls.update();
    }
  }

  window.addEventListener("resize", onResize);

  return {
    renderer,
    scene,
    camera,
    controls,
    orbitControls,
    events,
    enterTopView,
    exitTopView,
    isTopViewActive,
  };
}

function setTopViewCameraPose(position, focus, height) {
  position.set(focus.x, height, focus.z);
}

function resolveStartPosition(buildingModel) {
  if (buildingModel.spawnPoint) {
    return { x: buildingModel.spawnPoint.x, z: buildingModel.spawnPoint.y };
  }

  const mainFloor = buildingModel.floors?.[0];
  if (mainFloor) {
    return {
      x: (mainFloor.min.x + mainFloor.max.x) / 2,
      z: (mainFloor.min.y + mainFloor.max.y) / 2,
    };
  }

  return { x: 0, z: 8 };
}

function resolveTopViewFocus(bounds, fallbackStartPosition) {
  if (!bounds) {
    return { x: fallbackStartPosition.x, z: fallbackStartPosition.z };
  }

  return {
    x: (bounds.minX + bounds.maxX) / 2,
    z: (bounds.minZ + bounds.maxZ) / 2,
  };
}

function resolveTopViewHeight(bounds, camera, config) {
  if (!bounds) {
    return Math.max(config.wallHeightMeters * 8, 10);
  }

  const spanX = Math.max(bounds.maxX - bounds.minX, 1);
  const spanZ = Math.max(bounds.maxZ - bounds.minZ, 1);
  const margin = 1.12;
  const halfWidth = (spanX * margin) / 2;
  const halfDepth = (spanZ * margin) / 2;

  const verticalFov = (camera.fov * Math.PI) / 180;
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * Math.max(camera.aspect, 0.1));

  const heightForDepth = halfDepth / Math.tan(verticalFov / 2);
  const heightForWidth = halfWidth / Math.tan(horizontalFov / 2);

  return Math.max(config.wallHeightMeters * 8, heightForDepth, heightForWidth);
}

function getModelBounds(buildingModel) {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;

  for (const floor of buildingModel.floors ?? []) {
    minX = Math.min(minX, floor.min.x);
    minZ = Math.min(minZ, floor.min.y);
    maxX = Math.max(maxX, floor.max.x);
    maxZ = Math.max(maxZ, floor.max.y);
  }

  for (const wall of buildingModel.walls ?? []) {
    minX = Math.min(minX, wall.start.x, wall.end.x);
    minZ = Math.min(minZ, wall.start.y, wall.end.y);
    maxX = Math.max(maxX, wall.start.x, wall.end.x);
    maxZ = Math.max(maxZ, wall.start.y, wall.end.y);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minZ) || !Number.isFinite(maxX) || !Number.isFinite(maxZ)) {
    return null;
  }

  return { minX, minZ, maxX, maxZ };
}

function splitWallsAtDoorOpenings(walls, doors, config) {
  const splitWalls = [];
  const minimumSegmentLength = 0.02;
  const maximumDoorOffset = Math.max(config.wallThicknessMeters * 1.5, 0.12);

  for (const wall of walls) {
    const dx = wall.end.x - wall.start.x;
    const dz = wall.end.y - wall.start.y;
    const length = Math.hypot(dx, dz);
    if (length < minimumSegmentLength) {
      continue;
    }

    const directionX = dx / length;
    const directionZ = dz / length;
    const openingRanges = [];

    for (const door of doors) {
      const doorAxisX = Math.cos(door.rotation);
      const doorAxisZ = -Math.sin(door.rotation);
      const alignment = Math.abs(directionX * doorAxisX + directionZ * doorAxisZ);
      if (alignment < 0.7) {
        continue;
      }

      const offsetX = door.center.x - wall.start.x;
      const offsetZ = door.center.y - wall.start.y;
      const distanceAlongWall = offsetX * directionX + offsetZ * directionZ;
      const distanceFromWall = Math.abs(offsetX * -directionZ + offsetZ * directionX);
      const openingHalfWidth = door.width / 2 + config.wallThicknessMeters * 0.25;

      if (
        distanceFromWall > maximumDoorOffset ||
        distanceAlongWall + openingHalfWidth <= 0 ||
        distanceAlongWall - openingHalfWidth >= length
      ) {
        continue;
      }

      openingRanges.push({
        start: clamp((distanceAlongWall - openingHalfWidth) / length, 0, 1),
        end: clamp((distanceAlongWall + openingHalfWidth) / length, 0, 1),
      });
    }

    if (openingRanges.length === 0) {
      splitWalls.push(wall);
      continue;
    }

    openingRanges.sort((first, second) => first.start - second.start);
    let segmentStart = 0;

    for (const opening of openingRanges) {
      if (opening.start > segmentStart) {
        addWallSegment(wall, segmentStart, opening.start, splitWalls, minimumSegmentLength);
      }
      segmentStart = Math.max(segmentStart, opening.end);
    }

    if (segmentStart < 1) {
      addWallSegment(wall, segmentStart, 1, splitWalls, minimumSegmentLength);
    }
  }

  return splitWalls;
}

function addWallSegment(wall, startT, endT, segments, minimumSegmentLength) {
  const dx = wall.end.x - wall.start.x;
  const dz = wall.end.y - wall.start.y;
  const length = Math.hypot(dx, dz) * (endT - startT);
  if (length < minimumSegmentLength) {
    return;
  }

  segments.push({
    ...wall,
    start: new Vector2(wall.start.x + dx * startT, wall.start.y + dz * startT),
    end: new Vector2(wall.start.x + dx * endT, wall.start.y + dz * endT),
  });
}

function buildCollisionSegments(walls) {
  const segments = [];

  for (const wall of walls) {
    const ax = wall.start.x;
    const az = wall.start.y;
    const dx = wall.end.x - ax;
    const dz = wall.end.y - az;
    const lengthSq = dx * dx + dz * dz;

    if (lengthSq < 1e-8) {
      continue;
    }

    segments.push({ ax, az, dx, dz, lengthSq });
  }

  return segments;
}

function resolveCollisionRadius(config) {
  if (typeof config.collisionRadiusMeters === "number" && config.collisionRadiusMeters > 0) {
    return config.collisionRadiusMeters;
  }

  return Math.max(0.02, config.wallThicknessMeters * 1.5);
}

function resolveCameraCollision(position, wallSegments, doorStates, collisionRadius, iterations) {
  if ((wallSegments.length === 0 && doorStates.length === 0) || collisionRadius <= 0) {
    return;
  }

  let px = position.x;
  let pz = position.z;
  const radiusSq = collisionRadius * collisionRadius;
  const epsilon = 1e-4;

  for (let iter = 0; iter < iterations; iter += 1) {
    let corrected = false;

    for (const segments of [wallSegments, doorStates]) {
      for (const segment of segments) {
        if (segment.openProgress >= 0.99) {
          continue;
        }

        const tRaw = ((px - segment.ax) * segment.dx + (pz - segment.az) * segment.dz) / segment.lengthSq;
        const t = clamp(tRaw, 0, 1);
        const closestX = segment.ax + segment.dx * t;
        const closestZ = segment.az + segment.dz * t;

        let normalX = px - closestX;
        let normalZ = pz - closestZ;
        const distSq = normalX * normalX + normalZ * normalZ;

        if (distSq >= radiusSq) {
          continue;
        }

        let dist = Math.sqrt(distSq);
        if (dist > 1e-8) {
          normalX /= dist;
          normalZ /= dist;
        } else {
          const invLen = 1 / Math.sqrt(segment.lengthSq);
          normalX = -segment.dz * invLen;
          normalZ = segment.dx * invLen;
          dist = 0;
        }

        const pushDistance = collisionRadius - dist + epsilon;
        px += normalX * pushDistance;
        pz += normalZ * pushDistance;
        corrected = true;
      }
    }

    if (!corrected) {
      break;
    }
  }

  position.x = px;
  position.z = pz;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function createWalkControls(camera) {
  const events = new EventTarget();

  return {
    object: camera,
    lock: () => {
      events.dispatchEvent(new Event("lock"));
    },
    unlock: () => {
      events.dispatchEvent(new Event("unlock"));
    },
    addEventListener: (...args) => events.addEventListener(...args),
    removeEventListener: (...args) => events.removeEventListener(...args),
  };
}

function createLookState(camera) {
  const euler = new Euler().setFromQuaternion(camera.quaternion, "YXZ");
  return {
    yaw: euler.y,
    pitch: euler.x,
  };
}

function syncLookState(lookState, camera) {
  const euler = new Euler().setFromQuaternion(camera.quaternion, "YXZ");
  lookState.yaw = euler.y;
  lookState.pitch = euler.x;
}

function applyLookState(camera, lookState) {
  const euler = new Euler(lookState.pitch, lookState.yaw, 0, "YXZ");
  camera.quaternion.setFromEuler(euler);
}

function buildWallsMesh(walls, config) {
  if (walls.length === 0) {
    return null;
  }

  const wallGeometries = [];
  const minLength = 0.02;

  for (const wall of walls) {
    const dx = wall.end.x - wall.start.x;
    const dz = wall.end.y - wall.start.y;
    const length = Math.hypot(dx, dz);
    if (length < minLength) {
      continue;
    }

    const geometry = new BoxGeometry(length, config.wallHeightMeters, config.wallThicknessMeters);
    const angle = Math.atan2(dz, dx);

    const centerX = (wall.start.x + wall.end.x) / 2;
    const centerZ = (wall.start.y + wall.end.y) / 2;

    geometry.rotateY(-angle);
    geometry.translate(centerX, config.wallHeightMeters / 2, centerZ);

    wallGeometries.push(geometry);
  }

  if (wallGeometries.length === 0) {
    return null;
  }

  const merged = mergeGeometries(wallGeometries, false);
  const material = createWallMaterial();

  const mesh = new Mesh(merged, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  wallGeometries.forEach((geometry) => geometry.dispose());

  return mesh;
}

function buildWallTrim(walls, config) {
  const crownGeometry = buildWallStripGeometry(walls, config, {
    height: 0.12,
    centerHeight: config.wallHeightMeters - 0.08,
    depth: config.wallThicknessMeters + 0.1,
  });
  const capGeometry = buildWallStripGeometry(walls, config, {
    height: 0.035,
    centerHeight: config.wallHeightMeters - 0.01,
    depth: config.wallThicknessMeters + 0.16,
  });
  const baseGeometry = buildWallStripGeometry(walls, config, {
    height: 0.09,
    centerHeight: 0.045,
    depth: config.wallThicknessMeters + 0.045,
  });

  if (!crownGeometry && !capGeometry && !baseGeometry) {
    return null;
  }

  const trimGroup = new Group();
  const crownMaterial = new MeshStandardMaterial({
    color: "#f8f5ed",
    roughness: 0.58,
    metalness: 0.01,
  });
  const capMaterial = new MeshStandardMaterial({
    color: "#e3d7c5",
    roughness: 0.42,
    metalness: 0.03,
  });
  const baseMaterial = new MeshStandardMaterial({
    color: "#b5aa9b",
    roughness: 0.48,
    metalness: 0.02,
  });

  if (crownGeometry) {
    const crown = new Mesh(crownGeometry, crownMaterial);
    crown.castShadow = true;
    crown.receiveShadow = true;
    trimGroup.add(crown);
  }

  if (capGeometry) {
    const cap = new Mesh(capGeometry, capMaterial);
    cap.castShadow = true;
    cap.receiveShadow = true;
    trimGroup.add(cap);
  }

  if (baseGeometry) {
    const baseboard = new Mesh(baseGeometry, baseMaterial);
    baseboard.castShadow = true;
    baseboard.receiveShadow = true;
    trimGroup.add(baseboard);
  }

  return trimGroup;
}

function buildWallStripGeometry(walls, config, dimensions) {
  const geometries = [];

  for (const wall of walls) {
    const deltaX = wall.end.x - wall.start.x;
    const deltaZ = wall.end.y - wall.start.y;
    const length = Math.hypot(deltaX, deltaZ);
    if (length < 0.02) {
      continue;
    }

    const centerX = (wall.start.x + wall.end.x) / 2;
    const centerZ = (wall.start.y + wall.end.y) / 2;
    const angle = Math.atan2(deltaZ, deltaX);
    const geometry = new BoxGeometry(length, dimensions.height, dimensions.depth);
    geometry.rotateY(-angle);
    geometry.translate(centerX, dimensions.centerHeight, centerZ);
    geometries.push(geometry);
  }

  if (geometries.length === 0) {
    return null;
  }

  const merged = mergeGeometries(geometries, false);
  geometries.forEach((geometry) => geometry.dispose());
  return merged;
}

function buildFloorMesh(floorBounds) {
  const width = floorBounds.max.x - floorBounds.min.x;
  const depth = floorBounds.max.y - floorBounds.min.y;

  const geometry = new PlaneGeometry(width, depth);
  geometry.rotateX(-Math.PI / 2);

  const centerX = (floorBounds.min.x + floorBounds.max.x) / 2;
  const centerZ = (floorBounds.min.y + floorBounds.max.y) / 2;
  geometry.translate(centerX, 0, centerZ);

  const material = createFloorMaterial(width, depth);

  const floor = new Mesh(geometry, material);
  floor.receiveShadow = true;
  return floor;
}

function buildDoorAssemblies(doors, config) {
  const doorsGroup = new Group();
  doorsGroup.name = "doors";
  const interactiveMeshes = [];
  const states = [];

  const woodMaterial = createWoodMaterial();
  const metalMaterial = new MeshStandardMaterial({
    color: "#2c4b58",
    roughness: 0.3,
    metalness: 0.72,
  });
  const frameMaterial = new MeshStandardMaterial({
    color: "#eee6d9",
    roughness: 0.48,
    metalness: 0.03,
  });
  const handleMaterial = new MeshStandardMaterial({
    color: "#c5a35c",
    roughness: 0.24,
    metalness: 0.88,
  });
  const closureMaterial = createWallMaterial();

  for (const door of doors) {
    const doorGroup = new Group();
    doorGroup.position.set(door.center.x, 0, door.center.y);
    doorGroup.rotation.y = door.rotation;
    doorGroup.name = door.sourceName || "door";

    const jambWidth = 0.07;
    const frameDepth = config.wallThicknessMeters + 0.12;
    const doorDepth = config.wallThicknessMeters + 0.026;
    const openingWidth = Math.max(0.55, door.width);
    const doorHeight = Math.min(config.doorHeightMeters, config.wallHeightMeters - 0.12);
    const leafMaterial = door.material === "metal" ? metalMaterial : woodMaterial;
    const doorState = createDoorState(door, openingWidth);

    addDoorPart(doorGroup, jambWidth, doorHeight + 0.16, frameDepth, -(openingWidth + jambWidth) / 2, (doorHeight + 0.16) / 2, 0, frameMaterial);
    addDoorPart(doorGroup, jambWidth, doorHeight + 0.16, frameDepth, (openingWidth + jambWidth) / 2, (doorHeight + 0.16) / 2, 0, frameMaterial);
    addDoorPart(doorGroup, openingWidth + jambWidth * 2, 0.1, frameDepth + 0.02, 0, doorHeight + 0.05, 0, frameMaterial);

    const closureHeight = Math.max(0.04, config.wallHeightMeters - doorHeight - 0.1);
    addDoorPart(
      doorGroup,
      openingWidth,
      closureHeight,
      doorDepth,
      0,
      doorHeight + 0.1 + closureHeight / 2,
      0,
      closureMaterial,
    );

    if (door.isDouble) {
      const leafGap = 0.025;
      const leafWidth = (openingWidth - leafGap) / 2;
      interactiveMeshes.push(
        addDoorLeaf(
          doorGroup,
          doorState,
          leafWidth,
          doorHeight - 0.03,
          doorDepth,
          -openingWidth / 2,
          leafWidth / 2,
          Math.PI / 2,
          leafMaterial,
          handleMaterial,
        ),
      );
      interactiveMeshes.push(
        addDoorLeaf(
          doorGroup,
          doorState,
          leafWidth,
          doorHeight - 0.03,
          doorDepth,
          openingWidth / 2,
          -leafWidth / 2,
          -Math.PI / 2,
          leafMaterial,
          handleMaterial,
        ),
      );
    } else {
      interactiveMeshes.push(
        addDoorLeaf(
          doorGroup,
          doorState,
          openingWidth - 0.025,
          doorHeight - 0.03,
          doorDepth,
          -openingWidth / 2,
          (openingWidth - 0.025) / 2,
          Math.PI / 2,
          leafMaterial,
          handleMaterial,
        ),
      );
    }

    states.push(doorState);
    doorsGroup.add(doorGroup);
  }

  return { group: doorsGroup, interactiveMeshes, states };
}

function createDoorState(door, openingWidth) {
  const axisX = Math.cos(door.rotation);
  const axisZ = -Math.sin(door.rotation);
  const halfWidth = openingWidth / 2;

  return {
    ax: door.center.x - axisX * halfWidth,
    az: door.center.y - axisZ * halfWidth,
    dx: axisX * openingWidth,
    dz: axisZ * openingWidth,
    lengthSq: openingWidth * openingWidth,
    leaves: [],
    opening: false,
    openProgress: 0,
  };
}

function addDoorLeaf(
  doorGroup,
  doorState,
  width,
  height,
  depth,
  hingeX,
  leafCenterX,
  openAngle,
  material,
  handleMaterial,
) {
  const pivot = new Group();
  pivot.position.set(hingeX, 0, 0);
  doorGroup.add(pivot);

  const leaf = addDoorPart(pivot, width, height, depth, leafCenterX, height / 2, 0, material);
  leaf.userData.doorState = doorState;
  doorState.leaves.push({ pivot, openAngle });

  const handleX = leafCenterX < 0 ? -width * 0.76 : width * 0.76;
  addDoorHandle(pivot, handleX, height * 0.5, depth, handleMaterial);

  return leaf;
}

function updateDoorAnimations(doorStates, dt) {
  for (const doorState of doorStates) {
    if (!doorState.opening || doorState.openProgress === 1) {
      continue;
    }

    doorState.openProgress = Math.min(doorState.openProgress + dt / 0.45, 1);
    const progress = 1 - (1 - doorState.openProgress) ** 3;

    for (const leaf of doorState.leaves) {
      leaf.pivot.rotation.y = leaf.openAngle * progress;
    }
  }
}

function addDoorPart(group, width, height, depth, centerX, centerY, centerZ, material) {
  const mesh = new Mesh(new BoxGeometry(width, height, depth), material);
  mesh.position.set(centerX, centerY, centerZ);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

function addDoorHandle(group, centerX, centerY, doorDepth, material) {
  const handleLength = 0.16;
  const handleDepth = 0.035;

  addDoorPart(group, handleLength, 0.028, handleDepth, centerX, centerY, doorDepth / 2 + handleDepth / 2, material);
  addDoorPart(group, handleLength, 0.028, handleDepth, centerX, centerY, -(doorDepth / 2 + handleDepth / 2), material);
}

function createWallMaterial() {
  const texture = createWallTexture();
  return new MeshStandardMaterial({
    color: "#ffffff",
    map: texture,
    roughness: 0.78,
    metalness: 0.01,
  });
}

function createFloorMaterial(width, depth) {
  const texture = createFloorTexture();
  texture.repeat.set(Math.max(1, width / 1.8), Math.max(1, depth / 1.8));

  return new MeshStandardMaterial({
    color: "#ffffff",
    map: texture,
    roughness: 0.7,
    metalness: 0.04,
  });
}

function createWoodMaterial() {
  const texture = createWoodTexture();
  return new MeshStandardMaterial({
    color: "#ffffff",
    map: texture,
    roughness: 0.54,
    metalness: 0.02,
  });
}

function createWallTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext("2d");
  context.fillStyle = "#eeeae1";
  context.fillRect(0, 0, canvas.width, canvas.height);

  const random = createSeededRandom(9087);
  for (let index = 0; index < 850; index += 1) {
    const shade = 218 + Math.floor(random() * 22);
    context.fillStyle = `rgba(${shade}, ${shade - 3}, ${shade - 9}, ${0.025 + random() * 0.05})`;
    context.fillRect(random() * canvas.width, random() * canvas.height, 1 + random() * 2, 1 + random() * 2);
  }

  for (let row = 0; row < 7; row += 1) {
    context.fillStyle = "rgba(144, 132, 113, 0.035)";
    context.fillRect(0, row * 42 + random() * 8, canvas.width, 1);
  }

  return finishTexture(canvas, 2.5, 2.5);
}

function createFloorTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 480;
  canvas.height = 480;
  const context = canvas.getContext("2d");
  const tileSize = 120;
  const random = createSeededRandom(1218);

  context.fillStyle = "#9f9689";
  context.fillRect(0, 0, canvas.width, canvas.height);

  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      const brightness = 194 + Math.floor(random() * 18);
      context.fillStyle = `rgb(${brightness}, ${brightness - 7}, ${brightness - 16})`;
      context.fillRect(column * tileSize + 2, row * tileSize + 2, tileSize - 4, tileSize - 4);

      context.fillStyle = "rgba(111, 100, 87, 0.08)";
      for (let speckle = 0; speckle < 85; speckle += 1) {
        context.fillRect(column * tileSize + random() * tileSize, row * tileSize + random() * tileSize, 1, 1);
      }
    }
  }

  return finishTexture(canvas, 1, 1);
}

function createWoodTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext("2d");
  const random = createSeededRandom(4361);

  context.fillStyle = "#9a6741";
  context.fillRect(0, 0, canvas.width, canvas.height);

  for (let stripe = 0; stripe < 64; stripe += 1) {
    const xPosition = stripe * 4;
    context.fillStyle = stripe % 3 === 0 ? "rgba(72, 37, 20, 0.24)" : "rgba(224, 170, 110, 0.12)";
    context.fillRect(xPosition, 0, 1 + random() * 2, canvas.height);
  }

  for (let grain = 0; grain < 46; grain += 1) {
    const yPosition = random() * canvas.height;
    context.strokeStyle = "rgba(67, 35, 20, 0.22)";
    context.lineWidth = 0.45 + random();
    context.beginPath();
    context.moveTo(0, yPosition);
    context.bezierCurveTo(64, yPosition - 8 + random() * 16, 154, yPosition - 8 + random() * 16, canvas.width, yPosition);
    context.stroke();
  }

  return finishTexture(canvas, 2.2, 1.2);
}

function finishTexture(canvas, repeatX, repeatY) {
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.repeat.set(repeatX, repeatY);
  return texture;
}

function createSeededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function attachKeyboardListeners(keyboard) {
  const keyDownMap = {
    KeyW: "backward",
    KeyS: "forward",
    KeyA: "strafeLeft",
    KeyD: "strafeRight",
    ArrowUp: "backward",
    ArrowDown: "forward",
    ArrowLeft: "turnLeft",
    ArrowRight: "turnRight",
    Space: "up",
    ShiftLeft: "down",
    ShiftRight: "down",
  };

  window.addEventListener("keydown", (event) => {
    const action = keyDownMap[event.code];
    if (action) {
      event.preventDefault();
      keyboard[action] = true;
    }
  });

  window.addEventListener("keyup", (event) => {
    const action = keyDownMap[event.code];
    if (action) {
      event.preventDefault();
      keyboard[action] = false;
    }
  });
}
