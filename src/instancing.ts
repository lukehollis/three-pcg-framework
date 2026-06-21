import * as THREE from "three";
import { composePointMatrix } from "./point.js";
import type { PCGPoint } from "./types.js";

export interface PCGInstancingSource {
  assetId: string;
  meshes: THREE.Mesh[];
  castShadow?: boolean;
  receiveShadow?: boolean;
}

export function createInstancedGroup(source: PCGInstancingSource, points: PCGPoint[]): THREE.Group {
  const group = new THREE.Group();
  group.name = `PCGInstances_${source.assetId}`;
  group.userData.assetId = source.assetId;
  group.userData.instanceCount = points.length;

  for (const sourceMesh of source.meshes) {
    sourceMesh.updateMatrixWorld(true);
    const geometry = sourceMesh.geometry.clone();
    geometry.applyMatrix4(sourceMesh.matrixWorld);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    const instanced = new THREE.InstancedMesh(geometry, sourceMesh.material, points.length);
    instanced.name = `${source.assetId}_${sourceMesh.name || "mesh"}_instances`;
    instanced.castShadow = source.castShadow ?? sourceMesh.castShadow;
    instanced.receiveShadow = source.receiveShadow ?? sourceMesh.receiveShadow;
    instanced.frustumCulled = true;

    for (let index = 0; index < points.length; index += 1) {
      const point = points[index];
      if (!point) {
        continue;
      }
      instanced.setMatrixAt(index, composePointMatrix(point));
    }
    instanced.instanceMatrix.needsUpdate = true;
    group.add(instanced);
  }

  return group;
}
