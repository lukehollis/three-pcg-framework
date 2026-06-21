import type { ScalarRange, WeightedEntry } from "./types.js";

const SRAND_A = 196314165;
const SRAND_C = 907633515;
const SEED_B_A = 73148459;
const SEED_B_C = 453816763;
const SEED_C_A = 34731343;
const SEED_C_C = 453816743;
const FLOAT_MANTISSA_STEPS = 8388608;

export function hashSeed(seed: string | number): number {
  const value = String(seed);
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function computeSeed(a: number, b?: number, c?: number): number {
  const mixedA = mixSeedTerm(a, SRAND_A, SRAND_C);
  if (b === undefined) {
    return mixedA;
  }
  const mixedB = mixSeedTerm(b, SEED_B_A, SEED_B_C);
  if (c === undefined) {
    return (mixedA ^ mixedB) | 0;
  }
  return (mixedA ^ mixedB ^ mixSeedTerm(c, SEED_C_A, SEED_C_C)) | 0;
}

export function computeSeedFromPosition(x: number, y: number, z: number): number {
  return computeSeed(Math.trunc(x), Math.trunc(y), Math.trunc(z));
}

export class SeededRandom {
  private state: number;
  private readonly initialSeed: number;

  constructor(seed: string | number) {
    this.initialSeed = toInt32(typeof seed === "number" ? seed : hashSeed(seed));
    this.state = this.initialSeed >>> 0;
  }

  next(): number {
    this.mutate();
    return (this.state >>> 9) / FLOAT_MANTISSA_STEPS;
  }

  between(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  range(range: ScalarRange): number {
    return this.between(range.min, range.max);
  }

  int(min: number, maxInclusive: number): number {
    const range = maxInclusive - min + 1;
    return min + (range > 0 ? Math.trunc(this.next() * range) : 0);
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  fork(label: string | number): SeededRandom {
    const labelSeed = typeof label === "number" ? label : hashSeed(label);
    return new SeededRandom(computeSeed(this.getCurrentSeed(), labelSeed));
  }

  getCurrentSeed(): number {
    return toInt32(this.state);
  }

  getInitialSeed(): number {
    return this.initialSeed;
  }

  getUnsignedInt(): number {
    this.mutate();
    return this.state >>> 0;
  }

  reset(): void {
    this.state = this.initialSeed >>> 0;
  }

  private mutate(): void {
    this.state = (Math.imul(this.state, SRAND_A) + SRAND_C) >>> 0;
  }
}

export function pickWeighted<T extends WeightedEntry>(items: T[], rng: SeededRandom): T {
  if (items.length === 0) {
    throw new Error("Cannot pick from an empty weighted list.");
  }
  const total = items.reduce((sum, item) => sum + Math.max(0, item.weight ?? 1), 0);
  if (total <= 0) {
    return items[items.length - 1] as T;
  }
  if (Number.isInteger(total) && items.every((item) => Number.isInteger(Math.max(0, item.weight ?? 1)))) {
    let cursor = rng.int(0, total - 1);
    for (const item of items) {
      cursor -= Math.max(0, item.weight ?? 1);
      if (cursor < 0) {
        return item;
      }
    }
    return items[items.length - 1] as T;
  }
  let cursor = rng.next() * total;
  for (const item of items) {
    cursor -= Math.max(0, item.weight ?? 1);
    if (cursor <= 0) {
      return item;
    }
  }
  return items[items.length - 1] as T;
}

function mixSeedTerm(seed: number, multiplier: number, addend: number): number {
  return (Math.imul(toInt32(seed), multiplier) + addend) | 0;
}

function toInt32(value: number): number {
  return value | 0;
}
