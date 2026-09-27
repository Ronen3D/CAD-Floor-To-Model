import { Vector2 } from "three";

export function buildArchitecturalModel(dxfDoc, config) {
  const entities = dxfDoc.entities ?? [];
  const wallSegments = [];
  const floorPoints = [];
  const doors = [];

  for (const entity of entities) {
    if (config.wallLayers.has(entity.layer)) {
      extractSegments(entity, config.scale, wallSegments);
      continue;
    }

    if (config.doorLayers.has(entity.layer)) {
      extractDoor(entity, config, doors);
      continue;
    }

    if (config.floorLayers.has(entity.layer)) {
      extractVertices(entity, config.scale, floorPoints);
    }
  }

  const modelPoints = [...floorPoints];
  for (const segment of wallSegments) {
    modelPoints.push(segment.start, segment.end);
  }

  const modelBounds = computeBounds(modelPoints);
  const spawnPoint = findSpawnPointInRoom(wallSegments, modelBounds, config.wallThicknessMeters);
  const floorBounds = expandBounds(modelBounds, resolveFloorPadding(modelBounds, config));

  return {
    walls: wallSegments,
    floors: floorBounds ? [{ min: floorBounds.min, max: floorBounds.max }] : [],
    spawnPoint,
    doors,
    windows: [],
    columns: [],
    stairs: [],
    meta: {
      wallCount: wallSegments.length,
      floorPointCount: floorPoints.length,
      doorCount: doors.length,
      spawnPoint,
    },
  };
}

function extractDoor(entity, config, outDoors) {
  if (entity.type !== "INSERT") {
    return;
  }

  const position = toWorld2D(entity.position, config.scale);
  if (!position) {
    return;
  }

  const name = entity.name ?? "";
  const isDouble = /DBL|DOUBLE/i.test(name);
  const widthMatch = name.match(/W(\d{2,3})(?:H|_|$)/i);
  const widthFromName = widthMatch ? Number(widthMatch[1]) * config.scale : null;
  const defaultWidth = isDouble ? config.defaultDoubleDoorWidthMeters : config.defaultDoorWidthMeters;

  outDoors.push({
    center: position,
    width: widthFromName && widthFromName > 0 ? widthFromName : defaultWidth,
    rotation: -((entity.rotation ?? 0) * Math.PI) / 180,
    isDouble,
    material: /ALUM|METAL|GLAZ/i.test(name) ? "metal" : "wood",
    sourceName: name,
  });
}

function extractSegments(entity, scale, outSegments) {
  if (entity.type === "LINE") {
    const start = toWorld2D(entity.start ?? entity.vertices?.[0], scale);
    const end = toWorld2D(entity.end ?? entity.vertices?.[1], scale);

    if (start && end && !start.equals(end)) {
      outSegments.push({ start, end, sourceType: "LINE" });
    }
    return;
  }

  if (entity.type === "LWPOLYLINE" || entity.type === "POLYLINE") {
    const vertices = (entity.vertices ?? [])
      .map((vertex) => toWorld2D(vertex, scale))
      .filter(Boolean);

    for (let i = 0; i < vertices.length - 1; i += 1) {
      if (!vertices[i].equals(vertices[i + 1])) {
        outSegments.push({
          start: vertices[i],
          end: vertices[i + 1],
          sourceType: entity.type,
        });
      }
    }

    if (entity.shape && vertices.length > 2 && !vertices[0].equals(vertices.at(-1))) {
      outSegments.push({
        start: vertices.at(-1),
        end: vertices[0],
        sourceType: entity.type,
      });
    }
  }
}

function extractVertices(entity, scale, outPoints) {
  if (entity.type === "LINE") {
    const start = toWorld2D(entity.start ?? entity.vertices?.[0], scale);
    const end = toWorld2D(entity.end ?? entity.vertices?.[1], scale);
    if (start) outPoints.push(start);
    if (end) outPoints.push(end);
    return;
  }

  const vertices = entity.vertices ?? [];
  for (const vertex of vertices) {
    const point = toWorld2D(vertex, scale);
    if (point) {
      outPoints.push(point);
    }
  }
}

function toWorld2D(point, scale) {
  if (!point || typeof point.x !== "number" || typeof point.y !== "number") {
    return null;
  }

  return new Vector2(point.x * scale, -point.y * scale);
}

function computeBounds(points) {
  if (points.length === 0) {
    return null;
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }

  return {
    min: new Vector2(minX, minY),
    max: new Vector2(maxX, maxY),
  };
}

function resolveFloorPadding(bounds, config) {
  if (!bounds) {
    return 0;
  }

  if (typeof config.floorPaddingMeters === "number") {
    return Math.max(0, config.floorPaddingMeters);
  }

  const width = bounds.max.x - bounds.min.x;
  const depth = bounds.max.y - bounds.min.y;
  return Math.max(0.5, Math.max(width, depth) * 0.12);
}

function expandBounds(bounds, padding) {
  if (!bounds) {
    return null;
  }

  return {
    min: new Vector2(bounds.min.x - padding, bounds.min.y - padding),
    max: new Vector2(bounds.max.x + padding, bounds.max.y + padding),
  };
}

function findSpawnPointInRoom(walls, bounds, wallThickness) {
  if (!bounds) {
    return null;
  }

  const width = bounds.max.x - bounds.min.x;
  const height = bounds.max.y - bounds.min.y;
  if (width <= 0 || height <= 0) {
    return new Vector2((bounds.min.x + bounds.max.x) / 2, (bounds.min.y + bounds.max.y) / 2);
  }

  if (walls.length === 0) {
    return new Vector2((bounds.min.x + bounds.max.x) / 2, (bounds.min.y + bounds.max.y) / 2);
  }

  const cellSize = Math.max(0.03, Math.min(0.08, Math.min(width, height) / 100));
  const cols = Math.max(8, Math.ceil(width / cellSize));
  const rows = Math.max(8, Math.ceil(height / cellSize));
  const blocked = new Uint8Array(cols * rows);
  const outside = new Uint8Array(cols * rows);
  const visited = new Uint8Array(cols * rows);

  const minX = bounds.min.x;
  const minY = bounds.min.y;
  const blockRadius = Math.max(wallThickness * 0.8, cellSize * 0.75);

  function toIndex(ix, iy) {
    return iy * cols + ix;
  }

  function worldToGridX(x) {
    const ix = Math.floor((x - minX) / cellSize);
    return clamp(ix, 0, cols - 1);
  }

  function worldToGridY(y) {
    const iy = Math.floor((y - minY) / cellSize);
    return clamp(iy, 0, rows - 1);
  }

  function markDisk(x, y, radius) {
    const centerX = worldToGridX(x);
    const centerY = worldToGridY(y);
    const radiusCells = Math.max(1, Math.ceil(radius / cellSize));

    for (let dy = -radiusCells; dy <= radiusCells; dy += 1) {
      const gy = centerY + dy;
      if (gy < 0 || gy >= rows) {
        continue;
      }

      for (let dx = -radiusCells; dx <= radiusCells; dx += 1) {
        const gx = centerX + dx;
        if (gx < 0 || gx >= cols) {
          continue;
        }

        if (dx * dx + dy * dy <= radiusCells * radiusCells) {
          blocked[toIndex(gx, gy)] = 1;
        }
      }
    }
  }

  for (const wall of walls) {
    const dx = wall.end.x - wall.start.x;
    const dy = wall.end.y - wall.start.y;
    const length = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(length / (cellSize * 0.45)));

    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const x = wall.start.x + dx * t;
      const y = wall.start.y + dy * t;
      markDisk(x, y, blockRadius);
    }
  }

  const queue = [];
  let head = 0;

  function enqueue(ix, iy) {
    const idx = toIndex(ix, iy);
    if (blocked[idx] || outside[idx]) {
      return;
    }
    outside[idx] = 1;
    queue.push(idx);
  }

  for (let x = 0; x < cols; x += 1) {
    enqueue(x, 0);
    enqueue(x, rows - 1);
  }
  for (let y = 0; y < rows; y += 1) {
    enqueue(0, y);
    enqueue(cols - 1, y);
  }

  while (head < queue.length) {
    const idx = queue[head];
    head += 1;

    const x = idx % cols;
    const y = Math.floor(idx / cols);

    if (x > 0) enqueue(x - 1, y);
    if (x < cols - 1) enqueue(x + 1, y);
    if (y > 0) enqueue(x, y - 1);
    if (y < rows - 1) enqueue(x, y + 1);
  }

  let bestRegion = null;

  for (let iy = 0; iy < rows; iy += 1) {
    for (let ix = 0; ix < cols; ix += 1) {
      const startIdx = toIndex(ix, iy);
      if (blocked[startIdx] || outside[startIdx] || visited[startIdx]) {
        continue;
      }

      const regionQueue = [startIdx];
      visited[startIdx] = 1;
      let regionHead = 0;
      let count = 0;
      let sumX = 0;
      let sumY = 0;

      while (regionHead < regionQueue.length) {
        const idx = regionQueue[regionHead];
        regionHead += 1;

        const x = idx % cols;
        const y = Math.floor(idx / cols);

        count += 1;
        sumX += minX + (x + 0.5) * cellSize;
        sumY += minY + (y + 0.5) * cellSize;

        tryVisitRegionCell(x - 1, y, cols, rows, blocked, outside, visited, regionQueue, toIndex);
        tryVisitRegionCell(x + 1, y, cols, rows, blocked, outside, visited, regionQueue, toIndex);
        tryVisitRegionCell(x, y - 1, cols, rows, blocked, outside, visited, regionQueue, toIndex);
        tryVisitRegionCell(x, y + 1, cols, rows, blocked, outside, visited, regionQueue, toIndex);
      }

      if (!bestRegion || count > bestRegion.count) {
        bestRegion = {
          count,
          center: new Vector2(sumX / count, sumY / count),
        };
      }
    }
  }

  if (bestRegion) {
    return bestRegion.center;
  }

  return new Vector2((bounds.min.x + bounds.max.x) / 2, (bounds.min.y + bounds.max.y) / 2);
}

function tryVisitRegionCell(x, y, cols, rows, blocked, outside, visited, queue, toIndex) {
  if (x < 0 || x >= cols || y < 0 || y >= rows) {
    return;
  }

  const idx = toIndex(x, y);
  if (blocked[idx] || outside[idx] || visited[idx]) {
    return;
  }

  visited[idx] = 1;
  queue.push(idx);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
