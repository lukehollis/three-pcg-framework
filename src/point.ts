import * as THREE from "three";
import { computeSeedFromPosition } from "./random.js";
import type {
  PCGAttributes,
  PCGGraphContext,
  PCGPoint,
  PCGPointBounds,
  PCGSurface,
  PCGSurfaceSample,
  ScalarRange
} from "./types.js";

const UP = new THREE.Vector3(0, 1, 0);

export function createPoint(
  surface: PCGSurface,
  x: number,
  z: number,
  options: {
    id: string;
    rngRotation?: number | undefined;
    density?: number | undefined;
    scale?: number | THREE.Vector3 | undefined;
    bounds?: PCGPointBounds | undefined;
    boundsMin?: THREE.Vector3 | undefined;
    boundsMax?: THREE.Vector3 | undefined;
    color?: THREE.Color | string | undefined;
    steepness?: number | undefined;
    seed?: number | undefined;
    attributes?: PCGAttributes | undefined;
    biomeId?: string | undefined;
    biomePriority?: number | undefined;
    generatorId?: string | undefined;
    generatorType?: string | undefined;
    generatorSubtype?: string | undefined;
    generatorPriority?: number | undefined;
    allowOverlap?: boolean | undefined;
  }
): PCGPoint {
  const sample = surface.sampleAt(x, z);
  const scale =
    typeof options.scale === "number"
      ? new THREE.Vector3(options.scale, options.scale, options.scale)
      : options.scale?.clone() ?? new THREE.Vector3(1, 1, 1);
  const attributes: PCGAttributes = { ...(sample.attributes ?? {}), ...(options.attributes ?? {}) };
  attributes.sample = sampleToAttributes(sample);
  const defaultBounds: PCGPointBounds = { type: "box", extents: new THREE.Vector3(1, 1, 1) };
  const pointBounds = cloneBounds(options.bounds ?? defaultBounds);
  const boundsMin = options.boundsMin?.clone() ?? boundsMinFromPointBounds(pointBounds);
  const boundsMax = options.boundsMax?.clone() ?? boundsMaxFromPointBounds(pointBounds);

  const point: PCGPoint = {
    id: options.id,
    position: new THREE.Vector3(x, sample.height, z),
    rotationY: options.rngRotation ?? 0,
    scale,
    normal: sample.normal.clone(),
    density: options.density ?? 1,
    boundsMin,
    boundsMax,
    bounds: options.bounds ? pointBounds : pointBoundsFromMinMax(boundsMin, boundsMax),
    color: typeof options.color === "string" ? new THREE.Color(options.color) : options.color?.clone() ?? new THREE.Color(1, 1, 1),
    steepness: THREE.MathUtils.clamp(options.steepness ?? 0.5, 0, 1),
    seed: options.seed ?? computeSeedFromPosition(x, sample.height, z),
    biomePriority: options.biomePriority ?? 0,
    generatorPriority: options.generatorPriority ?? 0,
    priority: options.generatorPriority ?? 0,
    recursionLevel: 0,
    allowOverlap: options.allowOverlap ?? false,
    tags: new Set(),
    attributes
  };
  if (options.biomeId !== undefined) {
    point.biomeId = options.biomeId;
  }
  if (options.generatorId !== undefined) {
    point.generatorId = options.generatorId;
  }
  if (options.generatorType !== undefined) {
    point.generatorType = options.generatorType;
  }
  if (options.generatorSubtype !== undefined) {
    point.generatorSubtype = options.generatorSubtype;
  }
  return point;
}

export function createPointInContext(ctx: PCGGraphContext, x: number, z: number, id: string): PCGPoint {
  return createPoint(ctx.surface, x, z, {
    id,
    rngRotation: ctx.rng.between(0, Math.PI * 2),
    biomeId: ctx.biomeId,
    biomePriority: ctx.biomePriority
  });
}

export function clonePoint(point: PCGPoint, id = point.id): PCGPoint {
  const clone: PCGPoint = {
    id,
    position: point.position.clone(),
    rotationY: point.rotationY,
    scale: point.scale.clone(),
    normal: point.normal.clone(),
    density: point.density,
    boundsMin: point.boundsMin.clone(),
    boundsMax: point.boundsMax.clone(),
    bounds: cloneBounds(point.bounds),
    color: point.color.clone(),
    steepness: point.steepness,
    seed: point.seed,
    biomePriority: point.biomePriority,
    generatorPriority: point.generatorPriority,
    priority: point.priority,
    recursionLevel: point.recursionLevel,
    allowOverlap: point.allowOverlap,
    tags: new Set(point.tags),
    attributes: { ...point.attributes }
  };
  if (point.biomeId !== undefined) {
    clone.biomeId = point.biomeId;
  }
  if (point.generatorId !== undefined) {
    clone.generatorId = point.generatorId;
  }
  if (point.generator !== undefined) {
    clone.generator = point.generator;
  }
  if (point.generatorType !== undefined) {
    clone.generatorType = point.generatorType;
  }
  if (point.generatorSubtype !== undefined) {
    clone.generatorSubtype = point.generatorSubtype;
  }
  if (point.assetId !== undefined) {
    clone.assetId = point.assetId;
  }
  if (point.assetType !== undefined) {
    clone.assetType = point.assetType;
  }
  if (point.dataIndex !== undefined) {
    clone.dataIndex = point.dataIndex;
  }
  return clone;
}

export function cloneBounds(bounds: PCGPointBounds): PCGPointBounds {
  return bounds.type === "box" ? { type: "box", extents: bounds.extents.clone() } : { type: "sphere", radius: bounds.radius };
}

export function pointBoundsRadius(point: PCGPoint): number {
  const extents = getLocalDensityExtents(point);
  return Math.hypot(extents.x * Math.abs(point.scale.x), extents.z * Math.abs(point.scale.z));
}

export function pointBoundsAabb(point: PCGPoint): { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number } {
  return pointDensityBoundsAabb(point);
}

export function pointDensityBoundsAabb(point: PCGPoint): { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number } {
  const localMin = point.boundsMin.clone().multiplyScalar(2 - THREE.MathUtils.clamp(point.steepness, 0, 1));
  const localMax = point.boundsMax.clone().multiplyScalar(2 - THREE.MathUtils.clamp(point.steepness, 0, 1));
  const corners = [
    new THREE.Vector3(localMin.x, localMin.y, localMin.z),
    new THREE.Vector3(localMin.x, localMin.y, localMax.z),
    new THREE.Vector3(localMin.x, localMax.y, localMin.z),
    new THREE.Vector3(localMin.x, localMax.y, localMax.z),
    new THREE.Vector3(localMax.x, localMin.y, localMin.z),
    new THREE.Vector3(localMax.x, localMin.y, localMax.z),
    new THREE.Vector3(localMax.x, localMax.y, localMin.z),
    new THREE.Vector3(localMax.x, localMax.y, localMax.z)
  ];
  const matrix = composePointMatrix(point);
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const corner of corners) {
    corner.applyMatrix4(matrix);
    minX = Math.min(minX, corner.x);
    maxX = Math.max(maxX, corner.x);
    minY = Math.min(minY, corner.y);
    maxY = Math.max(maxY, corner.y);
    minZ = Math.min(minZ, corner.z);
    maxZ = Math.max(maxZ, corner.z);
  }
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

export function pointsOverlap(a: PCGPoint, b: PCGPoint, padding = 0): boolean {
  const aa = pointDensityBoundsAabb(a);
  const bb = pointDensityBoundsAabb(b);
  return (
    aa.minX - padding <= bb.maxX &&
    aa.maxX + padding >= bb.minX &&
    aa.minY - padding <= bb.maxY &&
    aa.maxY + padding >= bb.minY &&
    aa.minZ - padding <= bb.maxZ &&
    aa.maxZ + padding >= bb.minZ
  );
}

export function circleOverlapsAny(
  x: number,
  z: number,
  radius: number,
  blockers: Array<{ x: number; z: number; radius: number }>
): boolean {
  for (const blocker of blockers) {
    const combined = radius + blocker.radius;
    const dx = x - blocker.x;
    const dz = z - blocker.z;
    if (dx * dx + dz * dz < combined * combined) {
      return true;
    }
  }
  return false;
}

export function applyPointScale(point: PCGPoint, range: ScalarRange | undefined, verticalRange: ScalarRange | undefined, rng: { range: (range: ScalarRange) => number }): void {
  if (!range && !verticalRange) {
    return;
  }
  const horizontal = range ? rng.range(range) : 1;
  const vertical = verticalRange ? rng.range(verticalRange) : 1;
  point.scale.multiply(new THREE.Vector3(horizontal, horizontal * vertical, horizontal));
}

export function projectPointToSurface(point: PCGPoint, surface: PCGSurface, yOffset = 0): void {
  const sample = surface.sampleAt(point.position.x, point.position.z);
  point.position.y = sample.height + yOffset;
  point.normal.copy(sample.normal);
  point.attributes.sample = sampleToAttributes(sample);
}

export function getLocalCenter(point: PCGPoint): THREE.Vector3 {
  return point.boundsMin.clone().add(point.boundsMax).multiplyScalar(0.5);
}

export function getLocalExtents(point: PCGPoint): THREE.Vector3 {
  return point.boundsMax.clone().sub(point.boundsMin).multiplyScalar(0.5);
}

export function setLocalExtents(point: PCGPoint, extents: THREE.Vector3): void {
  const center = getLocalCenter(point);
  point.boundsMin.copy(center).sub(extents);
  point.boundsMax.copy(center).add(extents);
  point.bounds = pointBoundsFromMinMax(point.boundsMin, point.boundsMax);
}

export function getLocalDensityExtents(point: PCGPoint): THREE.Vector3 {
  return getLocalExtents(point).multiplyScalar(2 - THREE.MathUtils.clamp(point.steepness, 0, 1));
}

export function applyScaleToBounds(point: PCGPoint): void {
  const absScale = new THREE.Vector3(Math.abs(point.scale.x), Math.abs(point.scale.y), Math.abs(point.scale.z));
  point.boundsMin.multiply(absScale);
  point.boundsMax.multiply(absScale);
  point.scale.set(Math.sign(point.scale.x) || 1, Math.sign(point.scale.y) || 1, Math.sign(point.scale.z) || 1);
  point.bounds = pointBoundsFromMinMax(point.boundsMin, point.boundsMax);
}

export function multiplyExtents(point: PCGPoint, multiplier: number | THREE.Vector3): void {
  const factor = typeof multiplier === "number" ? new THREE.Vector3(multiplier, multiplier, multiplier) : multiplier;
  setLocalExtents(point, getLocalExtents(point).multiply(factor));
}

export function composePointMatrix(point: PCGPoint): THREE.Matrix4 {
  const align = new THREE.Quaternion().setFromUnitVectors(UP, point.normal);
  const yaw = new THREE.Quaternion().setFromAxisAngle(UP, point.rotationY);
  return new THREE.Matrix4().compose(point.position, align.multiply(yaw), point.scale);
}

export function groupPointsByAsset(points: PCGPoint[]): Map<string, PCGPoint[]> {
  const grouped = new Map<string, PCGPoint[]>();
  for (const point of points) {
    if (!point.assetId) {
      continue;
    }
    const bucket = grouped.get(point.assetId) ?? [];
    bucket.push(point);
    grouped.set(point.assetId, bucket);
  }
  return grouped;
}

function sampleToAttributes(sample: PCGSurfaceSample): PCGAttributes {
  const attributes: PCGAttributes = {
    x: sample.x,
    z: sample.z,
    height: sample.height,
    normalX: sample.normal.x,
    normalY: sample.normal.y,
    normalZ: sample.normal.z
  };
  if (sample.slope !== undefined) {
    attributes.slope = sample.slope;
  }
  return attributes;
}

export function pointBoundsFromMinMax(boundsMin: THREE.Vector3, boundsMax: THREE.Vector3): PCGPointBounds {
  return { type: "box", extents: boundsMax.clone().sub(boundsMin).multiplyScalar(0.5) };
}

function boundsMinFromPointBounds(bounds: PCGPointBounds): THREE.Vector3 {
  return bounds.type === "box" ? bounds.extents.clone().multiplyScalar(-1) : new THREE.Vector3(-bounds.radius, -bounds.radius, -bounds.radius);
}

function boundsMaxFromPointBounds(bounds: PCGPointBounds): THREE.Vector3 {
  return bounds.type === "box" ? bounds.extents.clone() : new THREE.Vector3(bounds.radius, bounds.radius, bounds.radius);
}
