import { groupPointsByAsset, pointsOverlap } from "./point.js";
import { differenceByRecursionLevel } from "./self-pruning.js";
import type { PCGGlobalBiomeResult, PCGLocalBiomeResult, PCGPoint } from "./types.js";

export interface PriorityDifferenceOptions {
  padding?: number;
  applyRecursionDifference?: boolean;
}

interface Blocker {
  point: PCGPoint;
  biomePriority: number;
  generatorPriority: number;
}

export function runGlobalBiomeCore(
  localResults: PCGLocalBiomeResult[],
  options: PriorityDifferenceOptions = {}
): PCGGlobalBiomeResult {
  const pointSets = localResults.flatMap((result) =>
    result.points.map((point) => {
      point.biomeId = result.biomeId;
      point.biomePriority = result.biomePriority;
      return point;
    })
  );
  const recursion = options.applyRecursionDifference ?? true ? differenceByRecursionLevel(pointSets) : { points: pointSets, rejected: [] };
  const { accepted, rejected } = differenceByPriority(recursion.points, options);
  return { points: accepted, rejected: [...recursion.rejected, ...rejected], byAsset: groupPointsByAsset(accepted) };
}

export function differenceByPriority(
  points: PCGPoint[],
  options: PriorityDifferenceOptions = {}
): { accepted: PCGPoint[]; rejected: PCGPoint[] } {
  const accepted: PCGPoint[] = [];
  const rejected: PCGPoint[] = [];
  const blockers: Blocker[] = [];
  const sorted = [...points].sort(comparePriority);

  for (const point of sorted) {
    if (point.allowOverlap) {
      accepted.push(point);
      continue;
    }

    let blocked = false;
    for (const blocker of blockers) {
      const samePriority =
        blocker.biomePriority === point.biomePriority && blocker.generatorPriority === point.generatorPriority;
      if (samePriority) {
        continue;
      }
      if (pointsOverlap(point, blocker.point, options.padding ?? 0)) {
        blocked = true;
        break;
      }
    }

    if (blocked) {
      rejected.push(point);
      continue;
    }
    accepted.push(point);
    blockers.push({
      point,
      biomePriority: point.biomePriority,
      generatorPriority: point.generatorPriority
    });
  }

  return { accepted, rejected };
}

export function comparePriority(a: PCGPoint, b: PCGPoint): number {
  const biome = a.biomePriority - b.biomePriority;
  if (biome !== 0) {
    return biome;
  }
  const generator = a.generatorPriority - b.generatorPriority;
  if (generator !== 0) {
    return generator;
  }
  return a.id.localeCompare(b.id);
}
