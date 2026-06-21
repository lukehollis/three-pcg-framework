import * as THREE from "three";
import { computeSeed, pickWeighted, SeededRandom } from "./random.js";
import { cloneBounds, pointBoundsFromMinMax } from "./point.js";
import type { PCGAssetEntry, PCGPoint, PCGRootAssetTable } from "./types.js";

export function createRootAssetTable(assets: PCGAssetEntry[]): PCGRootAssetTable {
  const byId = new Map<string, PCGAssetEntry>();
  for (const asset of assets) {
    if (byId.has(asset.id)) {
      throw new Error(`Duplicate PCG asset id "${asset.id}".`);
    }
    byId.set(asset.id, asset);
  }
  return { entries: [...assets], byId };
}

export function queryAssetsForPoint(table: PCGRootAssetTable, point: PCGPoint): PCGAssetEntry[] {
  return table.entries.filter((asset) => {
    if (asset.generator && asset.generator !== point.generator && asset.generator !== point.generatorId) {
      return false;
    }
    if (asset.generatorType && asset.generatorType !== point.generatorType) {
      return false;
    }
    if (asset.generatorSubtype && asset.generatorSubtype !== point.generatorSubtype) {
      return false;
    }
    if (!rangeMatches(asset.densityRange, point.density)) {
      return false;
    }
    if (!rangeMatches(asset.waterDistanceRange, numberAttribute(point, "waterDistance"))) {
      return false;
    }
    if (!rangeMatches(asset.sunExposureRange, numberAttribute(point, "sunExposure"))) {
      return false;
    }
    if (!rangeMatches(asset.flowRange, numberAttribute(point, "flow"))) {
      return false;
    }
    if (!rangeMatches(asset.heightRange, point.position.y)) {
      return false;
    }
    return true;
  });
}

export function selectAssetForPoint(table: PCGRootAssetTable, point: PCGPoint, settingsSeed: SeededRandom | string | number): PCGAssetEntry | undefined {
  const matches = queryAssetsForPoint(table, point);
  if (matches.length === 0) {
    return undefined;
  }
  return pickWeighted(matches, new SeededRandom(computeSeed(point.seed, stableSeed(settingsSeed))));
}

export function assignAssetToPoint(point: PCGPoint, asset: PCGAssetEntry): PCGPoint {
  point.assetId = asset.id;
  point.attributes.Asset = asset.assetPath ?? asset.id;
  point.attributes.AssetID = asset.id;
  if (asset.type !== undefined) {
    point.assetType = asset.type;
    point.attributes.AssetType = asset.type;
  }
  if (asset.generator !== undefined) {
    point.generator = asset.generator;
    point.attributes.Generator = asset.generator;
  }
  if (asset.generatorType !== undefined) {
    point.generatorType = asset.generatorType;
    point.attributes.GeneratorType = asset.generatorType;
  }
  if (asset.generatorSubtype !== undefined) {
    point.generatorSubtype = asset.generatorSubtype;
    point.attributes.GeneratorSubType = asset.generatorSubtype;
  }
  if (asset.priority !== undefined) {
    point.generatorPriority = asset.priority;
    point.priority = asset.priority;
  }
  if (asset.allowOverlap !== undefined) {
    point.allowOverlap = asset.allowOverlap;
  }
  if (asset.boundsMin && asset.boundsMax) {
    point.boundsMin = asset.boundsMin.clone();
    point.boundsMax = asset.boundsMax.clone();
    point.bounds = pointBoundsFromMinMax(point.boundsMin, point.boundsMax);
  }
  if (asset.bounds) {
    point.bounds = cloneBounds(asset.bounds);
    if (asset.bounds.type === "box") {
      point.boundsMin = asset.bounds.extents.clone().multiplyScalar(-1);
      point.boundsMax = asset.bounds.extents.clone();
    } else {
      point.boundsMin = new THREE.Vector3(-asset.bounds.radius, -asset.bounds.radius, -asset.bounds.radius);
      point.boundsMax = new THREE.Vector3(asset.bounds.radius, asset.bounds.radius, asset.bounds.radius);
    }
  }
  const boundsScale = asset.boundsScale ?? asset.extentsMultiplier;
  if (boundsScale !== undefined) {
    if (point.bounds.type === "sphere") {
      point.bounds.radius *= boundsScale;
    } else {
      point.bounds.extents.multiplyScalar(boundsScale);
    }
    point.boundsMin.multiplyScalar(boundsScale);
    point.boundsMax.multiplyScalar(boundsScale);
    point.attributes.ExtentsMultiplier = boundsScale;
  }
  if (asset.yOffset !== undefined) {
    point.position.y += asset.yOffset;
  }
  if (asset.biomeColor) {
    const color = typeof asset.biomeColor === "string" ? new THREE.Color(asset.biomeColor) : asset.biomeColor;
    point.color.copy(color);
    point.attributes.BiomeColor = color.getHexString();
  }
  if (asset.orientUpward !== undefined) {
    point.attributes.OrientUpward = asset.orientUpward;
  }
  if (asset.dataIndex !== undefined) {
    point.dataIndex = asset.dataIndex;
    point.attributes.DataIndex = asset.dataIndex;
  }
  point.attributes.BoundsMin = point.boundsMin.clone();
  point.attributes.BoundsMax = point.boundsMax.clone();
  point.attributes.Transform = point.position.clone();
  point.attributes.PRIO = point.priority;
  point.attributes.GeneratorPriority = point.generatorPriority;
  point.attributes.RecursionLevel = point.recursionLevel;
  if (point.biomeId !== undefined) {
    point.attributes.BIOME = point.biomeId;
  }
  point.attributes.BIOMEPRIO = point.biomePriority;
  if (asset.attributes) {
    Object.assign(point.attributes, asset.attributes);
  }
  return point;
}

export function assetColorMatches(asset: PCGAssetEntry, color: THREE.Color | undefined, tolerance = 0.1): boolean {
  if (!asset.biomeColor || !color) {
    return true;
  }
  const assetColor = typeof asset.biomeColor === "string" ? new THREE.Color(asset.biomeColor) : asset.biomeColor;
  return colorDistance(assetColor, color) <= tolerance;
}

function colorDistance(a: THREE.Color, b: THREE.Color): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.hypot(dr, dg, db);
}

function rangeMatches(range: PCGAssetEntry["densityRange"], value: number | undefined): boolean {
  if (!range) {
    return true;
  }
  if (value === undefined || Number.isNaN(value)) {
    return false;
  }
  return value >= range.min && value <= range.max;
}

function numberAttribute(point: PCGPoint, key: string): number | undefined {
  const direct = point.attributes[key];
  if (typeof direct === "number") {
    return direct;
  }
  const sample = point.attributes.sample;
  if (typeof sample === "object" && sample !== null && !Array.isArray(sample)) {
    const value = (sample as Record<string, unknown>)[key];
    if (typeof value === "number") {
      return value;
    }
  }
  return undefined;
}

function stableSeed(seed: SeededRandom | string | number): number {
  if (seed instanceof SeededRandom) {
    return seed.getInitialSeed();
  }
  return typeof seed === "number" ? seed : new SeededRandom(seed).getInitialSeed();
}
