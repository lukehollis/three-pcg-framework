import * as THREE from "three";
import { computeSeed, SeededRandom } from "./random.js";
import { boundsDepth, boundsWidth, distanceToPolyline } from "./spatial.js";
import { createPoint } from "./point.js";
import type { PCGGenerator, PCGGraphContext, PCGPoint, PCGSurface, Vec2 } from "./types.js";

export type Generator = PCGGenerator;

export function surfaceScatter(options: { id: string; count: number; jitter?: number }): PCGGenerator {
  const jitter = options.jitter ?? 1;
  return {
    id: options.id,
    generate(ctx) {
      const width = boundsWidth(ctx.bounds);
      const depth = boundsDepth(ctx.bounds);
      const rows = Math.max(1, Math.ceil(Math.sqrt(options.count * (depth / Math.max(width, 1e-6)))));
      const cols = Math.max(1, Math.ceil(options.count / rows));
      const points: PCGPoint[] = [];
      for (let iz = 0; iz < rows; iz += 1) {
        for (let ix = 0; ix < cols && points.length < options.count; ix += 1) {
          const fx = (ix + 0.5 + (ctx.rng.next() - 0.5) * jitter) / cols;
          const fz = (iz + 0.5 + (ctx.rng.next() - 0.5) * jitter) / rows;
          const x = ctx.bounds.minX + fx * width;
          const z = ctx.bounds.minZ + fz * depth;
          const cacheDensity = cacheDensityAt(ctx, x, z);
          if (cacheDensity <= 0) {
            continue;
          }
          const point = makeGeneratedPoint(ctx, x, z, `${options.id}:${points.length}`);
          point.density *= cacheDensity;
          points.push(point);
        }
      }
      return points;
    }
  };
}

export function surfaceSampler(options: {
  id: string;
  pointsPerSquareMeter?: number;
  pointExtents?: number | THREE.Vector3;
  looseness?: number;
  pointSteepness?: number;
  applyDensityToPoints?: boolean;
  legacyGridCreation?: boolean;
}): PCGGenerator {
  return {
    id: options.id,
    generate(ctx) {
      const pointExtents =
        typeof options.pointExtents === "number"
          ? new THREE.Vector3(options.pointExtents, options.pointExtents, options.pointExtents)
          : options.pointExtents?.clone() ?? new THREE.Vector3(0.5, 0.5, 0.5);
      if (pointExtents.x <= 0 || pointExtents.z <= 0) {
        return [];
      }

      const pointsPerSquareMeter = options.pointsPerSquareMeter ?? 0.1;
      const looseness = THREE.MathUtils.clamp(options.looseness ?? 1, 0, 1);
      const interstitial = pointExtents.clone().multiplyScalar(2);
      let cellSize: THREE.Vector3;
      let innerCellSize: THREE.Vector3;
      let innerCellOffset: THREE.Vector3;
      let ratio = 1;

      if (options.legacyGridCreation) {
        innerCellSize = interstitial.clone().multiplyScalar(looseness);
        innerCellOffset = new THREE.Vector3();
        cellSize = interstitial.clone().add(innerCellSize);
        const targetCount = boundsWidth(ctx.bounds) * boundsDepth(ctx.bounds) * Math.max(0, pointsPerSquareMeter);
        const cellCount = Math.max(1, Math.ceil(boundsWidth(ctx.bounds) / cellSize.x) * Math.ceil(boundsDepth(ctx.bounds) / cellSize.z));
        ratio = THREE.MathUtils.clamp(targetCount / cellCount, 0, 1);
      } else {
        const squareMetersPerPoint = pointsPerSquareMeter > 0 ? 1 / pointsPerSquareMeter : Number.POSITIVE_INFINITY;
        const minCellSize = 2 * Math.min(pointExtents.x, pointExtents.z);
        const maxCellSize = 2 * Math.max(pointExtents.x, pointExtents.z);
        const baseCellSize = Number.isFinite(squareMetersPerPoint)
          ? Math.sqrt(squareMetersPerPoint / Math.max(1e-6, maxCellSize / minCellSize))
          : Number.POSITIVE_INFINITY;
        cellSize = new THREE.Vector3(
          baseCellSize * 2 * (pointExtents.x / minCellSize),
          pointExtents.y * 2,
          baseCellSize * 2 * (pointExtents.z / minCellSize)
        );
        if (!Number.isFinite(cellSize.x) || !Number.isFinite(cellSize.z)) {
          return [];
        }
        cellSize.x = Math.max(cellSize.x, interstitial.x);
        cellSize.z = Math.max(cellSize.z, interstitial.z);
        const remainder = cellSize.clone().sub(interstitial);
        innerCellSize = remainder.multiplyScalar(looseness);
        innerCellOffset = cellSize.clone().sub(interstitial).multiplyScalar(0.5 * (1 - looseness));
      }

      const cellMinX = Math.ceil(ctx.bounds.minX / cellSize.x);
      const cellMaxX = Math.floor(ctx.bounds.maxX / cellSize.x);
      const cellMinZ = Math.ceil(ctx.bounds.minZ / cellSize.z);
      const cellMaxZ = Math.floor(ctx.bounds.maxZ / cellSize.z);
      const points: PCGPoint[] = [];
      for (let iz = cellMinZ; iz <= cellMaxZ; iz += 1) {
        for (let ix = cellMinX; ix <= cellMaxX; ix += 1) {
          const cellRng = new SeededRandom(computeSeed(ctx.rng.getCurrentSeed(), ix, iz));
          const chance = cellRng.next();
          if (chance >= ratio) {
            continue;
          }
          const x = ix * cellSize.x + innerCellOffset.x + cellRng.next() * innerCellSize.x;
          const z = iz * cellSize.z + innerCellOffset.z + cellRng.next() * innerCellSize.z;
          const cacheDensity = cacheDensityAt(ctx, x, z);
          if (cacheDensity <= 0) {
            continue;
          }
          const point = createPoint(contextSurface(ctx), x, z, {
            id: `${options.id}:${ix}:${iz}`,
            biomeId: ctx.biomeId,
            biomePriority: ctx.biomePriority,
            boundsMin: pointExtents.clone().multiplyScalar(-1),
            boundsMax: pointExtents.clone(),
            steepness: options.pointSteepness ?? 1,
            seed: cellRng.getCurrentSeed()
          });
          point.density = cacheDensity;
          if (options.applyDensityToPoints ?? true) {
            point.density *= (ratio - chance) / ratio;
          }
          points.push(point);
        }
      }
      return points;
    }
  };
}

export function poissonSurfaceScatter(options: {
  id: string;
  count: number;
  radius: number;
  maxAttempts?: number;
}): PCGGenerator {
  return {
    id: options.id,
    generate(ctx) {
      const points: PCGPoint[] = [];
      const attempts = options.maxAttempts ?? options.count * 24;
      const width = boundsWidth(ctx.bounds);
      const depth = boundsDepth(ctx.bounds);
      const radiusSq = options.radius * options.radius;
      for (let attempt = 0; attempt < attempts && points.length < options.count; attempt += 1) {
        const x = ctx.bounds.minX + ctx.rng.next() * width;
        const z = ctx.bounds.minZ + ctx.rng.next() * depth;
        const cacheDensity = cacheDensityAt(ctx, x, z);
        if (cacheDensity <= 0 || ctx.rng.next() > cacheDensity) {
          continue;
        }
        let blocked = false;
        for (const point of points) {
          const dx = x - point.position.x;
          const dz = z - point.position.z;
          if (dx * dx + dz * dz < radiusSq) {
            blocked = true;
            break;
          }
        }
        if (!blocked) {
          points.push(makeGeneratedPoint(ctx, x, z, `${options.id}:${points.length}`));
        }
      }
      return points;
    }
  };
}

export function ringScatter(options: {
  id: string;
  center: Vec2;
  innerRadius: number;
  outerRadius: number;
  count: number;
}): PCGGenerator {
  return {
    id: options.id,
    generate(ctx) {
      const points: PCGPoint[] = [];
      for (let index = 0; index < options.count; index += 1) {
        const angle = ctx.rng.between(0, Math.PI * 2);
        const r = ctx.rng.between(options.innerRadius, options.outerRadius);
        const x = options.center.x + Math.cos(angle) * r;
        const z = options.center.z + Math.sin(angle) * r;
        const cacheDensity = cacheDensityAt(ctx, x, z);
        if (cacheDensity <= 0) {
          continue;
        }
        const point = makeGeneratedPoint(ctx, x, z, `${options.id}:${points.length}`);
        point.density *= cacheDensity;
        points.push(point);
      }
      return points;
    }
  };
}

export function pointSet(id: string, positions: { x: number; z: number; rotationY?: number; density?: number }[]): PCGGenerator {
  return {
    id,
    generate(ctx) {
      return positions
        .map((entry, index) => {
          const point = makeGeneratedPoint(ctx, entry.x, entry.z, `${id}:${index}`);
          if (entry.rotationY !== undefined) {
            point.rotationY = entry.rotationY;
          }
          if (entry.density !== undefined) {
            point.density = entry.density;
          }
          point.density *= cacheDensityAt(ctx, entry.x, entry.z);
          return point;
        })
        .filter((point) => point.density > 0);
    }
  };
}

export function splineScatter(options: {
  id: string;
  points: Vec2[];
  count: number;
  radius?: number;
  jitter?: number;
}): PCGGenerator {
  return {
    id: options.id,
    generate(ctx) {
      const points: PCGPoint[] = [];
      const lengths = segmentLengths(options.points);
      const total = lengths.reduce((sum, value) => sum + value, 0);
      if (total <= 0) {
        return points;
      }
      for (let index = 0; index < options.count; index += 1) {
        const target = ctx.rng.next() * total;
        const base = pointAlongPolyline(options.points, lengths, target);
        if (!base) {
          continue;
        }
        const offset = ctx.rng.between(-(options.radius ?? 0), options.radius ?? 0) * (options.jitter ?? 1);
        const next = pointAlongPolyline(options.points, lengths, target + 0.1) ?? base;
        const tangentX = next.x - base.x;
        const tangentZ = next.z - base.z;
        const length = Math.hypot(tangentX, tangentZ) || 1;
        const x = base.x + (-tangentZ / length) * offset;
        const z = base.z + (tangentX / length) * offset;
        const cacheDensity = cacheDensityAt(ctx, x, z);
        if (cacheDensity <= 0) {
          continue;
        }
        const point = makeGeneratedPoint(ctx, x, z, `${options.id}:${points.length}`);
        point.attributes.splineDistance = distanceToPolyline(x, z, options.points, false);
        point.density *= cacheDensity;
        points.push(point);
      }
      return points;
    }
  };
}

export function textureScatter(options: {
  id: string;
  count: number;
  textureWidth: number;
  textureHeight: number;
  values: ArrayLike<number>;
  threshold?: number;
}): PCGGenerator {
  return {
    id: options.id,
    generate(ctx) {
      const width = boundsWidth(ctx.bounds);
      const depth = boundsDepth(ctx.bounds);
      const points: PCGPoint[] = [];
      const maxAttempts = options.count * 12;
      for (let attempt = 0; attempt < maxAttempts && points.length < options.count; attempt += 1) {
        const x = ctx.bounds.minX + ctx.rng.next() * width;
        const z = ctx.bounds.minZ + ctx.rng.next() * depth;
        const cacheDensity = cacheDensityAt(ctx, x, z);
        const u = (x - ctx.bounds.minX) / Math.max(1e-6, width);
        const v = (z - ctx.bounds.minZ) / Math.max(1e-6, depth);
        const texel = nearest(options.values, options.textureWidth, options.textureHeight, u, v);
        const density = Math.min(cacheDensity, texel);
        if (density <= (options.threshold ?? 0) || ctx.rng.next() > density) {
          continue;
        }
        const point = makeGeneratedPoint(ctx, x, z, `${options.id}:${points.length}`);
        point.density *= density;
        point.attributes.textureDensity = texel;
        points.push(point);
      }
      return points;
    }
  };
}

export function jitterScale(point: PCGPoint, rng: SeededRandom, min: number, max: number): void {
  const value = rng.between(min, max);
  point.scale.multiplyScalar(value);
}

function nearest(values: ArrayLike<number>, width: number, height: number, u: number, v: number): number {
  const x = Math.max(0, Math.min(width - 1, Math.round(u * (width - 1))));
  const y = Math.max(0, Math.min(height - 1, Math.round(v * (height - 1))));
  return values[y * width + x] ?? 0;
}

function makeGeneratedPoint(ctx: PCGGraphContext, x: number, z: number, id: string): PCGPoint {
  const point = createPoint(contextSurface(ctx), x, z, {
    id,
    rngRotation: ctx.rng.between(0, Math.PI * 2),
    biomeId: ctx.biomeId,
    biomePriority: ctx.biomePriority
  });
  return point;
}

function cacheDensityAt(ctx: PCGGraphContext, x: number, z: number): number {
  const maybeCache = (ctx as PCGGraphContext & { cache?: { densityAt?: (x: number, z: number) => number } }).cache;
  return maybeCache?.densityAt ? maybeCache.densityAt(x, z) : 1;
}

function contextSurface(ctx: PCGGraphContext): PCGSurface {
  const maybeCtx = ctx as PCGGraphContext & { terrain?: PCGSurface };
  return maybeCtx.surface ?? maybeCtx.terrain;
}

function segmentLengths(points: Vec2[]): number[] {
  const lengths: number[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const a = points[index];
    const b = points[index + 1];
    lengths.push(a && b ? Math.hypot(b.x - a.x, b.z - a.z) : 0);
  }
  return lengths;
}

function pointAlongPolyline(points: Vec2[], lengths: number[], distance: number): Vec2 | undefined {
  let remaining = distance;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index] ?? 0;
    const a = points[index];
    const b = points[index + 1];
    if (!a || !b) {
      continue;
    }
    if (remaining <= length) {
      const t = length === 0 ? 0 : remaining / length;
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
    }
    remaining -= length;
  }
  return points.at(-1);
}
