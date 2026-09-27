import "./styles.css";

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

    const tryLockWalkMode = () => {
      if (!viewer.isTopViewActive() && document.pointerLockElement !== canvas) {
        viewer.controls.lock();
      }
    };

    setTimeout(tryLockWalkMode, 0);
    canvas.addEventListener("pointerdown", tryLockWalkMode, { once: true });

    topViewButton.addEventListener("click", () => {
      if (viewer.isTopViewActive()) {
        viewer.exitTopView();
        return;
      }

      viewer.enterTopView();
    });

    viewer.events.addEventListener("modechange", (event) => {
      const topViewActive = Boolean(event.detail?.topViewActive);
      topViewButton.classList.toggle("is-active", topViewActive);
      topViewButton.setAttribute("aria-pressed", String(topViewActive));
      topViewButton.textContent = topViewActive ? "Top view: click floor to walk" : "Top view";
    });

    button.addEventListener("click", () => {
      viewer.controls.lock();
    });

    viewer.controls.addEventListener("lock", () => {
      button.textContent = "Walkthrough active";
    });

    viewer.controls.addEventListener("unlock", () => {
      button.textContent = "Enter walkthrough mode";
    });
  } catch (error) {
    console.error(error);
    statsElement.textContent = `Failed to build model: ${error.message}`;
  }
}

boot();
