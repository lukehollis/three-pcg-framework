import * as THREE from "three";
import { clonePoint, getLocalDensityExtents, pointsOverlap } from "./point.js";
import type { PCGPoint } from "./types.js";

export type PCGSelfPruningType = "LargeToSmall" | "SmallToLarge" | "AllEqual" | "None" | "RemoveDuplicates";

export interface PCGSelfPruningOptions {
  pruningType?: PCGSelfPruningType;
  radiusSimilarityFactor?: number;
  randomizedPruning?: boolean;
  comparison?: (point: PCGPoint) => number;
}

export interface PCGSelfPruningResult {
  points: PCGPoint[];
  rejected: PCGPoint[];
}

export function selfPrune(points: PCGPoint[], options: PCGSelfPruningOptions = {}): PCGSelfPruningResult {
  const pruningType = options.pruningType ?? "LargeToSmall";
  if (pruningType === "None") {
    return { points: [...points], rejected: [] };
  }

  const sorted = [...points];
  if (pruningType === "RemoveDuplicates") {
    if (options.randomizedPruning ?? true) {
      sorted.sort((a, b) => a.seed - b.seed);
    }
  } else if (pruningType === "AllEqual") {
    if (options.randomizedPruning ?? true) {
      sorted.sort((a, b) => a.seed - b.seed);
    }
  } else {
    sorted.sort((a, b) => compareForPruning(a, b, pruningType, options));
  }

  const accepted: PCGPoint[] = [];
  const rejected: PCGPoint[] = [];
  for (const point of sorted) {
    const overlapsAccepted =
      pruningType === "RemoveDuplicates"
        ? accepted.some((acceptedPoint) => samePosition(point, acceptedPoint))
        : accepted.some((acceptedPoint) => pointsOverlap(point, acceptedPoint));

    if (overlapsAccepted) {
      rejected.push(point);
    } else {
      accepted.push(point);
    }
  }

  return {
    points: restoreOriginalOrder(accepted, points),
    rejected: restoreOriginalOrder(rejected, points)
  };
}

export function differenceByRecursionLevel(points: PCGPoint[]): PCGSelfPruningResult {
  const accepted: PCGPoint[] = [];
  const rejected: PCGPoint[] = [];
  const sorted = [...points].sort((a, b) => a.recursionLevel - b.recursionLevel || a.seed - b.seed);

  for (const point of sorted) {
    const blocked = accepted.some((other) => other.recursionLevel < point.recursionLevel && pointsOverlap(point, other));
    if (blocked) {
      rejected.push(point);
    } else {
      accepted.push(point);
    }
  }

  return {
    points: restoreOriginalOrder(accepted, points),
    rejected: restoreOriginalOrder(rejected, points)
  };
}

export function cloneAndSelfPrune(points: PCGPoint[], options: PCGSelfPruningOptions = {}): PCGSelfPruningResult {
  return selfPrune(points.map((point) => clonePoint(point)), options);
}

function compareForPruning(a: PCGPoint, b: PCGPoint, pruningType: PCGSelfPruningType, options: PCGSelfPruningOptions): number {
  const radiusEquality = 1 + (options.radiusSimilarityFactor ?? 0.25);
  const squaredRadiusEquality = radiusEquality * radiusEquality;
  const comparison = options.comparison ?? scaledDensityExtentsLengthSq;
  const av = comparison(a);
  const bv = comparison(b);
  const randomized = options.randomizedPruning ?? true;

  const aLess = av * squaredRadiusEquality < bv;
  const bLess = bv * squaredRadiusEquality < av;
  if (aLess !== bLess) {
    const ascending = pruningType === "SmallToLarge";
    return aLess === ascending ? -1 : 1;
  }

  if (randomized) {
    return a.seed - b.seed;
  }

  if (av !== bv) {
    return pruningType === "SmallToLarge" ? av - bv : bv - av;
  }
  return a.id.localeCompare(b.id);
}

function scaledDensityExtentsLengthSq(point: PCGPoint): number {
  const extents = getLocalDensityExtents(point).multiply(new THREE.Vector3(Math.abs(point.scale.x), Math.abs(point.scale.y), Math.abs(point.scale.z)));
  return extents.lengthSq();
}

function samePosition(a: PCGPoint, b: PCGPoint): boolean {
  return a.position.distanceToSquared(b.position) <= Number.EPSILON;
}

function restoreOriginalOrder(subset: PCGPoint[], original: PCGPoint[]): PCGPoint[] {
  const set = new Set(subset);
  return original.filter((point) => set.has(point));
}
