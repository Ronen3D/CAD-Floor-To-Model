# CAD to Model Viewer

A DXF to Three.js architectural viewer prototype.

This project reads a 2D DXF floor plan, extracts architectural data (walls, doors, floor extent), builds 3D geometry in Three.js, and provides two navigation modes:

- Top View (default startup mode)
- Walk Mode (first-person style without mouse lock)

## Current Scope

- DXF parsing from `assets/HAD-SC-P-100-002.dxf`
- Layer-based extraction:
  - Walls: `A-WALL`, `I-WALL`
  - Doors: `A-DOOR`
  - Floor hints: `A-FLOR`
- 3D walls with configurable height/thickness
- Floor plane expanded beyond the model footprint
- Door meshes with click-to-open behavior in Walk Mode
- Wall and door collision for the camera
- Top View with OrbitControls
- Click-on-floor in Top View to jump into Walk Mode at the clicked point

## Tech Stack

- Vite
- Three.js
- dxf-parser

## Setup

1. Install dependencies:

   npm install

2. Run development server:

   npm run dev

3. Build production bundle:

   npm run build

4. Preview build:

   npm run preview

## GitHub Pages Deployment

The site is deployed from the production Vite build by the GitHub Actions workflow in `.github/workflows/deploy-pages.yml`.

Before the first deployment, open the repository's **Settings > Pages** and select **GitHub Actions** as the build and deployment source. After pushing to `main`, the workflow publishes the site at:

https://ronen3d.github.io/CAD-Floor-To-Model/

## Navigation and Controls

### Startup

- The viewer starts in full Top View and fits the full model in frame.

### Top View

- Orbit controls are enabled:
  - Left mouse drag: orbit
  - Mouse wheel: zoom
  - Right mouse drag (or configured orbit pan gesture): pan
- Click on floor: move to that location and switch to Walk Mode

### Walk Mode

- Mouse drag: look around (no pointer lock)
- Arrow Left / Arrow Right: turn camera
- S / Arrow Down: move forward
- W / Arrow Up: move backward
- A / D: strafe left / right
- Space / Shift: move up / down
- Click a door: open door

## UI Buttons

- `Top view`: toggle Top View mode
- `Show panel` / `Hide panel`: toggle HUD visibility
- `Return to walk mode`: visible in Top View state

## Configuration

Main runtime configuration is in `src/config.js`.

Important fields:

- `dxfPath`
- `scale`
- `wallLayers`
- `doorLayers`
- `floorLayers`
- `wallHeightMeters`
- `wallThicknessMeters`
- `doorHeightMeters`
- `defaultDoorWidthMeters`
- `defaultDoubleDoorWidthMeters`
- `floorPaddingMeters`
- `eyeHeightMeters`

## Project Structure

- `assets/` - source CAD files
- `src/config.js` - runtime config
- `src/dxfLoader.js` - DXF read + stats
- `src/architecturalModel.js` - semantic extraction (walls/doors/floor model)
- `src/scene.js` - Three.js scene, controls, collisions, door interaction
- `src/main.js` - app bootstrap and UI wiring
- `index.html` - app shell

## Notes

- The bundle currently exceeds Vite's default 500 kB warning threshold.
- The viewer is tuned for the supplied DXF and layer naming conventions.
- Coordinate conversion is handled in extraction (`CAD X -> Three X`, `CAD Y -> Three Z` with sign adjustment).

## Next Suggested Improvements

- Add room/closed-region detection and room metadata
- Add minimap overlay in Walk Mode
- Add collision floor clamping and gravity option
- Add config presets for control mapping (standard/inverted)
- Add DXF upload UI instead of fixed asset path
