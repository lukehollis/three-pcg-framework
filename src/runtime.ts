import type { SeededRandom } from "./random.js";
import { createVolumeCache } from "./cache.js";
import { runLocalBiomeCore } from "./pipeline.js";
import type {
  PCGBounds2D,
  PCGGeneratorBinding,
  PCGLocalBiomeDefinition,
  PCGPoint,
  PCGPointFilter,
  PCGSurface,
  Vec2
} from "./types.js";

export interface PCGRuntimeTile {
  key: string;
  ix: number;
  iz: number;
  bounds: PCGBounds2D;
  points: PCGPoint[];
}

export interface PCGRuntimeInfluence {
  position: Vec2;
  radius: number;
  mode: "attract" | "repulse";
  strength: number;
}

export interface PCGRuntimeLayer {
  id: string;
  generators: PCGGeneratorBinding[];
  filters?: PCGPointFilter[];
  density?: number;
}

export class RuntimeTileGrid {
  readonly active = new Map<string, PCGRuntimeTile>();

  constructor(
    readonly tileSize: number,
    readonly radiusInTiles: number
  ) {}

  tileKey(ix: number, iz: number): string {
    return `${ix}:${iz}`;
  }

  tileBounds(ix: number, iz: number): PCGBounds2D {
    return {
      minX: ix * this.tileSize,
      maxX: (ix + 1) * this.tileSize,
      minZ: iz * this.tileSize,
      maxZ: (iz + 1) * this.tileSize
    };
  }

  desiredKeys(camera: Vec2): Set<string> {
    const cx = Math.floor(camera.x / this.tileSize);
    const cz = Math.floor(camera.z / this.tileSize);
    const keys = new Set<string>();
    for (let dz = -this.radiusInTiles; dz <= this.radiusInTiles; dz += 1) {
      for (let dx = -this.radiusInTiles; dx <= this.radiusInTiles; dx += 1) {
        keys.add(this.tileKey(cx + dx, cz + dz));
      }
    }
    return keys;
  }

  reconcile(camera: Vec2): { enter: Array<{ key: string; ix: number; iz: number; bounds: PCGBounds2D }>; exit: PCGRuntimeTile[] } {
    const desired = this.desiredKeys(camera);
    const enter: Array<{ key: string; ix: number; iz: number; bounds: PCGBounds2D }> = [];
    const exit: PCGRuntimeTile[] = [];

    for (const [key, tile] of this.active) {
      if (!desired.has(key)) {
        exit.push(tile);
      }
    }

    for (const key of desired) {
      if (this.active.has(key)) {
        continue;
      }
      const [ixText, izText] = key.split(":");
      const ix = Number(ixText);
      const iz = Number(izText);
      enter.push({ key, ix, iz, bounds: this.tileBounds(ix, iz) });
    }

    return { enter, exit };
  }
}

export class RuntimeTileGenerator {
  constructor(
    readonly options: {
      id: string;
      surface: PCGSurface;
      rng: SeededRandom;
      tileGrid: RuntimeTileGrid;
      assets: PCGLocalBiomeDefinition["assets"];
      layers: PCGRuntimeLayer[];
      biomePriority?: number;
      influences?: PCGRuntimeInfluence[];
    }
  ) {}

  update(camera: Vec2): { entered: PCGRuntimeTile[]; exited: PCGRuntimeTile[] } {
    const changes = this.options.tileGrid.reconcile(camera);
    const entered: PCGRuntimeTile[] = [];
    for (const entry of changes.enter) {
      const tile = this.generateTile(entry.key, entry.ix, entry.iz, entry.bounds);
      this.options.tileGrid.active.set(entry.key, tile);
      entered.push(tile);
    }
    for (const tile of changes.exit) {
      this.options.tileGrid.active.delete(tile.key);
    }
    return { entered, exited: changes.exit };
  }

  private generateTile(key: string, ix: number, iz: number, bounds: PCGBounds2D): PCGRuntimeTile {
    const cache = createVolumeCache({ id: `${this.options.id}:${key}`, bounds });
    const generators = this.options.layers.flatMap((layer) =>
      layer.generators.map((binding) => ({
        ...binding,
        id: `${layer.id}:${binding.id}`,
        attributes: { ...(binding.attributes ?? {}), runtimeLayer: layer.id, runtimeDensity: layer.density ?? 1 }
      }))
    );
    const rootFilters = this.options.layers.flatMap((layer) => layer.filters ?? []);
    const local = runLocalBiomeCore({
      id: `${this.options.id}:${key}`,
      priority: this.options.biomePriority ?? 0,
      cache,
      surface: this.options.surface,
      rng: this.options.rng.fork(key),
      generators,
      assets: this.options.assets,
      rootFilters
    });
    const points = this.applyInfluences(local.points);
    return { key, ix, iz, bounds, points };
  }

  private applyInfluences(points: PCGPoint[]): PCGPoint[] {
    const influences = this.options.influences ?? [];
    if (influences.length === 0) {
      return points;
    }
    return points.filter((point) => {
      let density = point.density;
      for (const influence of influences) {
        const dx = point.position.x - influence.position.x;
        const dz = point.position.z - influence.position.z;
        const distance = Math.hypot(dx, dz);
        if (distance > influence.radius) {
          continue;
        }
        const amount = (1 - distance / Math.max(1e-6, influence.radius)) * influence.strength;
        density += influence.mode === "attract" ? amount : -amount;
      }
      point.density = Math.max(0, Math.min(1, density));
      return point.density > 0;
    });
  }
}
