import * as THREE from "three";
import type { PCGBiomeCache, PCGGraphContext, PCGPoint, PCGPointFilter, PCGSpatialMask } from "./types.js";

const smooth = THREE.MathUtils.smoothstep;

export type PointFilter = PCGPointFilter;

export function combineFilters(filters: PCGPointFilter[]): PCGPointFilter {
  return (point, ctx, asset) => {
    let density = 1;
    for (const filter of filters) {
      density *= filter(point, ctx, asset);
      if (density <= 0) {
        return 0;
      }
    }
    return density;
  };
}

export function heightFilter(min: number, max: number, feather = 1): PCGPointFilter {
  return (point) => {
    const y = point.position.y;
    return smooth(y, min - feather, min + feather) * (1 - smooth(y, max - feather, max + feather));
  };
}

export function slopeFilter(maxSlope: number, feather = 0.06): PCGPointFilter {
  return (point) => {
    const slope = numberAttribute(point, "slope", 1 - Math.max(0, Math.min(1, point.normal.y)));
    return 1 - smooth(slope, maxSlope - feather, maxSlope + feather);
  };
}

export function densityFilter(min = 0, max = 1): PCGPointFilter {
  return (point) => (point.density >= min && point.density <= max ? 1 : 0);
}

export function attributeRangeFilter(attribute: string, min: number, max: number, feather = 0): PCGPointFilter {
  return (point) => {
    const value = numberAttribute(point, attribute, Number.NaN);
    if (Number.isNaN(value)) {
      return 0;
    }
    if (feather <= 0) {
      return value >= min && value <= max ? 1 : 0;
    }
    return smooth(value, min - feather, min + feather) * (1 - smooth(value, max - feather, max + feather));
  };
}

export function maskFilter(mask: PCGSpatialMask): PCGPointFilter {
  return (point) => mask.densityAt(point.position.x, point.position.z);
}

export function cacheFilter(): PCGPointFilter {
  return (point, ctx) => optionalCache(ctx)?.densityAt(point.position.x, point.position.z) ?? 1;
}

export function pathDistanceFilter(min: number, max = Number.POSITIVE_INFINITY): PCGPointFilter {
  return (point) => {
    const d = numberAttribute(point, "pathDistance", Number.POSITIVE_INFINITY);
    return d >= min && d <= max ? 1 : 0;
  };
}

export function nearPathFilter(falloff: number): PCGPointFilter {
  return (point) => 1 - smooth(numberAttribute(point, "pathDistance", falloff), 1, falloff);
}

export function waterDistanceFilter(min: number): PCGPointFilter {
  return (point) => (numberAttribute(point, "waterDistance", Number.POSITIVE_INFINITY) < min ? 0 : 1);
}

export function radialFilter(inner: number, outer: number): PCGPointFilter {
  return (point) => smooth(numberAttribute(point, "radial", 0), inner, outer);
}

export function edgeGuard(maxRadial = 0.97): PCGPointFilter {
  return (point) => (numberAttribute(point, "radial", 0) > maxRadial ? 0 : 1);
}

export function densityNoiseFilter(low: number, high: number, source: "moisture" | "flower" | string = "flower"): PCGPointFilter {
  return (point) => {
    const attribute = source === "flower" ? "flowerField" : source;
    return smooth(numberAttribute(point, attribute, 0), low, high);
  };
}

export function biomeColorFilter(color: THREE.Color | string, tolerance = 0.1): PCGPointFilter {
  const target = typeof color === "string" ? new THREE.Color(color) : color;
  return (_point, ctx) => {
    const cache = optionalCache(ctx);
    if (!cache?.color) {
      return 0;
    }
    return colorDistance(cache.color, target) <= tolerance ? 1 : 0;
  };
}

export function applyFilterFeedback(
  points: PCGPoint[],
  filters: PCGPointFilter[],
  ctx: PCGGraphContext,
  options: { probabilistic?: boolean } = {}
): PCGPoint[] {
  let remaining = points;
  for (const filter of filters) {
    const next: PCGPoint[] = [];
    for (const point of remaining) {
      const multiplier = THREE.MathUtils.clamp(filter(point, ctx), 0, 1);
      point.density *= multiplier;
      if (point.density <= 0) {
        continue;
      }
      if (options.probabilistic && ctx.rng.next() > point.density) {
        continue;
      }
      next.push(point);
    }
    remaining = next;
  }
  return remaining;
}

function numberAttribute(point: PCGPoint, key: string, fallback: number): number {
  const direct = point.attributes[key];
  if (typeof direct === "number") {
    return direct;
  }
  const sample = point.attributes.sample;
  if (isRecord(sample)) {
    const value = sample[key];
    if (typeof value === "number") {
      return value;
    }
  }
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function colorDistance(a: THREE.Color, b: THREE.Color): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.hypot(dr, dg, db);
}

function optionalCache(ctx: PCGGraphContext): PCGBiomeCache | undefined {
  return (ctx as PCGGraphContext & { cache?: PCGBiomeCache }).cache;
}
