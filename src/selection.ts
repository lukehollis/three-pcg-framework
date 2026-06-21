import { computeSeed, SeededRandom } from "./random.js";

export interface RandomChoiceOptions {
  fixedNumber?: number;
  ratio?: number;
  seed?: string | number;
  combineFirstPointSeed?: boolean;
}

export interface RandomChoiceResult<T> {
  chosen: T[];
  discarded: T[];
}

export function randomChoice<T>(items: T[], options: RandomChoiceOptions = {}): RandomChoiceResult<T> {
  const numElements = items.length;
  const keep =
    options.fixedNumber !== undefined || options.ratio === undefined
      ? Math.max(0, Math.min(numElements, Math.floor(options.fixedNumber ?? 1)))
      : Math.ceil(numElements * Math.max(0, Math.min(1, options.ratio ?? 0.5)));

  if (keep === 0) {
    return { chosen: [], discarded: [...items] };
  }
  if (keep >= numElements) {
    return { chosen: [...items], discarded: [] };
  }

  const rng = new SeededRandom(randomChoiceSeed(items, options));
  const indexes = Array.from({ length: numElements }, (_, index) => index);
  for (let index = 0; index < keep; index += 1) {
    const other = rng.int(index, numElements - 1);
    if (other !== index) {
      [indexes[index], indexes[other]] = [indexes[other] as number, indexes[index] as number];
    }
  }

  const chosenIndexes = new Set(indexes.slice(0, keep));
  const chosen: T[] = [];
  const discarded: T[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item === undefined) {
      continue;
    }
    if (chosenIndexes.has(index)) {
      chosen.push(item);
    } else {
      discarded.push(item);
    }
  }
  return { chosen, discarded };
}

function randomChoiceSeed<T>(items: T[], options: RandomChoiceOptions): string | number {
  let seed = options.seed ?? 42;
  const firstSeed = firstPointSeed(items);
  if ((options.combineFirstPointSeed ?? true) && firstSeed !== undefined) {
    seed = computeSeed(typeof seed === "number" ? seed : stringSeed(seed), firstSeed);
  }
  return seed;
}

function firstPointSeed<T>(items: T[]): number | undefined {
  const first = items[0];
  if (typeof first !== "object" || first === null) {
    return undefined;
  }
  const seed = (first as { seed?: unknown }).seed;
  return typeof seed === "number" ? seed : undefined;
}

function stringSeed(seed: string): number {
  return new SeededRandom(seed).getCurrentSeed();
}
