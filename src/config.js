import dxfPath from "../assets/HAD-SC-P-100-002.dxf?url";

export const CONFIG = {
  dxfPath,
  scale: 0.01,
  wallLayers: new Set(["A-WALL", "I-WALL"]),
  doorLayers: new Set(["A-DOOR"]),
  floorLayers: new Set(["A-FLOR"]),
  wallHeightMeters: 2.8,
  wallThicknessMeters: 0.16,
  doorHeightMeters: 2.12,
  defaultDoorWidthMeters: 0.9,
  defaultDoubleDoorWidthMeters: 1.8,
  floorPaddingMeters: 20.0,
  eyeHeightMeters: 1.72,
};
