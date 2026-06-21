import * as THREE from "three";
import {
  boxMask,
  circleMask,
  combineMasks,
  expandBounds,
  polygonMask,
  splineMask,
  textureMask
} from "./spatial.js";
import type { PCGBiomeCache, PCGBounds2D, PCGSpatialMask, Vec2 } from "./types.js";

export function createBiomeCache(options: {
  id: string;
  kind: PCGBiomeCache["kind"];
  mask: PCGSpatialMask;
  color?: THREE.Color | string | undefined;
  blendRange?: number | undefined;
}): PCGBiomeCache {
  const mask =
    options.blendRange && options.blendRange > 0
      ? {
          ...options.mask,
          bounds: expandBounds(options.mask.bounds, options.blendRange)
        }
      : options.mask;
  const cache: PCGBiomeCache = {
    id: options.id,
    kind: options.kind,
    bounds: mask.bounds,
    mask,
    densityAt: (x, z) => mask.densityAt(x, z),
    contains: (x, z) => mask.densityAt(x, z) > 0
  };
  if (options.color !== undefined) {
    cache.color = typeof options.color === "string" ? new THREE.Color(options.color) : options.color.clone();
  }
  return cache;
}

export function createVolumeCache(options: {
  id: string;
  bounds: PCGBounds2D;
  density?: number | undefined;
  feather?: number | undefined;
  color?: THREE.Color | string | undefined;
  blendRange?: number | undefined;
}): PCGBiomeCache {
  return createBiomeCache({
    id: options.id,
    kind: "volume",
    mask: boxMask({ id: `${options.id}:volume`, bounds: options.bounds, density: options.density, feather: options.feather }),
    color: options.color,
    blendRange: options.blendRange
  });
}

export function createCircleCache(options: {
  id: string;
  center: Vec2;
  radius: number;
  density?: number | undefined;
  feather?: number | undefined;
  color?: THREE.Color | string | undefined;
  blendRange?: number | undefined;
}): PCGBiomeCache {
  return createBiomeCache({
    id: options.id,
    kind: "volume",
    mask: circleMask({
      id: `${options.id}:circle`,
      center: options.center,
      radius: options.radius,
      density: options.density,
      feather: options.feather
    }),
    color: options.color,
    blendRange: options.blendRange
  });
}

export function createPolygonCache(options: {
  id: string;
  points: Vec2[];
  density?: number | undefined;
  feather?: number | undefined;
  color?: THREE.Color | string | undefined;
  blendRange?: number | undefined;
}): PCGBiomeCache {
  return createBiomeCache({
    id: options.id,
    kind: "volume",
    mask: polygonMask({
      id: `${options.id}:polygon`,
      points: options.points,
      density: options.density,
      feather: options.feather
    }),
    color: options.color,
    blendRange: options.blendRange
  });
}

export function createSplineCache(options: {
  id: string;
  points: Vec2[];
  radius: number;
  density?: number | undefined;
  feather?: number | undefined;
  color?: THREE.Color | string | undefined;
  blendRange?: number | undefined;
}): PCGBiomeCache {
  return createBiomeCache({
    id: options.id,
    kind: "spline",
    mask: splineMask({
      id: `${options.id}:spline`,
      points: options.points,
      radius: options.radius,
      density: options.density,
      feather: options.feather
    }),
    color: options.color,
    blendRange: options.blendRange
  });
}

export function createTextureCache(options: {
  id: string;
  bounds: PCGBounds2D;
  width: number;
  height: number;
  values: ArrayLike<number>;
  density?: number | undefined;
  threshold?: number | undefined;
  color?: THREE.Color | string | undefined;
  blendRange?: number | undefined;
}): PCGBiomeCache {
  return createBiomeCache({
    id: options.id,
    kind: "texture",
    mask: textureMask({
      id: `${options.id}:texture`,
      bounds: options.bounds,
      width: options.width,
      height: options.height,
      values: options.values,
      density: options.density,
      threshold: options.threshold
    }),
    color: options.color,
    blendRange: options.blendRange
  });
}

export function createCompositeCache(options: {
  id: string;
  caches: PCGBiomeCache[];
  mode?: "union" | "intersection" | "subtract" | "multiply";
  color?: THREE.Color | string | undefined;
}): PCGBiomeCache {
  return createBiomeCache({
    id: options.id,
    kind: "composite",
    mask: combineMasks(
      `${options.id}:composite`,
      options.caches.map((cache) => cache.mask),
      options.mode ?? "union"
    ),
    color: options.color
  });
}
