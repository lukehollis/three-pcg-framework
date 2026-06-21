import * as THREE from "three";
import { pickWeighted } from "./random.js";
import { assignAssetToPoint } from "./asset-table.js";
import { applyFilterFeedback } from "./filters.js";
import { clonePoint, projectPointToSurface } from "./point.js";
import type {
  PCGAssetEntry,
  PCGChildAssetRule,
  PCGGraphContext,
  PCGPoint,
  PCGPointFilter,
  PCGRootAssetTable,
  PCGTransformGraph,
  ScalarRange
} from "./types.js";

export function offsetTransform(offset: THREE.Vector3): PCGTransformGraph {
  return (points) =>
    points.map((point) => {
      const clone = clonePoint(point, `${point.id}:offset`);
      clone.position.add(offset);
      return clone;
    });
}

export function jitterTransform(options: {
  radius?: number;
  y?: ScalarRange;
  scale?: ScalarRange;
  rotation?: ScalarRange;
  projectToSurface?: boolean;
}): PCGTransformGraph {
  return (points, ctx) =>
    points.map((point, index) => {
      const clone = clonePoint(point, `${point.id}:jitter:${index}`);
      const angle = ctx.rng.between(0, Math.PI * 2);
      const radius = ctx.rng.between(0, options.radius ?? 0);
      clone.position.x += Math.cos(angle) * radius;
      clone.position.z += Math.sin(angle) * radius;
      if (options.y) {
        clone.position.y += ctx.rng.range(options.y);
      }
      if (options.scale) {
        clone.scale.multiplyScalar(ctx.rng.range(options.scale));
      }
      if (options.rotation) {
        clone.rotationY += ctx.rng.range(options.rotation);
      }
      if (options.projectToSurface) {
        projectPointToSurface(clone, ctx.surface);
      }
      return clone;
    });
}

export function duplicatePatternTransform(options: {
  copies: number;
  radius: ScalarRange;
  rotationStep?: number;
  scaleMultiplier?: number;
  projectToSurface?: boolean;
}): PCGTransformGraph {
  return (points, ctx) => {
    const out: PCGPoint[] = [];
    for (const point of points) {
      for (let index = 0; index < options.copies; index += 1) {
        const angle = point.rotationY + (options.rotationStep ?? (Math.PI * 2) / Math.max(1, options.copies)) * index;
        const radius = ctx.rng.range(options.radius);
        const clone = clonePoint(point, `${point.id}:dup:${index}`);
        clone.position.x += Math.cos(angle) * radius;
        clone.position.z += Math.sin(angle) * radius;
        clone.rotationY = angle;
        if (options.scaleMultiplier !== undefined) {
          clone.scale.multiplyScalar(options.scaleMultiplier);
        }
        if (options.projectToSurface) {
          projectPointToSurface(clone, ctx.surface);
        }
        out.push(clone);
      }
    }
    return out;
  };
}

export function scatterAroundParentTransform(options: {
  count: ScalarRange;
  radius: ScalarRange;
  scale?: ScalarRange;
  projectToSurface?: boolean;
}): PCGTransformGraph {
  return (points, ctx) => {
    const out: PCGPoint[] = [];
    for (const point of points) {
      const count = Math.max(0, Math.round(ctx.rng.range(options.count)));
      for (let index = 0; index < count; index += 1) {
        const angle = ctx.rng.between(0, Math.PI * 2);
        const radius = ctx.rng.range(options.radius);
        const clone = clonePoint(point, `${point.id}:child:${index}`);
        clone.position.x += Math.cos(angle) * radius;
        clone.position.z += Math.sin(angle) * radius;
        clone.rotationY = ctx.rng.between(0, Math.PI * 2);
        if (options.scale) {
          clone.scale.setScalar(ctx.rng.range(options.scale));
        }
        if (options.projectToSurface ?? true) {
          projectPointToSurface(clone, ctx.surface);
        }
        out.push(clone);
      }
    }
    return out;
  };
}

export function runRecursiveChildTransforms(options: {
  parents: PCGPoint[];
  ctx: PCGGraphContext;
  assetTable: PCGRootAssetTable;
  maxDepth: number;
  childFilters?: PCGPointFilter[];
  childInputRateMultiplier?: number;
}): PCGPoint[] {
  const out: PCGPoint[] = [];
  const visit = (parentPoints: PCGPoint[], parentAsset: PCGAssetEntry, depth: number): void => {
    if (depth >= options.maxDepth || !parentAsset.children || parentAsset.children.length === 0 || parentPoints.length === 0) {
      return;
    }

    const childSource = thinParentPoints(parentPoints, options.ctx, options.childInputRateMultiplier ?? 1);
    for (const parentPoint of childSource) {
      const rule = pickWeighted(parentAsset.children, options.ctx.rng);
      const childAsset = options.assetTable.byId.get(rule.assetId);
      if (!childAsset) {
        continue;
      }
      const transformed = createChildPoints(parentPoint, rule, options.ctx, childAsset, depth);
      const filtered = options.childFilters?.length
        ? applyFilterFeedback(transformed, options.childFilters, options.ctx, { probabilistic: true })
        : transformed;
      for (const child of filtered) {
        child.recursionLevel = depth + 1;
        child.attributes.RecursionLevel = child.recursionLevel;
        assignAssetToPoint(child, childAsset);
        out.push(child);
      }
      visit(filtered, childAsset, depth + 1);
    }
  };

  for (const point of options.parents) {
    if (!point.assetId) {
      continue;
    }
    const asset = options.assetTable.byId.get(point.assetId);
    if (asset) {
      visit([point], asset, 0);
    }
  }
  return out;
}

export function expandAssemblies(points: PCGPoint[], assetTable: PCGRootAssetTable): PCGPoint[] {
  const out: PCGPoint[] = [];
  for (const point of points) {
    const asset = point.assetId ? assetTable.byId.get(point.assetId) : undefined;
    if (!asset?.assembly?.length) {
      out.push(point);
      continue;
    }
    for (let index = 0; index < asset.assembly.length; index += 1) {
      const assembly = asset.assembly[index];
      if (!assembly) {
        continue;
      }
      const clone = clonePoint(point, `${point.id}:assembly:${index}`);
      clone.assetId = assembly.assetId;
      if (assembly.offset) {
        clone.position.add(assembly.offset);
      }
      if (assembly.rotationY !== undefined) {
        clone.rotationY += assembly.rotationY;
      }
      if (assembly.scale) {
        clone.scale.multiply(assembly.scale);
      }
      if (assembly.attributes) {
        Object.assign(clone.attributes, assembly.attributes);
      }
      out.push(clone);
    }
  }
  return out;
}

function createChildPoints(
  parent: PCGPoint,
  rule: PCGChildAssetRule,
  ctx: PCGGraphContext,
  childAsset: PCGAssetEntry,
  depth: number
): PCGPoint[] {
  const base = clonePoint(parent, `${parent.id}:child-root:${depth}`);
  base.assetId = childAsset.id;
  base.recursionLevel = depth + 1;
  base.attributes.RecursionLevel = base.recursionLevel;
  if (rule.attributes) {
    Object.assign(base.attributes, rule.attributes);
  }

  if (rule.transform) {
    return rule.transform([base], ctx, childAsset, depth + 1);
  }
  if (childAsset.transform) {
    return childAsset.transform([base], ctx, childAsset, depth + 1);
  }

  const count = Math.max(0, Math.round(ctx.rng.range(rule.count ?? { min: 1, max: 1 })));
  const out: PCGPoint[] = [];
  for (let index = 0; index < count; index += 1) {
    const angle = ctx.rng.between(0, Math.PI * 2);
    const radius = ctx.rng.range(rule.radius ?? { min: 0, max: 0 });
    const child = clonePoint(base, `${base.id}:${index}`);
    child.recursionLevel = depth + 1;
    child.attributes.RecursionLevel = child.recursionLevel;
    child.position.x += Math.cos(angle) * radius;
    child.position.z += Math.sin(angle) * radius;
    child.rotationY = ctx.rng.between(0, Math.PI * 2);
    if (rule.scale) {
      child.scale.setScalar(ctx.rng.range(rule.scale));
    }
    projectPointToSurface(child, ctx.surface, childAsset.yOffset ?? 0);
    out.push(child);
  }
  return out;
}

function thinParentPoints(points: PCGPoint[], ctx: PCGGraphContext, rate: number): PCGPoint[] {
  if (rate >= 1) {
    return points;
  }
  return points.filter(() => ctx.rng.next() <= rate);
}
