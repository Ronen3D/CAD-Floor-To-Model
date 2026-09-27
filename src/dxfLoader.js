import DxfParser from "dxf-parser";

export async function loadDxfDocument(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not load DXF at ${url} (${response.status})`);
  }

  const dxfText = await response.text();
  const parser = new DxfParser();
  const document = parser.parseSync(dxfText);

  const layerStats = buildLayerStats(document.entities ?? []);

  return { document, layerStats };
}

function buildLayerStats(entities) {
  const stats = {
    byLayer: new Map(),
    byType: new Map(),
    total: entities.length,
  };

  for (const entity of entities) {
    const layer = entity.layer ?? "<NO_LAYER>";
    const type = entity.type ?? "<NO_TYPE>";

    stats.byLayer.set(layer, (stats.byLayer.get(layer) ?? 0) + 1);
    stats.byType.set(type, (stats.byType.get(type) ?? 0) + 1);
  }

  return stats;
}

export function formatStats(layerStats, maxItems = 14) {
  const lines = [`Total entities: ${layerStats.total}`];

  const sortedLayers = [...layerStats.byLayer.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxItems);

  lines.push("Top layers:");
  for (const [layer, count] of sortedLayers) {
    lines.push(`  ${layer}: ${count}`);
  }

  const sortedTypes = [...layerStats.byType.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  lines.push("Top entity types:");
  for (const [type, count] of sortedTypes) {
    lines.push(`  ${type}: ${count}`);
  }

  return lines.join("\n");
}
