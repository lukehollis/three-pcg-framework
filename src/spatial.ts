import * as THREE from "three";
import type { PCGBounds2D, PCGSpatialMask, Vec2 } from "./types.js";

export function centeredBounds(size: number): PCGBounds2D {
  const half = size / 2;
  return { minX: -half, maxX: half, minZ: -half, maxZ: half };
}

export function boundsWidth(bounds: PCGBounds2D): number {
  return bounds.maxX - bounds.minX;
}

export function boundsDepth(bounds: PCGBounds2D): number {
  return bounds.maxZ - bounds.minZ;
}

export function expandBounds(bounds: PCGBounds2D, amount: number): PCGBounds2D {
  return {
    minX: bounds.minX - amount,
    maxX: bounds.maxX + amount,
    minZ: bounds.minZ - amount,
    maxZ: bounds.maxZ + amount
  };
}

export function mergeBounds(a: PCGBounds2D, b: PCGBounds2D): PCGBounds2D {
  return {
    minX: Math.min(a.minX, b.minX),
    maxX: Math.max(a.maxX, b.maxX),
    minZ: Math.min(a.minZ, b.minZ),
    maxZ: Math.max(a.maxZ, b.maxZ)
  };
}

export function boundsContains(bounds: PCGBounds2D, x: number, z: number): boolean {
  return x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ;
}

export function boundsIntersect(a: PCGBounds2D, b: PCGBounds2D): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
}

export function clampToBounds(bounds: PCGBounds2D, point: Vec2): Vec2 {
  return {
    x: THREE.MathUtils.clamp(point.x, bounds.minX, bounds.maxX),
    z: THREE.MathUtils.clamp(point.z, bounds.minZ, bounds.maxZ)
  };
}

export function boxMask(options: { id: string; bounds: PCGBounds2D; density?: number | undefined; feather?: number | undefined }): PCGSpatialMask {
  const density = options.density ?? 1;
  const feather = Math.max(0, options.feather ?? 0);
  return {
    id: options.id,
    bounds: feather > 0 ? expandBounds(options.bounds, feather) : options.bounds,
    densityAt(x, z) {
      if (!boundsContains(this.bounds, x, z)) {
        return 0;
      }
      if (feather === 0) {
        return density;
      }
      const insideX = Math.min(x - options.bounds.minX, options.bounds.maxX - x);
      const insideZ = Math.min(z - options.bounds.minZ, options.bounds.maxZ - z);
      const signedDistance = Math.min(insideX, insideZ);
      return density * THREE.MathUtils.smoothstep(signedDistance, -feather, feather);
    }
  };
}

export function circleMask(options: {
  id: string;
  center: Vec2;
  radius: number;
  density?: number | undefined;
  feather?: number | undefined;
}): PCGSpatialMask {
  const density = options.density ?? 1;
  const feather = Math.max(0, options.feather ?? 0);
  const radius = Math.max(0, options.radius);
  const bounds = {
    minX: options.center.x - radius - feather,
    maxX: options.center.x + radius + feather,
    minZ: options.center.z - radius - feather,
    maxZ: options.center.z + radius + feather
  };
  return {
    id: options.id,
    bounds,
    densityAt(x, z) {
      const distance = Math.hypot(x - options.center.x, z - options.center.z);
      if (distance > radius + feather) {
        return 0;
      }
      if (feather === 0) {
        return distance <= radius ? density : 0;
      }
      return density * (1 - THREE.MathUtils.smoothstep(distance, radius - feather, radius + feather));
    }
  };
}

export function polygonMask(options: { id: string; points: Vec2[]; density?: number | undefined; feather?: number | undefined }): PCGSpatialMask {
  if (options.points.length < 3) {
    throw new Error("polygonMask requires at least three points.");
  }
  const density = options.density ?? 1;
  const feather = Math.max(0, options.feather ?? 0);
  let bounds: PCGBounds2D = {
    minX: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    minZ: Number.POSITIVE_INFINITY,
    maxZ: Number.NEGATIVE_INFINITY
  };
  for (const point of options.points) {
    bounds = mergeBounds(bounds, { minX: point.x, maxX: point.x, minZ: point.z, maxZ: point.z });
  }
  bounds = feather > 0 ? expandBounds(bounds, feather) : bounds;

  return {
    id: options.id,
    bounds,
    densityAt(x, z) {
      if (!boundsContains(bounds, x, z)) {
        return 0;
      }
      const inside = pointInPolygon(x, z, options.points);
      if (feather === 0) {
        return inside ? density : 0;
      }
      const distance = distanceToPolyline(x, z, options.points, true);
      const signed = inside ? distance : -distance;
      return density * THREE.MathUtils.smoothstep(signed, -feather, feather);
    }
  };
}

export function splineMask(options: {
  id: string;
  points: Vec2[];
  radius: number;
  density?: number | undefined;
  feather?: number | undefined;
}): PCGSpatialMask {
  if (options.points.length < 2) {
    throw new Error("splineMask requires at least two points.");
  }
  const density = options.density ?? 1;
  const feather = Math.max(0, options.feather ?? 0);
  let bounds: PCGBounds2D = {
    minX: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    minZ: Number.POSITIVE_INFINITY,
    maxZ: Number.NEGATIVE_INFINITY
  };
  for (const point of options.points) {
    bounds = mergeBounds(bounds, { minX: point.x, maxX: point.x, minZ: point.z, maxZ: point.z });
  }
  bounds = expandBounds(bounds, options.radius + feather);

  return {
    id: options.id,
    bounds,
    densityAt(x, z) {
      if (!boundsContains(bounds, x, z)) {
        return 0;
      }
      const distance = distanceToPolyline(x, z, options.points, false);
      if (distance > options.radius + feather) {
        return 0;
      }
      if (feather === 0) {
        return distance <= options.radius ? density : 0;
      }
      return density * (1 - THREE.MathUtils.smoothstep(distance, options.radius - feather, options.radius + feather));
    }
  };
}

export function textureMask(options: {
  id: string;
  bounds: PCGBounds2D;
  width: number;
  height: number;
  values: ArrayLike<number>;
  density?: number | undefined;
  threshold?: number | undefined;
}): PCGSpatialMask {
  if (options.width <= 0 || options.height <= 0) {
    throw new Error("textureMask requires positive width and height.");
  }
  if (options.values.length < options.width * options.height) {
    throw new Error("textureMask values length is smaller than width * height.");
  }
  const density = options.density ?? 1;
  const threshold = options.threshold ?? 0;
  return {
    id: options.id,
    bounds: options.bounds,
    densityAt(x, z) {
      if (!boundsContains(options.bounds, x, z)) {
        return 0;
      }
      const u = (x - options.bounds.minX) / Math.max(1e-6, boundsWidth(options.bounds));
      const v = (z - options.bounds.minZ) / Math.max(1e-6, boundsDepth(options.bounds));
      const value = bilinear(options.values, options.width, options.height, u, v);
      return value <= threshold ? 0 : THREE.MathUtils.clamp(value * density, 0, 1);
    }
  };
}

export function combineMasks(
  id: string,
  masks: PCGSpatialMask[],
  mode: "union" | "intersection" | "subtract" | "multiply" = "union"
): PCGSpatialMask {
  if (masks.length === 0) {
    throw new Error("combineMasks requires at least one mask.");
  }
  const bounds = masks.map((mask) => mask.bounds).reduce(mergeBounds);
  return {
    id,
    bounds,
    densityAt(x, z) {
      if (mode === "intersection") {
        return masks.reduce((value, mask) => Math.min(value, mask.densityAt(x, z)), 1);
      }
      if (mode === "multiply") {
        return masks.reduce((value, mask) => value * mask.densityAt(x, z), 1);
      }
      if (mode === "subtract") {
        const [base, ...cutters] = masks;
        if (!base) {
          return 0;
        }
        return cutters.reduce((value, mask) => value * (1 - mask.densityAt(x, z)), base.densityAt(x, z));
      }
      return Math.min(1, masks.reduce((value, mask) => Math.max(value, mask.densityAt(x, z)), 0));
    }
  };
}

export function distanceToSegment(x: number, z: number, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const apx = x - a.x;
  const apz = z - a.z;
  const lengthSq = abx * abx + abz * abz;
  const t = lengthSq === 0 ? 0 : THREE.MathUtils.clamp((apx * abx + apz * abz) / lengthSq, 0, 1);
  const px = a.x + abx * t;
  const pz = a.z + abz * t;
  return Math.hypot(x - px, z - pz);
}

export function distanceToPolyline(x: number, z: number, points: Vec2[], closed: boolean): number {
  let closest = Number.POSITIVE_INFINITY;
  const count = closed ? points.length : points.length - 1;
  for (let index = 0; index < count; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    if (!a || !b) {
      continue;
    }
    closest = Math.min(closest, distanceToSegment(x, z, a, b));
  }
  return closest;
}

export function pointInPolygon(x: number, z: number, points: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const pi = points[i];
    const pj = points[j];
    if (!pi || !pj) {
      continue;
    }
    const intersects = pi.z > z !== pj.z > z && x < ((pj.x - pi.x) * (z - pi.z)) / (pj.z - pi.z || 1e-6) + pi.x;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

function bilinear(values: ArrayLike<number>, width: number, height: number, u: number, v: number): number {
  const x = THREE.MathUtils.clamp(u, 0, 1) * (width - 1);
  const y = THREE.MathUtils.clamp(v, 0, 1) * (height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const v00 = values[y0 * width + x0] ?? 0;
  const v10 = values[y0 * width + x1] ?? 0;
  const v01 = values[y1 * width + x0] ?? 0;
  const v11 = values[y1 * width + x1] ?? 0;
  const a = THREE.MathUtils.lerp(v00, v10, tx);
  const b = THREE.MathUtils.lerp(v01, v11, tx);
  return THREE.MathUtils.lerp(a, b, ty);
}
