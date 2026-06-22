import * as THREE from "three";
import { assignAssetToPoint, createRootAssetTable, selectAssetForPoint } from "./asset-table.js";
import { attributeRangeFilter, densityFilter, heightFilter, slopeFilter } from "./filters.js";
import { poissonSurfaceScatter, splineScatter, surfaceSampler, surfaceScatter, textureScatter } from "./generators.js";
import { clonePoint, pointBoundsFromMinMax, pointsOverlap, projectPointToSurface, setLocalExtents } from "./point.js";
import { computeSeed, computeSeedFromPosition, hashSeed, SeededRandom } from "./random.js";
import { randomChoice } from "./selection.js";
import { selfPrune } from "./self-pruning.js";
import { boxMask, circleMask, combineMasks, polygonMask, splineMask, textureMask } from "./spatial.js";
import type {
  PCGAssetEntry,
  PCGAttributes,
  PCGBounds2D,
  PCGGraphContext,
  PCGPoint,
  PCGPointBounds,
  PCGSpatialMask,
  PCGSurface,
  ScalarRange,
  Vec2
} from "./types.js";

export type PCGDataKind = "point" | "param" | "spatial" | "surface" | "empty";

export interface PCGTaggedData {
  kind: PCGDataKind;
  pin?: string;
  tags: Set<string>;
  points?: PCGPoint[];
  attributes?: PCGAttributes;
  mask?: PCGSpatialMask;
  surface?: PCGSurface;
  bounds?: PCGBounds2D;
}

export type PCGNodeInputs = Record<string, PCGTaggedData[]>;
export type PCGNodeOutputs = Record<string, PCGTaggedData[]>;

export interface PCGGraphNode {
  id: string;
  type: string;
  settings?: PCGNodeSettings;
}

export interface PCGGraphEdge {
  fromNode: string;
  toNode: string;
  fromPin?: string;
  toPin?: string;
}

export interface PCGExecutableGraph {
  nodes: PCGGraphNode[];
  edges: PCGGraphEdge[];
}

export interface PCGNodeExecutionContext {
  graphContext: PCGGraphContext;
  node: PCGGraphNode;
  registry: PCGNodeRegistry;
}

export type PCGNodeExecutor = (
  inputs: PCGNodeInputs,
  settings: PCGNodeSettings,
  context: PCGNodeExecutionContext
) => PCGNodeOutputs;

export interface PCGNodeSettings {
  [key: string]: unknown;
}

export class PCGNodeRegistry {
  private readonly executors = new Map<string, PCGNodeExecutor>();
  private readonly aliases = new Map<string, string>();

  register(type: string, executor: PCGNodeExecutor): this {
    this.executors.set(normalizeType(type), executor);
    return this;
  }

  alias(alias: string, type: string): this {
    this.aliases.set(normalizeType(alias), normalizeType(type));
    return this;
  }

  execute(type: string, inputs: PCGNodeInputs, settings: PCGNodeSettings, context: Omit<PCGNodeExecutionContext, "registry">): PCGNodeOutputs {
    const normalized = this.resolve(type);
    const executor = this.executors.get(normalized);
    if (!executor) {
      throw new Error(`No PCG node executor registered for "${type}".`);
    }
    return executor(inputs, settings, { ...context, registry: this });
  }

  has(type: string): boolean {
    return this.executors.has(this.resolve(type));
  }

  resolve(type: string): string {
    let current = normalizeType(type);
    const seen = new Set<string>();
    while (this.aliases.has(current) && !seen.has(current)) {
      seen.add(current);
      current = this.aliases.get(current) as string;
    }
    return current;
  }
}

export function runPCGGraph(
  graph: PCGExecutableGraph,
  graphContext: PCGGraphContext,
  inputs: PCGNodeInputs = {},
  registry: PCGNodeRegistry = defaultPCGNodeRegistry
): PCGNodeOutputs {
  const incoming = new Map<string, PCGGraphEdge[]>();
  const outgoing = new Map<string, PCGGraphEdge[]>();
  for (const edge of graph.edges) {
    const inList = incoming.get(edge.toNode) ?? [];
    inList.push(edge);
    incoming.set(edge.toNode, inList);
    const outList = outgoing.get(edge.fromNode) ?? [];
    outList.push(edge);
    outgoing.set(edge.fromNode, outList);
  }

  const remaining = new Set(graph.nodes.map((node) => node.id));
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const outputsByNode = new Map<string, PCGNodeOutputs>();
  const readyInputs = new Map<string, PCGNodeInputs>();

  for (const node of graph.nodes) {
    if (incoming.get(node.id)?.length) {
      continue;
    }
    readyInputs.set(node.id, cloneInputs(inputs));
  }

  while (remaining.size > 0) {
    const ready = [...remaining].find((nodeId) => (incoming.get(nodeId) ?? []).every((edge) => outputsByNode.has(edge.fromNode)));
    if (!ready) {
      throw new Error("PCG graph contains a cycle or disconnected dependency that cannot be resolved.");
    }
    const node = nodeById.get(ready);
    if (!node) {
      throw new Error(`PCG graph references missing node "${ready}".`);
    }
    const nodeInputs = buildNodeInputs(node.id, incoming.get(node.id) ?? [], outputsByNode, readyInputs.get(node.id) ?? inputs);
    const nodeOutputs = registry.execute(node.type, nodeInputs, node.settings ?? {}, { graphContext, node });
    outputsByNode.set(node.id, nodeOutputs);
    remaining.delete(node.id);

    for (const edge of outgoing.get(node.id) ?? []) {
      const targetInputs = readyInputs.get(edge.toNode) ?? {};
      const fromPin = edge.fromPin ?? "Out";
      const toPin = edge.toPin ?? "In";
      targetInputs[toPin] = [...(targetInputs[toPin] ?? []), ...(nodeOutputs[fromPin] ?? nodeOutputs.Out ?? [])];
      readyInputs.set(edge.toNode, targetInputs);
    }
  }

  const terminal = graph.nodes.filter((node) => !(outgoing.get(node.id)?.length));
  if (terminal.length === 0) {
    return {};
  }
  return terminal.reduce<PCGNodeOutputs>((merged, node) => mergeOutputs(merged, outputsByNode.get(node.id) ?? {}), {});
}

export function pointData(points: PCGPoint[], tags: Iterable<string> = []): PCGTaggedData {
  return { kind: "point", points, tags: new Set(tags) };
}

export function paramData(attributes: PCGAttributes, tags: Iterable<string> = []): PCGTaggedData {
  return { kind: "param", attributes: { ...attributes }, tags: new Set(tags) };
}

export function spatialData(mask: PCGSpatialMask, tags: Iterable<string> = []): PCGTaggedData {
  return { kind: "spatial", mask, bounds: mask.bounds, tags: new Set(tags) };
}

export function surfaceData(surface: PCGSurface, bounds: PCGBounds2D, tags: Iterable<string> = []): PCGTaggedData {
  return { kind: "surface", surface, bounds, tags: new Set(tags) };
}

export function emptyData(tags: Iterable<string> = []): PCGTaggedData {
  return { kind: "empty", tags: new Set(tags) };
}

export function getInputData(inputs: PCGNodeInputs, pin = "In"): PCGTaggedData[] {
  return inputs[pin] ?? inputs.In ?? inputs.Default ?? [];
}

export function getInputPoints(inputs: PCGNodeInputs, pin = "In"): PCGPoint[] {
  return getInputData(inputs, pin).flatMap((data) => data.points ?? []);
}

export function cloneTaggedData(data: PCGTaggedData): PCGTaggedData {
  const clone: PCGTaggedData = {
    kind: data.kind,
    tags: new Set(data.tags)
  };
  if (data.pin !== undefined) {
    clone.pin = data.pin;
  }
  if (data.points !== undefined) {
    clone.points = data.points.map((point) => clonePoint(point));
  }
  if (data.attributes !== undefined) {
    clone.attributes = { ...data.attributes };
  }
  if (data.mask !== undefined) {
    clone.mask = data.mask;
  }
  if (data.surface !== undefined) {
    clone.surface = data.surface;
  }
  if (data.bounds !== undefined) {
    clone.bounds = { ...data.bounds };
  }
  return clone;
}

export function cloneInputs(inputs: PCGNodeInputs): PCGNodeInputs {
  const cloned: PCGNodeInputs = {};
  for (const [pin, data] of Object.entries(inputs)) {
    cloned[pin] = data.map(cloneTaggedData);
  }
  return cloned;
}

function createDefaultPCGNodeRegistry(): PCGNodeRegistry {
  const registry = new PCGNodeRegistry();

  registry
    .register("passthrough", passThroughNode)
    .register("merge", mergeNode)
    .register("gather", mergeNode)
    .register("branch", branchNode)
    .register("booleanselect", booleanSelectNode)
    .register("createpoints", createPointsNode)
    .register("createpointsgrid", createPointsGridNode)
    .register("surfacesampler", surfaceSamplerNode)
    .register("volumesampler", volumeSamplerNode)
    .register("splinesampler", splineSamplerNode)
    .register("texturesampler", textureSamplerNode)
    .register("meshsampler", meshSamplerNode)
    .register("pointfrommesh", meshSamplerNode)
    .register("surfaceScatter", surfaceScatterNode)
    .register("poissonsurfaceScatter", poissonSurfaceScatterNode)
    .register("addattribute", addAttributeNode)
    .register("createattribute", addAttributeNode)
    .register("createattributeset", createAttributeSetNode)
    .register("deleteattributes", deleteAttributesNode)
    .register("copyattributes", copyAttributesNode)
    .register("mergeattributes", mergeAttributesNode)
    .register("renameattribute", renameAttributeNode)
    .register("attributenoise", attributeNoiseNode)
    .register("attributeremap", attributeRemapNode)
    .register("attributereduce", attributeReduceNode)
    .register("metadataoperation", metadataMathNode)
    .register("metadatamaths", metadataMathNode)
    .register("metadatacompare", metadataCompareNode)
    .register("metadataboolean", metadataBooleanNode)
    .register("metadatastringop", metadataStringNode)
    .register("tags", tagsNode)
    .register("addtag", tagsNode)
    .register("deletetags", deleteTagsNode)
    .register("filterbytag", filterByTagNode)
    .register("filterbytype", filterByTypeNode)
    .register("filterbyindex", filterByIndexNode)
    .register("attributefilter", attributeFilterNode)
    .register("pointfilter", attributeFilterNode)
    .register("densityfilter", densityFilterNode)
    .register("densityremap", densityRemapNode)
    .register("normaltodensity", normalToDensityNode)
    .register("transformpoints", transformPointsNode)
    .register("duplicatepoint", duplicatePointNode)
    .register("copypoints", copyPointsNode)
    .register("projection", projectionNode)
    .register("boundsmodifier", boundsModifierNode)
    .register("pointextentsmodifier", pointExtentsModifierNode)
    .register("applyscaletobounds", applyScaleToBoundsNode)
    .register("mutateseed", mutateSeedNode)
    .register("selectpoints", selectPointsNode)
    .register("randomchoice", selectPointsNode)
    .register("selfpruning", selfPruningNode)
    .register("difference", differenceNode)
    .register("outerintersection", intersectionNode)
    .register("intersection", intersectionNode)
    .register("spatialmask", spatialMaskNode)
    .register("staticmeshspawner", staticMeshSpawnerNode)
    .register("spawnactor", staticMeshSpawnerNode)
    .register("matchandsetattributes", matchAndSetAttributesNode)
    .register("provider", providerNode)
    .register("datafromactor", providerNode)
    .register("getlandscape", providerNode)
    .register("getspline", providerNode)
    .register("getvirtualtexture", providerNode)
    .register("worldrayhit", worldRayHitNode)
    .register("customhlsl", customKernelNode)
    .register("subgraph", subgraphNode)
    .register("loop", loopNode)
    .register("sortattributes", sortNode)
    .register("sorttags", sortNode)
    .register("removeemptydata", removeEmptyDataNode)
    .register("debug", passThroughNode);

  for (const [alias, type] of Object.entries(UE_NODE_ALIASES)) {
    registry.alias(alias, type);
  }
  return registry;
}

const UE_NODE_ALIASES: Record<string, string> = {
  PCGActorSelectorSettings: "datafromactor",
  PCGAddAttributeSettings: "addattribute",
  PCGAddComponentSettings: "spawnactor",
  PCGAddTagSettings: "addtag",
  PCGApplyHierarchySettings: "passthrough",
  PCGApplyOnActorSettings: "provider",
  PCGApplyScaleToBoundsSettings: "applyscaletobounds",
  PCGAttractSettings: "transformpoints",
  PCGAttributeCastSettings: "passthrough",
  PCGAttributeFilterNamesSettings: "attributefilter",
  PCGAttributeFilterSettings: "attributefilter",
  PCGAttributeFilterThresholdSettings: "attributefilter",
  PCGAttributeFilteringRangeSettings: "attributefilter",
  PCGAttributeFilteringSettings: "attributefilter",
  PCGAttributeGetFromIndexSettings: "passthrough",
  PCGAttributeGetFromPointIndexSettings: "passthrough",
  PCGAttributeNoiseSettings: "attributenoise",
  PCGAttributeReduceSettings: "attributereduce",
  PCGAttributeRemapSettings: "attributeremap",
  PCGAttributeRemoveDuplicatesSettings: "filterbyindex",
  PCGAttributeSelectSettings: "createattributeset",
  PCGAttributeTransferSettings: "copyattributes",
  PCGBadOutputsNodeSettings: "passthrough",
  PCGBaseSubgraphSettings: "subgraph",
  PCGBlueprintSettings: "customhlsl",
  PCGBlurSettings: "attributenoise",
  PCGBooleanSelectSettings: "booleanselect",
  PCGBoundsFromMeshSettings: "pointfrommesh",
  PCGBoundsModifierSettings: "boundsmodifier",
  PCGBranchSettings: "branch",
  PCGCleanSplineSettings: "spatialmask",
  PCGClipPathsSettings: "spatialmask",
  PCGClusterSettings: "selfpruning",
  PCGCollapsePointsSettings: "selfpruning",
  PCGCollapseSettings: "merge",
  PCGCombinePointsSettings: "merge",
  PCGComponentSelectorSettings: "datafromactor",
  PCGComputeGraphSettings: "customhlsl",
  PCGControlFlowSettings: "passthrough",
  PCGConvertToAttributeSetSettings: "createattributeset",
  PCGConvertToPointDataSettings: "passthrough",
  PCGConvexHull2DSettings: "spatialmask",
  PCGCopyAttributeSettings: "copyattributes",
  PCGCopyAttributesSettings: "copyattributes",
  PCGCopyPointSettings: "copypoints",
  PCGCopyPointsSettings: "copypoints",
  PCGCreateAttributeSetSettings: "createattributeset",
  PCGCreateAttributeSettings: "createattribute",
  PCGCreateCollisionDataSettings: "provider",
  PCGCreatePointsGridSettings: "createpointsgrid",
  PCGCreatePointsSettings: "createpoints",
  PCGCreatePointsSphereSettings: "createpoints",
  PCGCreatePolygon2DSettings: "spatialmask",
  PCGCreateSplineSettings: "spatialmask",
  PCGCreateSurfaceFromPolygon2DSettings: "spatialmask",
  PCGCreateSurfaceFromSplineSettings: "spatialmask",
  PCGCullPointsOutsideActorBoundsSettings: "attributefilter",
  PCGCustomHLSLSettings: "customhlsl",
  PCGDataAttributesAndTagsSettings: "createattributeset",
  PCGDataAttributesToTagsSettings: "tags",
  PCGDataFromActorSettings: "datafromactor",
  PCGDataLayerSettings: "createattributeset",
  PCGDataNumSettings: "attributereduce",
  PCGDataTableRowToParamDataSettings: "provider",
  PCGDataTypeInfoSettings: "createattributeset",
  PCGDebugSettings: "debug",
  PCGDebugVisualizationSettings: "debug",
  PCGDeleteAttributesSettings: "deleteattributes",
  PCGDeleteTagsSettings: "deletetags",
  PCGDensityFilterSettings: "densityfilter",
  PCGDensityRemapSettings: "densityremap",
  PCGDeterminismSettings: "passthrough",
  PCGDifferenceSettings: "difference",
  PCGDistanceSettings: "passthrough",
  PCGDuplicateCrossSectionsSettings: "duplicatepoint",
  PCGDuplicatePointSettings: "duplicatepoint",
  PCGDynamicSettings: "provider",
  PCGElevationIsolinesSettings: "spatialmask",
  PCGEngineSettings: "passthrough",
  PCGExportSelectedAttributesSettings: "provider",
  PCGExternalDataSettings: "provider",
  PCGExtractAttributeSettings: "createattributeset",
  PCGFilterByAttributeSettings: "attributefilter",
  PCGFilterByAttributeThresholdSettings: "attributefilter",
  PCGFilterByIndexSettings: "filterbyindex",
  PCGFilterByTagSettings: "filterbytag",
  PCGFilterByTypeSettings: "filterbytype",
  PCGFilterDataBaseSettings: "attributefilter",
  PCGFilterElementsByIndexSettings: "filterbyindex",
  PCGGatherSettings: "gather",
  PCGGenerateGrassMapsSettings: "provider",
  PCGGenerateLandscapeTexturesSettings: "provider",
  PCGGenerateSeedSettings: "mutateseed",
  PCGGenericUserParameterGetSettings: "createattributeset",
  PCGGetActorDataLayersSettings: "createattributeset",
  PCGGetActorPropertySettings: "createattributeset",
  PCGGetAssetListSettings: "provider",
  PCGGetAttributesSettings: "createattributeset",
  PCGGetBoundsSettings: "createattributeset",
  PCGGetConsoleVariableSettings: "createattributeset",
  PCGGetExecutionContextSettings: "createattributeset",
  PCGGetLandscapeSettings: "getlandscape",
  PCGGetLoopIndexSettings: "createattributeset",
  PCGGetPCGComponentSettings: "provider",
  PCGGetPrimitiveSettings: "provider",
  PCGGetPropertyFromObjectPathSettings: "createattributeset",
  PCGGetSegmentSettings: "spatialmask",
  PCGGetSplineControlPointsSettings: "splinesampler",
  PCGGetSplineSettings: "getspline",
  PCGGetStaticMeshResourceDataSettings: "provider",
  PCGGetSubgraphDepthSettings: "createattributeset",
  PCGGetTagsSettings: "createattributeset",
  PCGGetVirtualTextureSettings: "getvirtualtexture",
  PCGGetVolumeSettings: "provider",
  PCGGetWaterSplineSettings: "getspline",
  PCGGraphAuthoringTestHelperSettings: "passthrough",
  PCGGraphInputOutputSettings: "passthrough",
  PCGGridLinkageSettings: "passthrough",
  PCGHashAttributeSettings: "mutateseed",
  PCGHiGenGridSizeSettings: "createattributeset",
  PCGHLODSettings: "provider",
  PCGIndirectionSettings: "passthrough",
  PCGInnerIntersectionSettings: "intersection",
  PCGInputOutputSettings: "passthrough",
  PCGInteractiveToolSettings: "provider",
  PCGLoadDataAssetSettings: "provider",
  PCGLoadDataTableSettings: "provider",
  PCGLoopSettings: "loop",
  PCGMakeConcreteSettings: "passthrough",
  PCGMatchAndSetAttributesSettings: "matchandsetattributes",
  PCGMeshSamplerSettings: "meshsampler",
  PCGMergeAttributesSettings: "mergeattributes",
  PCGMergeSettings: "merge",
  PCGMetadataBitwiseSettings: "metadataoperation",
  PCGMetadataBooleanSettings: "metadataboolean",
  PCGMetadataBreakTransformSettings: "metadataoperation",
  PCGMetadataBreakVectorSettings: "metadataoperation",
  PCGMetadataCompareSettings: "metadatacompare",
  PCGMetadataMakeRotatorSettings: "metadataoperation",
  PCGMetadataMakeTransformSettings: "metadataoperation",
  PCGMetadataMakeVectorSettings: "metadataoperation",
  PCGMetadataMathsSettings: "metadatamaths",
  PCGMetadataOperationSettings: "metadataoperation",
  PCGMetadataPartitionSettings: "branch",
  PCGMetadataRenameSettings: "renameattribute",
  PCGMetadataRotatorSettings: "metadataoperation",
  PCGMetadataSettings: "metadataoperation",
  PCGMetadataStringOpSettings: "metadatastringop",
  PCGMetadataTransformSettings: "metadataoperation",
  PCGMetadataTransfromSettings: "metadataoperation",
  PCGMetadataTrigSettings: "metadataoperation",
  PCGMetadataVectorSettings: "metadataoperation",
  PCGMultiSelectSettings: "booleanselect",
  PCGMutateSeedSettings: "mutateseed",
  PCGNaniteAssemblyStaticMeshBuilderSettings: "staticmeshspawner",
  PCGNamedRerouteBaseSettings: "passthrough",
  PCGNamedRerouteDeclarationSettings: "passthrough",
  PCGNamedRerouteUsageSettings: "passthrough",
  PCGNormalToDensitySettings: "normaltodensity",
  PCGNumberOfElementsSettings: "attributereduce",
  PCGNumberOfEntriesSettings: "attributereduce",
  PCGNumberOfPointsSettings: "attributereduce",
  PCGOffsetPolygon2DSettings: "spatialmask",
  PCGOuterIntersectionSettings: "outerintersection",
  PCGParseStringSettings: "metadatastringop",
  PCGPartitionByActorDataLayersSettings: "branch",
  PCGPathfindingSettings: "provider",
  PCGPointExtentsModifierSettings: "pointextentsmodifier",
  PCGPointFilterRangeSettings: "attributefilter",
  PCGPointFilterSettings: "attributefilter",
  PCGPointFromMeshSettings: "pointfrommesh",
  PCGPointMatchAndSetSettings: "matchandsetattributes",
  PCGPointNeighborhoodSettings: "selfpruning",
  PCGPolygon2DOperationSettings: "spatialmask",
  PCGPreConfiguredSettings: "passthrough",
  PCGPrintElementSettings: "debug",
  PCGPrintGrammarSettings: "debug",
  PCGProjectionSettings: "projection",
  PCGPropertyToParamDataSettings: "createattributeset",
  PCGQualityBranchSettings: "branch",
  PCGQualitySelectSettings: "booleanselect",
  PCGRandomChoiceSettings: "selectpoints",
  PCGRemoveEmptyDataSettings: "removeemptydata",
  PCGReplaceTagsSettings: "tags",
  PCGResetPointCenterSettings: "boundsmodifier",
  PCGReverseSplineSettings: "spatialmask",
  PCGRerouteSettings: "passthrough",
  PCGSampleTextureSettings: "texturesampler",
  PCGSanityCheckPointDataSettings: "passthrough",
  PCGSaveDataAssetSettings: "provider",
  PCGSaveTextureToAssetSettings: "provider",
  PCGSceneCaptureSettings: "provider",
  PCGSelectGrammarSettings: "passthrough",
  PCGSelectPointsSettings: "selectpoints",
  PCGSelectionKeyToSettings: "passthrough",
  PCGSelfPruningSettings: "selfpruning",
  PCGSkinnedMeshSpawnerSettings: "staticmeshspawner",
  PCGSortAttributesSettings: "sortattributes",
  PCGSortTagsSettings: "sorttags",
  PCGSpatialNoiseSettings: "attributenoise",
  PCGSpawnActorSettings: "spawnactor",
  PCGSpawnInstancedActorsSettings: "spawnactor",
  PCGSpawnSplineMeshSettings: "spawnactor",
  PCGSpawnSplineSettings: "spawnactor",
  PCGSplineIntersectionSettings: "intersection",
  PCGSplineSamplerSettings: "splinesampler",
  PCGSplineToSegmentSettings: "splinesampler",
  PCGSplitPointsSettings: "branch",
  PCGSplitSplinesSettings: "spatialmask",
  PCGStaticMeshSpawnerSettings: "staticmeshspawner",
  PCGSubdivideSegmentSettings: "splinesampler",
  PCGSubdivideSplineSettings: "splinesampler",
  PCGSubdivisionBaseSettings: "splinesampler",
  PCGSubgraphSettings: "subgraph",
  PCGSurfaceSamplerSettings: "surfacesampler",
  PCGSwitchSettings: "booleanselect",
  PCGTagsToAttributeSetSettings: "createattributeset",
  PCGTagsToDataAttributesSettings: "createattributeset",
  PCGTextureSamplerSettings: "texturesampler",
  PCGTransformPointsSettings: "transformpoints",
  PCGTrivialSettings: "passthrough",
  PCGUnionSettings: "merge",
  PCGUserParameterGetSettings: "createattributeset",
  PCGVisualizeAttributeSettings: "debug",
  PCGVolumeSamplerSettings: "volumesampler",
  PCGWaitLandscapeReadySettings: "provider",
  PCGWaitSettings: "passthrough",
  PCGWorldQuerySettings: "provider",
  PCGWorldRaycastElementSettings: "worldrayhit",
  PCGWorldRayHitSettings: "worldrayhit",
  PCGWriteToNiagaraDataChannelSettings: "provider"
};

export const defaultPCGNodeRegistry = createDefaultPCGNodeRegistry();

function passThroughNode(inputs: PCGNodeInputs): PCGNodeOutputs {
  return { Out: Object.values(inputs).flat().map(cloneTaggedData) };
}

function mergeNode(inputs: PCGNodeInputs): PCGNodeOutputs {
  return { Out: Object.values(inputs).flat().map(cloneTaggedData) };
}

function branchNode(inputs: PCGNodeInputs, settings: PCGNodeSettings): PCGNodeOutputs {
  const data = getInputData(inputs);
  const condition = booleanSetting(settings, ["condition", "value", "bValue"], true);
  return condition ? { True: data.map(cloneTaggedData), Out: data.map(cloneTaggedData), False: [] } : { True: [], False: data.map(cloneTaggedData), Out: [] };
}

function booleanSelectNode(inputs: PCGNodeInputs, settings: PCGNodeSettings): PCGNodeOutputs {
  const condition = booleanSetting(settings, ["condition", "value", "bValue"], true);
  const selected = condition ? getInputData(inputs, "True") : getInputData(inputs, "False");
  return { Out: selected.length ? selected.map(cloneTaggedData) : getInputData(inputs).map(cloneTaggedData) };
}

function createPointsNode(_inputs: PCGNodeInputs, settings: PCGNodeSettings, context: PCGNodeExecutionContext): PCGNodeOutputs {
  const entries = arraySetting<Record<string, unknown>>(settings, ["points", "Points", "entries"]) ?? [];
  const points = entries.map((entry, index) =>
    createPointFromEntry(context.graphContext.surface, entry, `${context.node.id}:${index}`)
  );
  return { Out: [pointData(points)] };
}

function createPointsGridNode(_inputs: PCGNodeInputs, settings: PCGNodeSettings, context: PCGNodeExecutionContext): PCGNodeOutputs {
  const bounds = boundsSetting(settings, context.graphContext.bounds);
  const spacing = vectorSetting(settings, ["spacing", "cellSize", "CellSize"], new THREE.Vector3(100, 100, 100));
  const y = numberSetting(settings, ["y", "height", "Height"], 0);
  const points: PCGPoint[] = [];
  let index = 0;
  for (let z = bounds.minZ; z <= bounds.maxZ; z += Math.max(1e-6, spacing.z)) {
    for (let x = bounds.minX; x <= bounds.maxX; x += Math.max(1e-6, spacing.x)) {
      const point = createPointFromEntry(context.graphContext.surface, { x, y, z }, `${context.node.id}:${index++}`);
      point.position.y = y;
      point.seed = computeSeedFromPosition(x, y, z);
      points.push(point);
    }
  }
  return { Out: [pointData(points)] };
}

function surfaceSamplerNode(_inputs: PCGNodeInputs, settings: PCGNodeSettings, context: PCGNodeExecutionContext): PCGNodeOutputs {
  const generator = surfaceSampler({
    id: context.node.id,
    pointsPerSquareMeter: numberSetting(settings, ["pointsPerSquareMeter", "PointsPerSquaredMeter", "density"], 0.1),
    pointExtents: vectorOrNumberSetting(settings, ["pointExtents", "PointExtents", "extents"], 0.5),
    looseness: numberSetting(settings, ["looseness", "Looseness"], 1),
    pointSteepness: numberSetting(settings, ["pointSteepness", "PointSteepness"], 1),
    applyDensityToPoints: booleanSetting(settings, ["applyDensityToPoints", "bApplyDensityToPoints"], true),
    legacyGridCreation: booleanSetting(settings, ["legacyGridCreation", "bUseLegacyGridCreation"], false)
  });
  return { Out: [pointData(generator.generate(context.graphContext))] };
}

function volumeSamplerNode(_inputs: PCGNodeInputs, settings: PCGNodeSettings, context: PCGNodeExecutionContext): PCGNodeOutputs {
  const bounds = boundsSetting(settings, context.graphContext.bounds);
  const spacing = vectorSetting(settings, ["voxelSize", "VoxelSize", "spacing"], new THREE.Vector3(100, 100, 100));
  const minY = numberSetting(settings, ["minY", "MinY"], 0);
  const maxY = numberSetting(settings, ["maxY", "MaxY"], minY);
  const points: PCGPoint[] = [];
  let index = 0;
  for (let z = bounds.minZ; z <= bounds.maxZ; z += Math.max(1e-6, spacing.z)) {
    for (let y = minY; y <= maxY; y += Math.max(1e-6, spacing.y)) {
      for (let x = bounds.minX; x <= bounds.maxX; x += Math.max(1e-6, spacing.x)) {
        const cacheDensity = context.graphContext.cache.densityAt(x, z);
        if (cacheDensity <= 0) {
          continue;
        }
        const point = createPointFromEntry(context.graphContext.surface, { x, y, z, density: cacheDensity }, `${context.node.id}:${index++}`);
        point.position.y = y;
        point.seed = computeSeed(Math.trunc(x), Math.trunc(y), Math.trunc(z));
        points.push(point);
      }
    }
  }
  return { Out: [pointData(points)] };
}

function splineSamplerNode(inputs: PCGNodeInputs, settings: PCGNodeSettings, context: PCGNodeExecutionContext): PCGNodeOutputs {
  const points = points2DSetting(settings, ["points", "spline", "Spline"]) ?? maskPolyline(inputs);
  if (!points || points.length < 2) {
    return { Out: [pointData([])] };
  }
  const generator = splineScatter({
    id: context.node.id,
    points,
    count: integerSetting(settings, ["count", "PointCount", "numPoints"], 100),
    radius: numberSetting(settings, ["radius", "jitterRadius", "Radius"], 0),
    jitter: numberSetting(settings, ["jitter", "Jitter"], 1)
  });
  return { Out: [pointData(generator.generate(context.graphContext))] };
}

function textureSamplerNode(inputs: PCGNodeInputs, settings: PCGNodeSettings, context: PCGNodeExecutionContext): PCGNodeOutputs {
  const values = arrayLikeNumberSetting(settings, ["values", "texture", "Texture"]);
  const width = integerSetting(settings, ["width", "textureWidth", "Width"], 0);
  const height = integerSetting(settings, ["height", "textureHeight", "Height"], 0);
  if (!values || width <= 0 || height <= 0) {
    return passThroughNode(inputs);
  }
  const generator = textureScatter({
    id: context.node.id,
    count: integerSetting(settings, ["count", "PointCount", "numPoints"], 100),
    textureWidth: width,
    textureHeight: height,
    values,
    threshold: numberSetting(settings, ["threshold", "Threshold"], 0)
  });
  return { Out: [pointData(generator.generate(context.graphContext))] };
}

function meshSamplerNode(_inputs: PCGNodeInputs, settings: PCGNodeSettings, context: PCGNodeExecutionContext): PCGNodeOutputs {
  const geometry = settings.geometry as THREE.BufferGeometry | undefined;
  if (!geometry) {
    return { Out: [pointData([])] };
  }
  const position = geometry.getAttribute("position");
  if (!position) {
    return { Out: [pointData([])] };
  }
  const count = integerSetting(settings, ["count", "PointCount", "numPoints"], position.count);
  const points: PCGPoint[] = [];
  const rng = context.graphContext.rng.fork(context.node.id);
  for (let index = 0; index < count; index += 1) {
    const vertex = count >= position.count ? index % position.count : rng.int(0, position.count - 1);
    const x = position.getX(vertex);
    const y = position.getY(vertex);
    const z = position.getZ(vertex);
    const point = createPointFromEntry(context.graphContext.surface, { x, y, z }, `${context.node.id}:${index}`);
    point.position.set(x, y, z);
    point.seed = computeSeedFromPosition(x, y, z);
    points.push(point);
  }
  return { Out: [pointData(points)] };
}

function surfaceScatterNode(_inputs: PCGNodeInputs, settings: PCGNodeSettings, context: PCGNodeExecutionContext): PCGNodeOutputs {
  const generator = surfaceScatter({
    id: context.node.id,
    count: integerSetting(settings, ["count", "PointCount", "numPoints"], 100),
    jitter: numberSetting(settings, ["jitter", "Jitter"], 1)
  });
  return { Out: [pointData(generator.generate(context.graphContext))] };
}

function poissonSurfaceScatterNode(_inputs: PCGNodeInputs, settings: PCGNodeSettings, context: PCGNodeExecutionContext): PCGNodeOutputs {
  const count = integerSetting(settings, ["count", "PointCount", "numPoints"], 100);
  const generator = poissonSurfaceScatter({
    id: context.node.id,
    count,
    radius: numberSetting(settings, ["radius", "Radius"], 100),
    maxAttempts: integerSetting(settings, ["maxAttempts", "MaxAttempts"], count * 24)
  });
  return { Out: [pointData(generator.generate(context.graphContext))] };
}

function addAttributeNode(inputs: PCGNodeInputs, settings: PCGNodeSettings): PCGNodeOutputs {
  const name = stringSetting(settings, ["name", "attribute", "AttributeName"], "Attribute");
  const value = setting(settings, ["value", "Value"], undefined);
  return mapPointData(inputs, (point) => {
    setPointAttribute(point, name, value);
    return point;
  });
}

function createAttributeSetNode(inputs: PCGNodeInputs, settings: PCGNodeSettings): PCGNodeOutputs {
  const attributes = objectSetting(settings, ["attributes", "Attributes", "params"]) ?? {};
  const data = getInputData(inputs);
  if (data.length === 0) {
    return { Out: [paramData(attributes)] };
  }
  return { Out: data.map((entry) => ({ ...cloneTaggedData(entry), attributes: { ...(entry.attributes ?? {}), ...attributes } })) };
}

function deleteAttributesNode(inputs: PCGNodeInputs, settings: PCGNodeSettings): PCGNodeOutputs {
  const names = stringArraySetting(settings, ["names", "attributes", "AttributeNames"]);
  return mapPointData(inputs, (point) => {
    for (const name of names) {
      delete point.attributes[name];
    }
    return point;
  });
}

function copyAttributesNode(inputs: PCGNodeInputs, settings: PCGNodeSettings): PCGNodeOutputs {
  const sourceData = getInputData(inputs, "Source");
  const target = getInputPoints(inputs, "Target").length ? getInputPoints(inputs, "Target") : getInputPoints(inputs);
  const source = sourceData[0]?.attributes ?? sourceData[0]?.points?.[0]?.attributes ?? {};
  const names = stringArraySetting(settings, ["names", "attributes", "AttributeNames"]);
  const copied = target.map((point) => {
    const clone = clonePoint(point);
    for (const [key, value] of Object.entries(source)) {
      if (names.length === 0 || names.includes(key)) {
        setPointAttribute(clone, key, value);
      }
    }
    return clone;
  });
  return { Out: [pointData(copied)] };
}

function mergeAttributesNode(inputs: PCGNodeInputs): PCGNodeOutputs {
  const attributes = Object.values(inputs)
    .flat()
    .reduce<PCGAttributes>((merged, data) => Object.assign(merged, data.attributes ?? {}, data.points?.[0]?.attributes ?? {}), {});
  const points = getInputPoints(inputs).map((point) => {
    const clone = clonePoint(point);
    Object.assign(clone.attributes, attributes);
    return clone;
  });
  return points.length ? { Out: [pointData(points)] } : { Out: [paramData(attributes)] };
}

function renameAttributeNode(inputs: PCGNodeInputs, settings: PCGNodeSettings): PCGNodeOutputs {
  const from = stringSetting(settings, ["from", "input", "InputAttributeName"], "");
  const to = stringSetting(settings, ["to", "output", "OutputAttributeName"], from);
  return mapPointData(inputs, (point) => {
    if (from && from in point.attributes) {
      point.attributes[to] = point.attributes[from];
      delete point.attributes[from];
    }
    return point;
  });
}

function attributeNoiseNode(inputs: PCGNodeInputs, settings: PCGNodeSettings, context: PCGNodeExecutionContext): PCGNodeOutputs {
  const name = stringSetting(settings, ["name", "attribute", "AttributeName"], "Noise");
  const mode = stringSetting(settings, ["mode", "Mode"], "Set").toLowerCase();
  const min = numberSetting(settings, ["min", "Min"], 0);
  const max = numberSetting(settings, ["max", "Max"], 1);
  return mapPointData(inputs, (point, index) => {
    const rng = new SeededRandom(computeSeed(point.seed, hashSeed(context.node.id), index));
    const value = rng.between(min, max);
    const current = numberValue(getPointAttribute(point, name), 0);
    setPointAttribute(point, name, mode.includes("multiply") ? current * value : mode.includes("add") ? current + value : value);
    return point;
  });
}

function attributeRemapNode(inputs: PCGNodeInputs, settings: PCGNodeSettings): PCGNodeOutputs {
  const name = stringSetting(settings, ["name", "attribute", "AttributeName"], "Density");
  const outName = stringSetting(settings, ["outName", "output", "OutputAttributeName"], name);
  const inMin = numberSetting(settings, ["inMin", "InputMin"], 0);
  const inMax = numberSetting(settings, ["inMax", "InputMax"], 1);
  const outMin = numberSetting(settings, ["outMin", "OutputMin"], 0);
  const outMax = numberSetting(settings, ["outMax", "OutputMax"], 1);
  return mapPointData(inputs, (point) => {
    const alpha = THREE.MathUtils.clamp((numberValue(getPointAttribute(point, name), 0) - inMin) / Math.max(1e-6, inMax - inMin), 0, 1);
    setPointAttribute(point, outName, THREE.MathUtils.lerp(outMin, outMax, alpha));
    return point;
  });
}

function attributeReduceNode(inputs: PCGNodeInputs, settings: PCGNodeSettings): PCGNodeOutputs {
  const name = stringSetting(settings, ["name", "attribute", "AttributeName"], "Density");
  const operation = stringSetting(settings, ["operation", "Operation"], "Sum").toLowerCase();
  const values = getInputPoints(inputs).map((point) => numberValue(getPointAttribute(point, name), 0));
  const value =
    operation.includes("min")
      ? Math.min(...values)
      : operation.includes("max")
        ? Math.max(...values)
        : operation.includes("average")
          ? values.reduce((sum, item) => sum + item, 0) / Math.max(1, values.length)
          : values.reduce((sum, item) => sum + item, 0);
  return { Out: [paramData({ [name]: Number.isFinite(value) ? value : 0, Count: values.length })] };
}

function metadataMathNode(inputs: PCGNodeInputs, settings: PCGNodeSettings): PCGNodeOutputs {
  const input = stringSetting(settings, ["input", "InputAttributeName", "name"], "Value");
  const output = stringSetting(settings, ["output", "OutputAttributeName"], input);
  const operation = stringSetting(settings, ["operation", "Operation"], "Set").toLowerCase();
  const operand = numberSetting(settings, ["operand", "Value", "value"], 0);
  return mapPointData(inputs, (point) => {
    const value = numberValue(getPointAttribute(point, input), 0);
    setPointAttribute(point, output, applyNumericOperation(value, operand, operation));
    return point;
  });
}

function metadataCompareNode(inputs: PCGNodeInputs, settings: PCGNodeSettings): PCGNodeOutputs {
  const name = stringSetting(settings, ["name", "attribute", "InputAttributeName"], "Value");
  const threshold = numberSetting(settings, ["threshold", "value", "Value"], 0);
  const op = stringSetting(settings, ["operation", "Operator"], "Greater").toLowerCase();
  return mapPointData(inputs, (point) => {
    const value = numberValue(getPointAttribute(point, name), 0);
    setPointAttribute(point, stringSetting(settings, ["output", "OutputAttributeName"], `${name}_Compare`), compareNumber(value, threshold, op));
    return point;
  });
}

function metadataBooleanNode(inputs: PCGNodeInputs, settings: PCGNodeSettings): PCGNodeOutputs {
  const aName = stringSetting(settings, ["a", "InputA"], "A");
  const bName = stringSetting(settings, ["b", "InputB"], "B");
  const output = stringSetting(settings, ["output", "OutputAttributeName"], "Result");
  const op = stringSetting(settings, ["operation", "Operation"], "And").toLowerCase();
  return mapPointData(inputs, (point) => {
    const a = Boolean(getPointAttribute(point, aName));
    const b = Boolean(getPointAttribute(point, bName));
    setPointAttribute(point, output, op.includes("or") ? a || b : op.includes("not") ? !a : a && b);
    return point;
  });
}

function metadataStringNode(inputs: PCGNodeInputs, settings: PCGNodeSettings): PCGNodeOutputs {
  const input = stringSetting(settings, ["input", "InputAttributeName"], "Value");
  const output = stringSetting(settings, ["output", "OutputAttributeName"], input);
  const search = stringSetting(settings, ["search", "Search"], "");
  const replace = stringSetting(settings, ["replace", "Replace"], "");
  return mapPointData(inputs, (point) => {
    setPointAttribute(point, output, String(getPointAttribute(point, input) ?? "").replaceAll(search, replace));
    return point;
  });
}

function tagsNode(inputs: PCGNodeInputs, settings: PCGNodeSettings): PCGNodeOutputs {
  const tags = stringArraySetting(settings, ["tags", "Tags", "tag"]);
  const data = getInputData(inputs).map((entry) => {
    const clone = cloneTaggedData(entry);
    for (const tag of tags) {
      clone.tags.add(tag);
      for (const point of clone.points ?? []) {
        point.tags.add(tag);
      }
    }
    return clone;
  });
  return { Out: data };
}

function deleteTagsNode(inputs: PCGNodeInputs, settings: PCGNodeSettings): PCGNodeOutputs {
  const tags = stringArraySetting(settings, ["tags", "Tags", "tag"]);
  const data = getInputData(inputs).map((entry) => {
    const clone = cloneTaggedData(entry);
    for (const tag of tags) {
      clone.tags.delete(tag);
      for (const point of clone.points ?? []) {
        point.tags.delete(tag);
      }
    }
    return clone;
  });
  return { Out: data };
}

function filterByTagNode(inputs: PCGNodeInputs, settings: PCGNodeSettings): PCGNodeOutputs {
  const tags = stringArraySetting(settings, ["tags", "Tags", "tag"]);
  const remove = stringSetting(settings, ["operation", "Operation"], "Keep").toLowerCase().includes("remove");
  const kept = getInputData(inputs).map(cloneTaggedData).filter((data) => remove !== tags.some((tag) => data.tags.has(tag)));
  return { Out: kept };
}

function filterByTypeNode(inputs: PCGNodeInputs, settings: PCGNodeSettings): PCGNodeOutputs {
  const kind = stringSetting(settings, ["kind", "type", "DataType"], "point").toLowerCase();
  return { Out: getInputData(inputs).map(cloneTaggedData).filter((data) => data.kind.toLowerCase() === kind) };
}

function filterByIndexNode(inputs: PCGNodeInputs, settings: PCGNodeSettings): PCGNodeOutputs {
  const start = integerSetting(settings, ["start", "StartIndex"], 0);
  const count = integerSetting(settings, ["count", "Count"], Number.POSITIVE_INFINITY);
  return { Out: [pointData(getInputPoints(inputs).map((point) => clonePoint(point)).slice(start, start + count))] };
}

function attributeFilterNode(inputs: PCGNodeInputs, settings: PCGNodeSettings, context: PCGNodeExecutionContext): PCGNodeOutputs {
  const name = stringSetting(settings, ["attribute", "name", "InputAttributeName"], "Density");
  const min = numberSetting(settings, ["min", "Min", "lowerBound"], Number.NEGATIVE_INFINITY);
  const max = numberSetting(settings, ["max", "Max", "upperBound"], Number.POSITIVE_INFINITY);
  const op = stringSetting(settings, ["operator", "Operator"], "Range").toLowerCase();
  const value = setting(settings, ["value", "Value"], undefined);
  const filter =
    name.toLowerCase() === "height"
      ? heightFilter(min, max)
      : name.toLowerCase() === "slope"
        ? slopeFilter(max)
        : name.toLowerCase() === "density" && op === "range"
          ? densityFilter(min, max)
          : attributeRangeFilter(name, min, max);
  const points = getInputPoints(inputs)
    .map((point) => clonePoint(point))
    .filter((point) => {
      if (op !== "range" && value !== undefined) {
        return compareUnknown(getPointAttribute(point, name), value, op);
      }
      return filter(point, context.graphContext) > 0;
    });
  return { Out: [pointData(points)] };
}

function densityFilterNode(inputs: PCGNodeInputs, settings: PCGNodeSettings): PCGNodeOutputs {
  const min = numberSetting(settings, ["min", "LowerBound"], 0);
  const max = numberSetting(settings, ["max", "UpperBound"], 1);
  return { Out: [pointData(getInputPoints(inputs).map((point) => clonePoint(point)).filter((point) => point.density >= min && point.density <= max))] };
}

function densityRemapNode(inputs: PCGNodeInputs, settings: PCGNodeSettings): PCGNodeOutputs {
  const inMin = numberSetting(settings, ["inMin", "InputMin"], 0);
  const inMax = numberSetting(settings, ["inMax", "InputMax"], 1);
  const outMin = numberSetting(settings, ["outMin", "OutputMin"], 0);
  const outMax = numberSetting(settings, ["outMax", "OutputMax"], 1);
  return mapPointData(inputs, (point) => {
    const alpha = THREE.MathUtils.clamp((point.density - inMin) / Math.max(1e-6, inMax - inMin), 0, 1);
    point.density = THREE.MathUtils.lerp(outMin, outMax, alpha);
    return point;
  });
}

function normalToDensityNode(inputs: PCGNodeInputs): PCGNodeOutputs {
  return mapPointData(inputs, (point) => {
    point.density *= THREE.MathUtils.clamp(point.normal.y, 0, 1);
    return point;
  });
}

function transformPointsNode(inputs: PCGNodeInputs, settings: PCGNodeSettings, context: PCGNodeExecutionContext): PCGNodeOutputs {
  const translation = vectorSetting(settings, ["translation", "offset", "Offset"], new THREE.Vector3());
  const rotationY = numberSetting(settings, ["rotationY", "yaw", "Yaw"], 0);
  const scale = vectorOrNumberSetting(settings, ["scale", "Scale"], 1);
  const jitter = numberSetting(settings, ["jitter", "Jitter"], 0);
  const recomputeSeed = booleanSetting(settings, ["recomputeSeed", "bRecomputeSeed"], false);
  return mapPointData(inputs, (point) => {
    if (jitter > 0) {
      const angle = context.graphContext.rng.between(0, Math.PI * 2);
      const radius = context.graphContext.rng.between(0, jitter);
      point.position.x += Math.cos(angle) * radius;
      point.position.z += Math.sin(angle) * radius;
    }
    point.position.add(translation);
    point.rotationY += rotationY;
    if (typeof scale === "number") {
      point.scale.multiplyScalar(scale);
    } else {
      point.scale.multiply(scale);
    }
    if (recomputeSeed) {
      point.seed = computeSeedFromPosition(point.position.x, point.position.y, point.position.z);
    }
    return point;
  });
}

function duplicatePointNode(inputs: PCGNodeInputs, settings: PCGNodeSettings, context: PCGNodeExecutionContext): PCGNodeOutputs {
  const count = integerSetting(settings, ["count", "Count"], 2);
  const offset = vectorSetting(settings, ["offset", "Offset"], new THREE.Vector3());
  const out: PCGPoint[] = [];
  for (const point of getInputPoints(inputs)) {
    for (let index = 0; index < count; index += 1) {
      const clone = clonePoint(point, `${point.id}:dup:${index}`);
      clone.position.add(offset.clone().multiplyScalar(index));
      clone.seed = computeSeed(point.seed, hashSeed(context.node.id), index);
      out.push(clone);
    }
  }
  return { Out: [pointData(out)] };
}

function copyPointsNode(inputs: PCGNodeInputs): PCGNodeOutputs {
  const sources = getInputPoints(inputs, "Source");
  const targets = getInputPoints(inputs, "Target");
  if (sources.length === 0 || targets.length === 0) {
    return { Out: [pointData(getInputPoints(inputs).map((point) => clonePoint(point)))] };
  }
  const out: PCGPoint[] = [];
  for (const target of targets) {
    for (const source of sources) {
      const clone = clonePoint(source, `${source.id}:copy:${target.id}`);
      clone.position.copy(target.position);
      clone.normal.copy(target.normal);
      clone.seed = computeSeed(source.seed, target.seed);
      Object.assign(clone.attributes, target.attributes);
      out.push(clone);
    }
  }
  return { Out: [pointData(out)] };
}

function projectionNode(inputs: PCGNodeInputs, settings: PCGNodeSettings, context: PCGNodeExecutionContext): PCGNodeOutputs {
  const yOffset = numberSetting(settings, ["yOffset", "Offset"], 0);
  return mapPointData(inputs, (point) => {
    projectPointToSurface(point, context.graphContext.surface, yOffset);
    return point;
  });
}

function boundsModifierNode(inputs: PCGNodeInputs, settings: PCGNodeSettings): PCGNodeOutputs {
  const extents = vectorSetting(settings, ["extents", "Extents", "bounds"], new THREE.Vector3(1, 1, 1));
  const mode = stringSetting(settings, ["mode", "Mode"], "Set").toLowerCase();
  return mapPointData(inputs, (point) => {
    const current = point.boundsMax.clone().sub(point.boundsMin).multiplyScalar(0.5);
    const next = mode.includes("add") ? current.add(extents) : mode.includes("multiply") ? current.multiply(extents) : extents;
    setLocalExtents(point, next);
    return point;
  });
}

function pointExtentsModifierNode(inputs: PCGNodeInputs, settings: PCGNodeSettings): PCGNodeOutputs {
  return boundsModifierNode(inputs, settings);
}

function applyScaleToBoundsNode(inputs: PCGNodeInputs): PCGNodeOutputs {
  return mapPointData(inputs, (point) => {
    const absScale = new THREE.Vector3(Math.abs(point.scale.x), Math.abs(point.scale.y), Math.abs(point.scale.z));
    point.boundsMin.multiply(absScale);
    point.boundsMax.multiply(absScale);
    point.bounds = pointBoundsFromMinMax(point.boundsMin, point.boundsMax);
    point.scale.set(Math.sign(point.scale.x) || 1, Math.sign(point.scale.y) || 1, Math.sign(point.scale.z) || 1);
    return point;
  });
}

function mutateSeedNode(inputs: PCGNodeInputs, settings: PCGNodeSettings): PCGNodeOutputs {
  const seed = integerSetting(settings, ["seed", "Seed"], 0);
  return mapPointData(inputs, (point) => {
    point.seed = computeSeed(computeSeedFromPosition(point.position.x, point.position.y, point.position.z), seed, point.seed);
    return point;
  });
}

function selectPointsNode(inputs: PCGNodeInputs, settings: PCGNodeSettings): PCGNodeOutputs {
  const choiceOptions: { fixedNumber?: number; ratio?: number; seed?: string | number; combineFirstPointSeed?: boolean } = {
    seed: setting(settings, ["seed", "Seed"], 42) as string | number,
    combineFirstPointSeed: booleanSetting(settings, ["combineFirstPointSeed"], true)
  };
  const fixedNumber = optionalIntegerSetting(settings, ["fixedNumber", "FixedNumber", "count"]);
  const ratio = optionalNumberSetting(settings, ["ratio", "Ratio"]);
  if (fixedNumber !== undefined) {
    choiceOptions.fixedNumber = fixedNumber;
  } else if (ratio !== undefined) {
    choiceOptions.ratio = ratio;
  }
  const result = randomChoice(getInputPoints(inputs).map((point) => clonePoint(point)), choiceOptions);
  return { Out: [pointData(result.chosen)], Discarded: [pointData(result.discarded)] };
}

function selfPruningNode(inputs: PCGNodeInputs, settings: PCGNodeSettings): PCGNodeOutputs {
  const options: { pruningType?: never; radiusSimilarityFactor?: number; randomizedPruning?: boolean } = {
    pruningType: stringSetting(settings, ["pruningType", "PruningType", "type"], "LargeToSmall") as never,
    randomizedPruning: booleanSetting(settings, ["randomizedPruning", "bRandomizedPruning"], true)
  };
  const radiusSimilarityFactor = optionalNumberSetting(settings, ["radiusSimilarityFactor", "RadiusSimilarityFactor"]);
  if (radiusSimilarityFactor !== undefined) {
    options.radiusSimilarityFactor = radiusSimilarityFactor;
  }
  const result = selfPrune(getInputPoints(inputs).map((point) => clonePoint(point)), options);
  return { Out: [pointData(result.points)], Rejected: [pointData(result.rejected)] };
}

function differenceNode(inputs: PCGNodeInputs, settings: PCGNodeSettings): PCGNodeOutputs {
  const source = getInputPoints(inputs, "Source").length ? getInputPoints(inputs, "Source") : getInputPoints(inputs);
  const difference = getInputPoints(inputs, "Difference");
  const padding = numberSetting(settings, ["padding", "Padding"], 0);
  const kept = source.map((point) => clonePoint(point)).filter((point) => !difference.some((other) => pointsOverlap(point, other, padding)));
  return { Out: [pointData(kept)] };
}

function intersectionNode(inputs: PCGNodeInputs, settings: PCGNodeSettings): PCGNodeOutputs {
  const source = getInputPoints(inputs, "Source").length ? getInputPoints(inputs, "Source") : getInputPoints(inputs);
  const other = getInputPoints(inputs, "Intersection");
  const padding = numberSetting(settings, ["padding", "Padding"], 0);
  const kept = source.map((point) => clonePoint(point)).filter((point) => other.some((candidate) => pointsOverlap(point, candidate, padding)));
  return { Out: [pointData(kept)] };
}

function spatialMaskNode(_inputs: PCGNodeInputs, settings: PCGNodeSettings): PCGNodeOutputs {
  const id = stringSetting(settings, ["id", "name"], "mask");
  const kind = stringSetting(settings, ["kind", "shape", "type"], "box").toLowerCase();
  const density = numberSetting(settings, ["density", "Density"], 1);
  const feather = numberSetting(settings, ["feather", "Feather"], 0);
  const mask =
    kind.includes("circle")
      ? circleMask({ id, center: vec2Setting(settings, ["center", "Center"], { x: 0, z: 0 }), radius: numberSetting(settings, ["radius", "Radius"], 1), density, feather })
      : kind.includes("spline")
        ? splineMask({ id, points: points2DSetting(settings, ["points", "Points"]) ?? [], radius: numberSetting(settings, ["radius", "Radius"], 1), density, feather })
        : kind.includes("polygon")
          ? polygonMask({ id, points: points2DSetting(settings, ["points", "Points"]) ?? [], density, feather })
          : textureMaskIfValid(id, settings, density) ?? boxMask({ id, bounds: boundsSetting(settings, { minX: -1, maxX: 1, minZ: -1, maxZ: 1 }), density, feather });
  return { Out: [spatialData(mask)] };
}

function staticMeshSpawnerNode(inputs: PCGNodeInputs, settings: PCGNodeSettings): PCGNodeOutputs {
  const assetId = stringSetting(settings, ["assetId", "mesh", "Mesh", "actorClass"], "asset");
  return mapPointData(inputs, (point) => {
    point.assetId = assetId;
    point.assetType = stringSetting(settings, ["assetType", "type"], "staticMesh");
    point.attributes.Asset = assetId;
    point.attributes.AssetType = point.assetType;
    return point;
  });
}

function matchAndSetAttributesNode(inputs: PCGNodeInputs, settings: PCGNodeSettings, context: PCGNodeExecutionContext): PCGNodeOutputs {
  const entries = arraySetting<PCGAssetEntry>(settings, ["entries", "assets", "Entries"]) ?? [];
  if (entries.length === 0) {
    return passThroughNode(inputs);
  }
  const table = createRootAssetTable(entries);
  const points = getInputPoints(inputs).flatMap((point) => {
    const asset = selectAssetForPoint(table, point, context.graphContext.assetSelectionSeed ?? context.graphContext.rng.getInitialSeed());
    if (!asset) {
      return [];
    }
    return [assignAssetToPoint(clonePoint(point), asset)];
  });
  return { Out: [pointData(points)] };
}

function providerNode(inputs: PCGNodeInputs, settings: PCGNodeSettings, context: PCGNodeExecutionContext): PCGNodeOutputs {
  const provider = settings.provider;
  if (typeof provider === "function") {
    const result = provider(inputs, context.graphContext, settings);
    return normalizeProviderResult(result);
  }
  return passThroughNode(inputs);
}

function worldRayHitNode(inputs: PCGNodeInputs, settings: PCGNodeSettings, context: PCGNodeExecutionContext): PCGNodeOutputs {
  const raycast = settings.raycast;
  if (typeof raycast !== "function") {
    return projectionNode(inputs, settings, context);
  }
  return mapPointData(inputs, (point) => {
    const hit = raycast(point, context.graphContext, settings) as { position?: THREE.Vector3; normal?: THREE.Vector3 } | undefined;
    if (hit?.position) {
      point.position.copy(hit.position);
      point.seed = computeSeedFromPosition(point.position.x, point.position.y, point.position.z);
    }
    if (hit?.normal) {
      point.normal.copy(hit.normal);
    }
    return point;
  });
}

function customKernelNode(inputs: PCGNodeInputs, settings: PCGNodeSettings, context: PCGNodeExecutionContext): PCGNodeOutputs {
  const kernel = settings.kernel ?? settings.execute;
  if (typeof kernel !== "function") {
    return passThroughNode(inputs);
  }
  return normalizeProviderResult(kernel(inputs, context.graphContext, settings));
}

function subgraphNode(inputs: PCGNodeInputs, settings: PCGNodeSettings, context: PCGNodeExecutionContext): PCGNodeOutputs {
  const graph = settings.graph as PCGExecutableGraph | undefined;
  if (!graph) {
    return passThroughNode(inputs);
  }
  return runPCGGraph(graph, context.graphContext, inputs, context.registry);
}

function loopNode(inputs: PCGNodeInputs, settings: PCGNodeSettings, context: PCGNodeExecutionContext): PCGNodeOutputs {
  const iterations = integerSetting(settings, ["iterations", "count", "NumIterations"], 1);
  const graph = settings.graph as PCGExecutableGraph | undefined;
  let current = cloneInputs(inputs);
  for (let index = 0; index < iterations; index += 1) {
    context.graphContext.attributes.LoopIndex = index;
    current = graph ? runPCGGraph(graph, context.graphContext, current, context.registry) : current;
  }
  return current;
}

function sortNode(inputs: PCGNodeInputs, settings: PCGNodeSettings): PCGNodeOutputs {
  const attribute = stringSetting(settings, ["attribute", "name", "AttributeName"], "Seed");
  const descending = booleanSetting(settings, ["descending", "bDescending"], false);
  const points = getInputPoints(inputs).map((point) => clonePoint(point)).sort((a, b) => {
    const av = sortableValue(getPointAttribute(a, attribute));
    const bv = sortableValue(getPointAttribute(b, attribute));
    return descending ? bv.localeCompare(av) : av.localeCompare(bv);
  });
  return { Out: [pointData(points)] };
}

function removeEmptyDataNode(inputs: PCGNodeInputs): PCGNodeOutputs {
  return {
    Out: getInputData(inputs)
      .map(cloneTaggedData)
      .filter((data) => data.kind !== "empty" && (data.kind !== "point" || (data.points?.length ?? 0) > 0))
  };
}

function mapPointData(inputs: PCGNodeInputs, mapper: (point: PCGPoint, index: number) => PCGPoint | undefined): PCGNodeOutputs {
  let index = 0;
  const points = getInputPoints(inputs).flatMap((point) => {
    const mapped = mapper(clonePoint(point), index++);
    return mapped ? [mapped] : [];
  });
  return { Out: [pointData(points)] };
}

function buildNodeInputs(
  nodeId: string,
  incoming: PCGGraphEdge[],
  outputsByNode: Map<string, PCGNodeOutputs>,
  fallback: PCGNodeInputs
): PCGNodeInputs {
  if (incoming.length === 0) {
    return cloneInputs(fallback);
  }
  const inputs: PCGNodeInputs = {};
  for (const edge of incoming) {
    const outputs = outputsByNode.get(edge.fromNode);
    if (!outputs) {
      throw new Error(`PCG node "${nodeId}" depends on unresolved node "${edge.fromNode}".`);
    }
    const source = outputs[edge.fromPin ?? "Out"] ?? outputs.Out ?? [];
    const pin = edge.toPin ?? "In";
    inputs[pin] = [...(inputs[pin] ?? []), ...source.map(cloneTaggedData)];
  }
  return inputs;
}

function mergeOutputs(a: PCGNodeOutputs, b: PCGNodeOutputs): PCGNodeOutputs {
  const out: PCGNodeOutputs = { ...a };
  for (const [pin, data] of Object.entries(b)) {
    out[pin] = [...(out[pin] ?? []), ...data.map(cloneTaggedData)];
  }
  return out;
}

function createPointFromEntry(surface: PCGSurface, entry: Record<string, unknown>, id: string): PCGPoint {
  const x = numberValue(entry.x ?? entry.X ?? (entry.position as { x?: number } | undefined)?.x, 0);
  const z = numberValue(entry.z ?? entry.Z ?? (entry.position as { z?: number } | undefined)?.z, 0);
  const y = optionalNumberValue(entry.y ?? entry.Y ?? (entry.position as { y?: number } | undefined)?.y);
  const options: {
    id: string;
    density?: number;
    seed?: number;
    boundsMin?: THREE.Vector3;
    boundsMax?: THREE.Vector3;
    scale?: number | THREE.Vector3;
    attributes?: PCGAttributes;
  } = {
    id: stringSetting(entry, ["id"], id),
    density: numberValue(entry.density ?? entry.Density, 1),
    scale: vectorOrNumberValue(entry.scale ?? entry.Scale, 1),
    attributes: objectValue(entry.attributes ?? entry.Attributes) ?? {}
  };
  if (typeof entry.seed === "number") {
    options.seed = entry.seed;
  }
  const boundsMin = vectorMaybe(entry.boundsMin ?? entry.BoundsMin);
  if (boundsMin) {
    options.boundsMin = boundsMin;
  }
  const boundsMax = vectorMaybe(entry.boundsMax ?? entry.BoundsMax);
  if (boundsMax) {
    options.boundsMax = boundsMax;
  }
  const point = newPoint(surface, x, z, options);
  if (y !== undefined) {
    point.position.y = y;
    point.seed = typeof entry.seed === "number" ? entry.seed : computeSeedFromPosition(x, y, z);
  }
  return point;
}

function newPoint(
  surface: PCGSurface,
  x: number,
  z: number,
  options: {
    id: string;
    density?: number;
    seed?: number;
    boundsMin?: THREE.Vector3;
    boundsMax?: THREE.Vector3;
    scale?: number | THREE.Vector3;
    attributes?: PCGAttributes;
  }
): PCGPoint {
  const sample = surface.sampleAt(x, z);
  const scale = typeof options.scale === "number" ? new THREE.Vector3(options.scale, options.scale, options.scale) : options.scale?.clone() ?? new THREE.Vector3(1, 1, 1);
  const boundsMin = options.boundsMin?.clone() ?? new THREE.Vector3(-1, -1, -1);
  const boundsMax = options.boundsMax?.clone() ?? new THREE.Vector3(1, 1, 1);
  return {
    id: options.id,
    position: new THREE.Vector3(x, sample.height, z),
    rotationY: 0,
    scale,
    normal: sample.normal.clone(),
    density: options.density ?? 1,
    boundsMin,
    boundsMax,
    bounds: pointBoundsFromMinMax(boundsMin, boundsMax),
    color: new THREE.Color(1, 1, 1),
    steepness: 0.5,
    seed: options.seed ?? computeSeedFromPosition(x, sample.height, z),
    biomePriority: 0,
    generatorPriority: 0,
    priority: 0,
    recursionLevel: 0,
    allowOverlap: false,
    tags: new Set(),
    attributes: { ...(sample.attributes ?? {}), ...(options.attributes ?? {}) }
  };
}

function normalizeProviderResult(result: unknown): PCGNodeOutputs {
  if (isOutputs(result)) {
    return result;
  }
  if (Array.isArray(result) && result.every(isTaggedData)) {
    return { Out: result };
  }
  if (Array.isArray(result)) {
    return { Out: [pointData(result.filter(isPoint))] };
  }
  if (isTaggedData(result)) {
    return { Out: [result] };
  }
  if (isRecord(result)) {
    return { Out: [paramData(result)] };
  }
  return { Out: [] };
}

function isOutputs(value: unknown): value is PCGNodeOutputs {
  return isRecord(value) && Object.values(value).every((entry) => Array.isArray(entry));
}

function isTaggedData(value: unknown): value is PCGTaggedData {
  return isRecord(value) && typeof value.kind === "string" && value.tags instanceof Set;
}

function isPoint(value: unknown): value is PCGPoint {
  return isRecord(value) && value.position instanceof THREE.Vector3 && typeof value.seed === "number";
}

function getPointAttribute(point: PCGPoint, name: string): unknown {
  const key = name.toLowerCase();
  if (key === "position" || key === "transform") {
    return point.position;
  }
  if (key === "density") {
    return point.density;
  }
  if (key === "seed") {
    return point.seed;
  }
  if (key === "rotation" || key === "rotationy" || key === "yaw") {
    return point.rotationY;
  }
  if (key === "scale") {
    return point.scale;
  }
  if (key === "boundsmin") {
    return point.boundsMin;
  }
  if (key === "boundsmax") {
    return point.boundsMax;
  }
  if (key === "height" || key === "y") {
    return point.position.y;
  }
  return point.attributes[name];
}

function setPointAttribute(point: PCGPoint, name: string, value: unknown): void {
  const key = name.toLowerCase();
  if (key === "density") {
    point.density = numberValue(value, point.density);
  } else if (key === "seed") {
    point.seed = numberValue(value, point.seed);
  } else if (key === "rotation" || key === "rotationy" || key === "yaw") {
    point.rotationY = numberValue(value, point.rotationY);
  } else if (key === "position" || key === "transform") {
    const vector = vectorMaybe(value);
    if (vector) {
      point.position.copy(vector);
    }
  } else if (key === "scale") {
    const scale = vectorOrNumberValue(value, point.scale);
    if (typeof scale === "number") {
      point.scale.setScalar(scale);
    } else {
      point.scale.copy(scale);
    }
  } else {
    point.attributes[name] = value;
  }
}

function normalizeType(type: string): string {
  return type.replace(/^U/, "").replace(/Settings$/, "").toLowerCase();
}

function setting(settings: Record<string, unknown>, keys: string[], fallback: unknown): unknown {
  for (const key of keys) {
    if (settings[key] !== undefined) {
      return settings[key];
    }
  }
  return fallback;
}

function numberSetting(settings: Record<string, unknown>, keys: string[], fallback: number): number {
  return optionalNumberSetting(settings, keys) ?? fallback;
}

function optionalNumberSetting(settings: Record<string, unknown>, keys: string[]): number | undefined {
  const value = setting(settings, keys, undefined);
  return optionalNumberValue(value);
}

function integerSetting(settings: Record<string, unknown>, keys: string[], fallback: number): number {
  return Math.floor(numberSetting(settings, keys, fallback));
}

function optionalIntegerSetting(settings: Record<string, unknown>, keys: string[]): number | undefined {
  const value = optionalNumberSetting(settings, keys);
  return value === undefined ? undefined : Math.floor(value);
}

function booleanSetting(settings: Record<string, unknown>, keys: string[], fallback: boolean): boolean {
  const value = setting(settings, keys, fallback);
  return typeof value === "boolean" ? value : typeof value === "string" ? value.toLowerCase() === "true" : Boolean(value);
}

function stringSetting(settings: Record<string, unknown>, keys: string[], fallback: string): string {
  const value = setting(settings, keys, fallback);
  return value === undefined ? fallback : String(value);
}

function stringArraySetting(settings: Record<string, unknown>, keys: string[]): string[] {
  const value = setting(settings, keys, []);
  return Array.isArray(value) ? value.map(String) : typeof value === "string" ? value.split(",").map((entry) => entry.trim()).filter(Boolean) : [];
}

function arraySetting<T>(settings: Record<string, unknown>, keys: string[]): T[] | undefined {
  const value = setting(settings, keys, undefined);
  return Array.isArray(value) ? (value as T[]) : undefined;
}

function arrayLikeNumberSetting(settings: Record<string, unknown>, keys: string[]): ArrayLike<number> | undefined {
  const value = setting(settings, keys, undefined);
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    return value as ArrayLike<number>;
  }
  return undefined;
}

function objectSetting(settings: Record<string, unknown>, keys: string[]): PCGAttributes | undefined {
  return objectValue(setting(settings, keys, undefined));
}

function objectValue(value: unknown): PCGAttributes | undefined {
  return isRecord(value) ? { ...value } : undefined;
}

function boundsSetting(settings: Record<string, unknown>, fallback: PCGBounds2D): PCGBounds2D {
  const value = setting(settings, ["bounds", "Bounds"], undefined);
  if (isRecord(value)) {
    return {
      minX: numberValue(value.minX ?? value.MinX, fallback.minX),
      maxX: numberValue(value.maxX ?? value.MaxX, fallback.maxX),
      minZ: numberValue(value.minZ ?? value.MinZ, fallback.minZ),
      maxZ: numberValue(value.maxZ ?? value.MaxZ, fallback.maxZ)
    };
  }
  return {
    minX: numberSetting(settings, ["minX", "MinX"], fallback.minX) ?? fallback.minX,
    maxX: numberSetting(settings, ["maxX", "MaxX"], fallback.maxX) ?? fallback.maxX,
    minZ: numberSetting(settings, ["minZ", "MinZ"], fallback.minZ) ?? fallback.minZ,
    maxZ: numberSetting(settings, ["maxZ", "MaxZ"], fallback.maxZ) ?? fallback.maxZ
  };
}

function vectorSetting(settings: Record<string, unknown>, keys: string[], fallback: THREE.Vector3): THREE.Vector3 {
  return vectorMaybe(setting(settings, keys, undefined)) ?? fallback.clone();
}

function vectorOrNumberSetting(settings: Record<string, unknown>, keys: string[], fallback: number | THREE.Vector3): number | THREE.Vector3 {
  const value = setting(settings, keys, fallback);
  return vectorOrNumberValue(value, fallback);
}

function vectorOrNumberValue(value: unknown, fallback: number | THREE.Vector3): number | THREE.Vector3 {
  const vector = vectorMaybe(value);
  if (vector) {
    return vector;
  }
  if (typeof value === "number") {
    return value;
  }
  return fallback instanceof THREE.Vector3 ? fallback.clone() : fallback;
}

function vectorMaybe(value: unknown): THREE.Vector3 | undefined {
  if (value instanceof THREE.Vector3) {
    return value.clone();
  }
  if (Array.isArray(value) && value.length >= 3) {
    return new THREE.Vector3(numberValue(value[0], 0), numberValue(value[1], 0), numberValue(value[2], 0));
  }
  if (isRecord(value)) {
    return new THREE.Vector3(numberValue(value.x ?? value.X, 0), numberValue(value.y ?? value.Y, 0), numberValue(value.z ?? value.Z, 0));
  }
  return undefined;
}

function vec2Setting(settings: Record<string, unknown>, keys: string[], fallback: Vec2): Vec2 {
  const value = setting(settings, keys, undefined);
  if (isRecord(value)) {
    return { x: numberValue(value.x ?? value.X, fallback.x), z: numberValue(value.z ?? value.Z, fallback.z) };
  }
  return fallback;
}

function points2DSetting(settings: Record<string, unknown>, keys: string[]): Vec2[] | undefined {
  const value = setting(settings, keys, undefined);
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    return [{ x: numberValue(entry.x ?? entry.X, 0), z: numberValue(entry.z ?? entry.Z, 0) }];
  });
}

function maskPolyline(inputs: PCGNodeInputs): Vec2[] | undefined {
  const points = getInputPoints(inputs);
  return points.length ? points.map((point) => ({ x: point.position.x, z: point.position.z })) : undefined;
}

function textureMaskIfValid(id: string, settings: PCGNodeSettings, density: number): PCGSpatialMask | undefined {
  const values = arrayLikeNumberSetting(settings, ["values", "texture", "Texture"]);
  const width = integerSetting(settings, ["width", "Width"], 0);
  const height = integerSetting(settings, ["height", "Height"], 0);
  if (!values || width <= 0 || height <= 0) {
    return undefined;
  }
  return textureMask({ id, bounds: boundsSetting(settings, { minX: 0, maxX: 1, minZ: 0, maxZ: 1 }), width, height, values, density });
}

function numberValue(value: unknown, fallback: number): number {
  return optionalNumberValue(value) ?? fallback;
}

function optionalNumberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function applyNumericOperation(value: number, operand: number, operation: string): number {
  if (operation.includes("add")) {
    return value + operand;
  }
  if (operation.includes("subtract")) {
    return value - operand;
  }
  if (operation.includes("multiply")) {
    return value * operand;
  }
  if (operation.includes("divide")) {
    return operand === 0 ? 0 : value / operand;
  }
  if (operation.includes("pow")) {
    return Math.pow(value, operand);
  }
  if (operation.includes("sqrt")) {
    return Math.sqrt(Math.max(0, value));
  }
  if (operation.includes("floor")) {
    return Math.floor(value);
  }
  if (operation.includes("ceil")) {
    return Math.ceil(value);
  }
  if (operation.includes("clamp")) {
    return THREE.MathUtils.clamp(value, 0, operand);
  }
  if (operation.includes("oneminus")) {
    return 1 - value;
  }
  return operand;
}

function compareNumber(value: number, threshold: number, operation: string): boolean {
  if (operation.includes("greaterequal")) {
    return value >= threshold;
  }
  if (operation.includes("greater")) {
    return value > threshold;
  }
  if (operation.includes("lessequal") || operation.includes("lessorequal")) {
    return value <= threshold;
  }
  if (operation.includes("less")) {
    return value < threshold;
  }
  if (operation.includes("notequal")) {
    return value !== threshold;
  }
  return value === threshold;
}

function compareUnknown(a: unknown, b: unknown, operation: string): boolean {
  if (typeof a === "number" || typeof b === "number") {
    return compareNumber(numberValue(a, 0), numberValue(b, 0), operation);
  }
  const av = String(a ?? "");
  const bv = String(b ?? "");
  if (operation.includes("substring") || operation.includes("matches")) {
    return av.includes(bv);
  }
  if (operation.includes("notequal")) {
    return av !== bv;
  }
  return av === bv;
}

function sortableValue(value: unknown): string {
  if (typeof value === "number") {
    return value.toString().padStart(20, "0");
  }
  if (value instanceof THREE.Vector3) {
    return `${value.x},${value.y},${value.z}`;
  }
  return String(value ?? "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
