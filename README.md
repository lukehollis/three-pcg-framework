# three-pcg-framework

`three-pcg-framework` is a clean-room TypeScript implementation of Unreal-style Procedural Content Generation framework primitives for Three.js runtimes. It is not only a biome package: it provides the reusable PCG data model and execution pieces needed to build graph-like procedural systems, including seeded point data, tagged data collections, graph execution, a UE-style node registry, spatial masks and caches, surface and texture sampling, point filters, weighted selection, transforms, recursive spawning, self-pruning, priority/difference passes, runtime tiling, and instanced rendering helpers.

Biome Core compatibility is one supported workflow built on top of the framework. The biome helpers model the documented Unreal Biome Core flow with local biome caches, root asset tables, generator/subtype mapping, filter feedback passes, recursive child transforms, global priority difference, and camera-centered runtime tiles, but the underlying modules are intended to support broader PCG graphs as well.

The package does not copy Unreal Engine source. It implements compatible behavior from public semantics and local behavioral study of native PCG concepts rather than porting Epic source code.

The graph executor accepts node `type` values that match Unreal-style settings class names such as `PCGSurfaceSamplerSettings`, `PCGTransformPointsSettings`, `PCGSelfPruningSettings`, and `PCGStaticMeshSpawnerSettings`. These resolve through `defaultPCGNodeRegistry`, so imported or generated graph definitions can stay close to the original node vocabulary while running against Three.js data.

```ts
import {
  SeededRandom,
  createVolumeCache,
  runPCGGraph,
  runLocalBiomeCore,
  runGlobalBiomeCore,
  surfaceScatter
} from "three-pcg-framework";

const cache = createVolumeCache({
  id: "forest-volume",
  bounds: { minX: -80, maxX: 80, minZ: -80, maxZ: 80 }
});

const local = runLocalBiomeCore({
  id: "forest",
  priority: 0,
  cache,
  surface,
  rng: new SeededRandom("world-seed"),
  generators: [
    {
      id: "canopy",
      type: "trees",
      priority: 0,
      generator: surfaceScatter({ id: "canopy", count: 600 })
    }
  ],
  assets: [
    {
      id: "oak",
      generatorType: "trees",
      weight: 1,
      bounds: { type: "sphere", radius: 3.5 }
    }
  ],
  rootFilters: []
});

const global = runGlobalBiomeCore([local]);
```

Priority follows Unreal’s documented convention: lower biome priority and lower generator priority values are processed first and remove overlapping lower-priority points by assigned asset bounds. Equal priorities and explicit `allowOverlap` entries bypass that removal.

For access to Unreal Engine source, link Epic and GitHub accounts and clone Epic’s private repository under the Unreal EULA. Use it only for study; copying engine code into this package would change the licensing obligations.
