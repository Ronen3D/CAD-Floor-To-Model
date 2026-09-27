import "./styles.css";

import { Vector3 } from "three";
import { CONFIG } from "./config.js";
import { buildArchitecturalModel } from "./architecturalModel.js";
import { formatStats, loadDxfDocument } from "./dxfLoader.js";
import { createViewer } from "./scene.js";

async function boot() {
  const statsElement = document.getElementById("stats");
  const button = document.getElementById("enter-btn");
  const topViewButton = document.getElementById("top-view-btn");
  const hud = document.getElementById("hud");
  const hudToggleButton = document.getElementById("toggle-hud-btn");
  const canvas = document.getElementById("viewport");
  const miniMapElement = document.getElementById("minimap");

  let isHudHidden = true;

  hud.classList.toggle("is-hidden", isHudHidden);
  hudToggleButton.textContent = "Show panel";
  hudToggleButton.setAttribute("aria-expanded", "false");

  hudToggleButton.addEventListener("click", () => {
    isHudHidden = !isHudHidden;
    hud.classList.toggle("is-hidden", isHudHidden);
    hudToggleButton.textContent = isHudHidden ? "Show panel" : "Hide panel";
    hudToggleButton.setAttribute("aria-expanded", String(!isHudHidden));
  });

  try {
    const { document: dxfDoc, layerStats } = await loadDxfDocument(CONFIG.dxfPath);
    const model = buildArchitecturalModel(dxfDoc, CONFIG);

    statsElement.textContent = [
      formatStats(layerStats),
      "",
      `Walls extracted: ${model.meta.wallCount}`,
      `Floor points: ${model.meta.floorPointCount}`,
    ].join("\n");

    const viewer = createViewer(canvas, model, CONFIG);
    const miniMap = createMiniMap(miniMapElement, model, viewer.camera);
    miniMap.setVisible(!viewer.isTopViewActive());

    button.textContent = "Walk mode active";
    button.disabled = true;

    topViewButton.addEventListener("click", () => {
      if (viewer.isTopViewActive()) {
        viewer.exitTopView();
        return;
      }

      viewer.enterTopView();
    });

    button.addEventListener("click", () => {
      if (viewer.isTopViewActive()) {
        viewer.exitTopView({ restoreWalkPose: false, levelWalkView: true });
      }
    });

    viewer.events.addEventListener("modechange", (event) => {
      const topViewActive = Boolean(event.detail?.topViewActive);
      miniMap.setVisible(!topViewActive);
      topViewButton.classList.toggle("is-active", topViewActive);
      topViewButton.setAttribute("aria-pressed", String(topViewActive));
      topViewButton.textContent = topViewActive ? "Top view: click floor to walk" : "Top view";

      button.disabled = !topViewActive;
      button.textContent = topViewActive ? "Return to walk mode" : "Walk mode active";
    });

    viewer.enterTopView({ immediate: true, fitToModel: true });
  } catch (error) {
    console.error(error);
    statsElement.textContent = `Failed to build model: ${error.message}`;
  }
}

boot();

function createMiniMap(element, buildingModel, camera) {
  const canvas = element.querySelector("canvas");
  const context = canvas.getContext("2d");
  const bounds = getMiniMapBounds(buildingModel);
  const forward = new Vector3();
  let visible = false;
  let frameId = 0;

  function setVisible(nextVisible) {
    if (visible === nextVisible) {
      return;
    }

    visible = nextVisible;
    element.classList.toggle("is-hidden", !visible);
    element.setAttribute("aria-hidden", String(!visible));

    if (visible) {
      render();
      frameId = requestAnimationFrame(renderLoop);
    } else if (frameId) {
      cancelAnimationFrame(frameId);
      frameId = 0;
    }
  }

  function renderLoop() {
    if (!visible) {
      frameId = 0;
      return;
    }

    render();
    frameId = requestAnimationFrame(renderLoop);
  }

  function render() {
    if (!context || !bounds) {
      return;
    }

    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return;
    }

    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.round(rect.width * pixelRatio);
    const pixelHeight = Math.round(rect.height * pixelRatio);

    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }

    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);

    const padding = Math.max(3, Math.min(rect.width, rect.height) * 0.025);
    const spanX = Math.max(bounds.maxX - bounds.minX, 1);
    const spanZ = Math.max(bounds.maxZ - bounds.minZ, 1);
    const scale = Math.min((rect.width - padding * 2) / spanX, (rect.height - padding * 2) / spanZ);
    const mapWidth = spanX * scale;
    const mapHeight = spanZ * scale;
    const offsetX = (rect.width - mapWidth) / 2 - bounds.minX * scale;
    const offsetY = (rect.height - mapHeight) / 2 + bounds.maxZ * scale;
    const toMapPoint = (x, z) => ({ x: offsetX + x * scale, y: offsetY - z * scale });

    context.save();
    context.beginPath();
    for (const wall of buildingModel.walls ?? []) {
      const start = toMapPoint(wall.start.x, wall.start.y);
      const end = toMapPoint(wall.end.x, wall.end.y);
      context.moveTo(start.x, start.y);
      context.lineTo(end.x, end.y);
    }
    context.strokeStyle = "rgba(234, 242, 238, 0.88)";
    context.lineWidth = 1.35;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.stroke();
    context.restore();

    const cameraPoint = toMapPoint(camera.position.x, camera.position.z);
    camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) {
      forward.set(0, 0, -1);
    } else {
      forward.normalize();
    }

    const heading = Math.atan2(-forward.z, forward.x);
    const viewRadius = Math.max(18, Math.min(31, Math.min(rect.width, rect.height) * 0.18));

    context.save();
    context.translate(cameraPoint.x, cameraPoint.y);
    context.rotate(heading);
    context.beginPath();
    context.moveTo(0, 0);
    context.arc(0, 0, viewRadius, -Math.PI / 7, Math.PI / 7);
    context.closePath();
    context.fillStyle = "rgba(255, 91, 96, 0.18)";
    context.fill();
    context.beginPath();
    context.moveTo(1, 0);
    context.lineTo(viewRadius, 0);
    context.strokeStyle = "rgba(255, 122, 124, 0.68)";
    context.lineWidth = 1;
    context.stroke();
    context.restore();

    context.save();
    context.beginPath();
    context.arc(cameraPoint.x, cameraPoint.y, 4.2, 0, Math.PI * 2);
    context.fillStyle = "#ff565c";
    context.shadowColor = "rgba(255, 86, 92, 0.7)";
    context.shadowBlur = 8;
    context.fill();
    context.shadowBlur = 0;
    context.beginPath();
    context.arc(cameraPoint.x, cameraPoint.y, 1.25, 0, Math.PI * 2);
    context.fillStyle = "#fff4f2";
    context.fill();
    context.restore();
  }

  return { setVisible };
}

function getMiniMapBounds(buildingModel) {
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

  const padding = Math.max(0.08, Math.max(maxX - minX, maxZ - minZ) * 0.012);
  return {
    minX: minX - padding,
    minZ: minZ - padding,
    maxX: maxX + padding,
    maxZ: maxZ + padding,
  };
}
