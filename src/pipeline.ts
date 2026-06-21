import { assignAssetToPoint, assetColorMatches, createRootAssetTable, selectAssetForPoint } from "./asset-table.js";
import { applyFilterFeedback } from "./filters.js";
import { applyPointScale, clonePoint, projectPointToSurface } from "./point.js";
import { computeSeed } from "./random.js";
import { expandAssemblies, runRecursiveChildTransforms } from "./transforms.js";
import type {
  PCGAssetEntry,
  PCGGraphContext,
  PCGLocalBiomeDefinition,
  PCGLocalBiomeResult,
  PCGPoint
} from "./types.js";

export function runLocalBiomeCore(definition: PCGLocalBiomeDefinition): PCGLocalBiomeResult {
  const assetTable = createRootAssetTable(definition.assets);
  const ctx: PCGGraphContext = {
    rng: definition.rng,
    assetSelectionSeed: definition.assetSelectionSeed ?? definition.rng.getInitialSeed(),
    surface: definition.surface,
    cache: definition.cache,
    bounds: definition.cache.bounds,
    biomeId: definition.id,
    biomePriority: definition.priority,
    attributes: { ...(definition.attributes ?? {}) }
  };

  const rootPoints: PCGPoint[] = [];
  const bindings = [...definition.generators].sort((a, b) => a.priority - b.priority);
  for (const binding of bindings) {
    const bindingCtx: PCGGraphContext = {
      ...ctx,
      rng: ctx.rng.fork(binding.id),
      attributes: { ...ctx.attributes, ...(binding.attributes ?? {}) }
    };
    const generated = binding.generator.generate(bindingCtx);
    for (const point of generated) {
      point.biomeId = definition.id;
      point.biomePriority = definition.priority;
      point.generatorId = binding.id;
      point.generator = binding.id;
      point.generatorType = binding.type;
      if (binding.subtype !== undefined) {
        point.generatorSubtype = binding.subtype;
      }
      point.generatorPriority = binding.priority;
      point.priority = binding.priority;
      point.allowOverlap = binding.allowOverlap ?? point.allowOverlap;
      point.attributes.Generator = binding.id;
      point.attributes.GeneratorType = binding.type;
      if (binding.subtype !== undefined) {
        point.attributes.GeneratorSubType = binding.subtype;
      }
      point.attributes.GeneratorPriority = binding.priority;
      point.attributes.PRIO = binding.priority;
      point.attributes.BIOME = definition.id;
      point.attributes.BIOMEPRIO = definition.priority;
      point.attributes.RecursionLevel = point.recursionLevel;
      Object.assign(point.attributes, binding.attributes ?? {});
    }

    const assigned = assignAssets(generated, assetTable.entries, bindingCtx);
    const filtered = applyRootFilters(assigned, definition.rootFilters ?? [], assetTable.byId, bindingCtx);
    rootPoints.push(...filtered);
  }

  const childPoints = runRecursiveChildTransforms({
    parents: rootPoints,
    ctx,
    assetTable,
    maxDepth: definition.maxChildDepth ?? 4,
    childFilters: definition.childFilters ?? [],
    childInputRateMultiplier: definition.childInputRateMultiplier ?? 1
  });
  const finalPoints = expandAssemblies([...rootPoints, ...childPoints], assetTable);

  return {
    biomeId: definition.id,
    biomePriority: definition.priority,
    points: finalPoints,
    cache: definition.cache,
    assetTable
  };
}

function assignAssets(points: PCGPoint[], assets: PCGAssetEntry[], ctx: PCGGraphContext): PCGPoint[] {
  const table = createRootAssetTable(assets.filter((asset) => assetColorMatches(asset, ctx.cache.color)));
  const out: PCGPoint[] = [];
  for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
    const point = points[pointIndex];
    if (!point) {
      continue;
    }
    const asset = selectAssetForPoint(table, point, ctx.assetSelectionSeed ?? ctx.rng.getInitialSeed());
    if (!asset) {
      continue;
    }
    const assigned = assignAssetToPoint(clonePoint(point), asset);
    assigned.seed = computeSeed(assigned.seed, pointIndex);
    applyPointScale(assigned, asset.scale, asset.verticalScale, ctx.rng);
    if (asset.transform) {
      const transformed = asset.transform([assigned], ctx, asset, 0);
      for (const transformedPoint of transformed) {
        transformedPoint.assetId = asset.id;
        projectPointToSurface(transformedPoint, ctx.surface, asset.yOffset ?? 0);
        out.push(transformedPoint);
      }
    } else {
      out.push(assigned);
    }
  }
  return out;
}

function applyRootFilters(
  points: PCGPoint[],
  globalFilters: NonNullable<PCGLocalBiomeDefinition["rootFilters"]>,
  assetsById: Map<string, PCGAssetEntry>,
  ctx: PCGGraphContext
): PCGPoint[] {
  const globallyFiltered = globalFilters.length
    ? applyFilterFeedback(points, globalFilters, ctx, { probabilistic: true })
    : points;
  return globallyFiltered.filter((point) => {
    const filters = point.assetId ? assetsById.get(point.assetId)?.filters ?? [] : [];
    if (filters.length === 0) {
      return true;
    }
    let density = 1;
    for (const filter of filters) {
      density *= filter(point, ctx);
      if (density <= 0) {
        return false;
      }
    }
    point.density *= density;
    return ctx.rng.next() <= point.density;
  });
}
