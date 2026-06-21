import * as THREE from "three";
import type { SeededRandom } from "./random.js";

export interface ScalarRange {
  min: number;
  max: number;
}

export interface Vec2 {
  x: number;
  z: number;
}

export interface PCGBounds2D {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface PCGBounds3D extends PCGBounds2D {
  minY: number;
  maxY: number;
}

export type PCGAttributeValue = unknown;

export type PCGAttributes = Record<string, PCGAttributeValue>;

export interface PCGSurfaceSample {
  x: number;
  z: number;
  height: number;
  normal: THREE.Vector3;
  slope?: number;
  attributes?: PCGAttributes;
}

export interface PCGSurface {
  sampleAt(x: number, z: number): PCGSurfaceSample;
  heightAt?: (x: number, z: number) => number;
  normalAt?: (x: number, z: number) => THREE.Vector3;
}

export interface PCGPointSphereBounds {
  type: "sphere";
  radius: number;
}

export interface PCGPointBoxBounds {
  type: "box";
  extents: THREE.Vector3;
}

export type PCGPointBounds = PCGPointSphereBounds | PCGPointBoxBounds;

export interface PCGPoint {
  id: string;
  position: THREE.Vector3;
  rotationY: number;
  scale: THREE.Vector3;
  normal: THREE.Vector3;
  density: number;
  /** Local point bounds, matching FPCGPoint::BoundsMin. */
  boundsMin: THREE.Vector3;
  /** Local point bounds, matching FPCGPoint::BoundsMax. */
  boundsMax: THREE.Vector3;
  bounds: PCGPointBounds;
  color: THREE.Color;
  steepness: number;
  seed: number;
  biomeId?: string;
  biomePriority: number;
  generatorId?: string;
  generator?: string;
  generatorType?: string;
  generatorSubtype?: string;
  generatorPriority: number;
  priority: number;
  recursionLevel: number;
  dataIndex?: number;
  assetId?: string;
  assetType?: string;
  allowOverlap: boolean;
  tags: Set<string>;
  attributes: PCGAttributes;
}

export interface PCGGraphContext {
  rng: SeededRandom;
  assetSelectionSeed?: string | number;
  surface: PCGSurface;
  cache: PCGBiomeCache;
  bounds: PCGBounds2D;
  biomeId?: string;
  biomePriority: number;
  attributes: PCGAttributes;
}

export interface PCGSpatialMask {
  id: string;
  bounds: PCGBounds2D;
  densityAt(x: number, z: number): number;
}

export interface PCGBiomeCache {
  id: string;
  kind: "volume" | "spline" | "texture" | "composite";
  bounds: PCGBounds2D;
  mask: PCGSpatialMask;
  color?: THREE.Color;
  densityAt(x: number, z: number): number;
  contains(x: number, z: number): boolean;
}

export interface PCGGenerator {
  id: string;
  generate(ctx: PCGGraphContext): PCGPoint[];
}

export interface PCGGeneratorBinding {
  id: string;
  type: string;
  subtype?: string;
  priority: number;
  allowOverlap?: boolean;
  generator: PCGGenerator;
  attributes?: PCGAttributes;
}

export type PCGPointFilter = (point: PCGPoint, ctx: PCGGraphContext, asset?: PCGAssetEntry) => number;

export type PCGTransformGraph = (
  points: PCGPoint[],
  ctx: PCGGraphContext,
  asset: PCGAssetEntry,
  depth: number
) => PCGPoint[];

export interface PCGChildAssetRule {
  assetId: string;
  weight?: number;
  count?: ScalarRange;
  radius?: ScalarRange;
  scale?: ScalarRange;
  transform?: PCGTransformGraph;
  attributes?: PCGAttributes;
}

export interface PCGAssemblyPoint {
  assetId: string;
  offset?: THREE.Vector3;
  rotationY?: number;
  scale?: THREE.Vector3;
  attributes?: PCGAttributes;
}

export interface PCGAssetEntry {
  id: string;
  type?: string;
  subtype?: string;
  assetPath?: string;
  generator?: string;
  generatorType?: string;
  generatorSubtype?: string;
  biomeColor?: THREE.Color | string;
  weight?: number;
  priority?: number;
  bounds?: PCGPointBounds;
  boundsMin?: THREE.Vector3;
  boundsMax?: THREE.Vector3;
  boundsScale?: number;
  extentsMultiplier?: number;
  allowOverlap?: boolean;
  scale?: ScalarRange;
  verticalScale?: ScalarRange;
  yOffset?: number;
  orientUpward?: boolean;
  dataIndex?: number;
  densityRange?: ScalarRange;
  waterDistanceRange?: ScalarRange;
  sunExposureRange?: ScalarRange;
  flowRange?: ScalarRange;
  heightRange?: ScalarRange;
  filters?: PCGPointFilter[];
  transform?: PCGTransformGraph;
  children?: PCGChildAssetRule[];
  assembly?: PCGAssemblyPoint[];
  attributes?: PCGAttributes;
}

export interface PCGLocalBiomeDefinition {
  id: string;
  priority: number;
  cache: PCGBiomeCache;
  surface: PCGSurface;
  rng: SeededRandom;
  generators: PCGGeneratorBinding[];
  assets: PCGAssetEntry[];
  assetSelectionSeed?: string | number;
  rootFilters?: PCGPointFilter[];
  childFilters?: PCGPointFilter[];
  maxChildDepth?: number;
  childInputRateMultiplier?: number;
  attributes?: PCGAttributes;
}

export interface PCGLocalBiomeResult {
  biomeId: string;
  biomePriority: number;
  points: PCGPoint[];
  cache: PCGBiomeCache;
  assetTable: PCGRootAssetTable;
}

export interface PCGGlobalBiomeResult {
  points: PCGPoint[];
  rejected: PCGPoint[];
  byAsset: Map<string, PCGPoint[]>;
}

export interface PCGRootAssetTable {
  entries: PCGAssetEntry[];
  byId: Map<string, PCGAssetEntry>;
}

export interface WeightedEntry {
  weight?: number;
}
