import * as THREE from "three";
import { pickWeighted, type SeededRandom } from "./random.js";
import { centeredBounds } from "./spatial.js";
import type { PCGBounds2D, PCGPoint, PCGSurfaceSample, ScalarRange } from "./types.js";
import type { PointFilter } from "./filters.js";
import type { Generator } from "./generators.js";
import { circleOverlapsAny } from "./point.js";

const UP = new THREE.Vector3(0, 1, 0);

export type BiomeBounds = PCGBounds2D;

export interface BiomeTerrainLike {
  sampleAt(x: number, z: number): PCGSurfaceSample;
}

export interface BiomePoint extends PCGPoint {
  sample: PCGSurfaceSample;
}

export interface BiomeContext {
  terrain: BiomeTerrainLike;
  size: number;
  bounds: BiomeBounds;
  rng: SeededRandom;
}

export interface WeightedAsset {
  assetId: string;
  weight?: number;
  scale?: ScalarRange;
}

export interface BiomePlacement {
  assetId: string;
  position: THREE.Vector3;
  rotationY: number;
  scale: THREE.Vector3;
  normal?: THREE.Vector3;
  userData?: Record<string, unknown>;
}

export interface Obstacle {
  x: number;
  z: number;
  radius: number;
}

export interface ChildSpawnRule {
  assetId: string;
  count: ScalarRange;
  radius: ScalarRange;
  scale?: ScalarRange;
  align?: "up" | "terrain";
}

export interface BiomeLayer {
  id: string;
  priority: number;
  generators: Generator[];
  filters: PointFilter[];
  assets: WeightedAsset[];
  align?: "up" | "terrain";
  yOffset?: number;
  verticalJitter?: ScalarRange;
  selfSpacing?: (assetId: string) => number;
  obstacleFactor?: number;
  children?: ChildSpawnRule[];
}

export interface BiomeDefinition {
  id: string;
  layers: BiomeLayer[];
  /** Compatibility mode defaults to the original helper's descending priority. */
  priorityOrder?: "ascending" | "descending";
}

export interface BiomeRunResult {
  placements: BiomePlacement[];
}

export { centeredBounds };

export function makePoint(terrain: BiomeTerrainLike, x: number, z: number, rng: SeededRandom): BiomePoint {
  const sample = terrain.sampleAt(x, z);
  const attributes = { ...sample, sample };
  return {
    id: `point:${x.toFixed(3)}:${z.toFixed(3)}`,
    position: new THREE.Vector3(x, sample.height, z),
    normal: sample.normal.clone(),
    rotationY: rng.between(0, Math.PI * 2),
    scale: new THREE.Vector3(1, 1, 1),
    density: 1,
    boundsMin: new THREE.Vector3(-0.5, -0.5, -0.5),
    boundsMax: new THREE.Vector3(0.5, 0.5, 0.5),
    bounds: { type: "sphere", radius: 0.5 },
    color: new THREE.Color(1, 1, 1),
    steepness: 0.5,
    seed: Math.floor(rng.next() * 0xffffffff),
    biomePriority: 0,
    generatorPriority: 0,
    priority: 0,
    recursionLevel: 0,
    allowOverlap: false,
    tags: new Set(),
    attributes,
    sample
  };
}

export function runBiomeDefinition(
  definition: BiomeDefinition,
  ctx: BiomeContext,
  obstacles: Obstacle[]
): BiomeRunResult {
  const placements: BiomePlacement[] = [];
  const layers = [...definition.layers].sort((a, b) =>
    definition.priorityOrder === "ascending" ? a.priority - b.priority : b.priority - a.priority
  );

  for (const layer of layers) {
    const layerRng = ctx.rng.fork(layer.id);
    const layerCtx = { ...ctx, rng: layerRng } as BiomeContext;
    const localObstacles: Obstacle[] = [];

    const candidates: BiomePoint[] = [];
    for (const generator of layer.generators) {
      candidates.push(...(generator.generate(layerCtx as never) as BiomePoint[]));
    }

    for (const point of candidates) {
      const density = point.density * runPointFilters(layer.filters, point, layerCtx);
      if (density <= 0 || layerRng.next() > density) {
        continue;
      }

      const asset = pickWeighted(layer.assets, layerRng);
      const x = point.position.x;
      const z = point.position.z;
      const selfRadius = layer.selfSpacing?.(asset.assetId) ?? 0;

      if (selfRadius > 0 && circleOverlapsAny(x, z, selfRadius, localObstacles)) {
        continue;
      }
      if (circleOverlapsAny(x, z, 0, obstacles)) {
        continue;
      }

      const placement = toPlacement(layer, asset, point, layerRng);
      placements.push(placement);

      if (selfRadius > 0) {
        localObstacles.push({ x, z, radius: selfRadius });
        obstacles.push({ x, z, radius: selfRadius * (layer.obstacleFactor ?? 0.7) });
      }

      if (layer.children) {
        spawnChildren(layer.children, placement, layerCtx, placements);
      }
    }
  }

  return { placements };
}

function runPointFilters(filters: PointFilter[], point: BiomePoint, ctx: BiomeContext): number {
  let density = 1;
  for (const filter of filters) {
    density *= filter(point, ctx as never);
    if (density <= 0) {
      return 0;
    }
  }
  return density;
}

function toPlacement(
  layer: BiomeLayer,
  asset: WeightedAsset,
  point: BiomePoint,
  rng: SeededRandom
): BiomePlacement {
  const base = asset.scale ? rng.range(asset.scale) : point.scale.x;
  const vertical = layer.verticalJitter ? rng.range(layer.verticalJitter) : 1;
  const normal = layer.align === "terrain" ? point.normal.clone() : UP.clone();
  return {
    assetId: asset.assetId,
    position: new THREE.Vector3(point.position.x, point.position.y + (layer.yOffset ?? 0), point.position.z),
    rotationY: point.rotationY,
    scale: new THREE.Vector3(base, base * vertical, base),
    normal
  };
}

function spawnChildren(
  rules: ChildSpawnRule[],
  parent: BiomePlacement,
  ctx: BiomeContext,
  out: BiomePlacement[]
): void {
  for (const rule of rules) {
    const count = Math.round(ctx.rng.range(rule.count));
    for (let index = 0; index < count; index += 1) {
      const angle = ctx.rng.between(0, Math.PI * 2);
      const radius = ctx.rng.range(rule.radius);
      const x = parent.position.x + Math.cos(angle) * radius;
      const z = parent.position.z + Math.sin(angle) * radius;
      const sample = ctx.terrain.sampleAt(x, z);
      const scale = rule.scale ? ctx.rng.range(rule.scale) : 1;
      out.push({
        assetId: rule.assetId,
        position: new THREE.Vector3(x, sample.height, z),
        rotationY: ctx.rng.between(0, Math.PI * 2),
        scale: new THREE.Vector3(scale, scale, scale),
        normal: rule.align === "terrain" ? sample.normal.clone() : UP.clone()
      });
    }
  }
}
