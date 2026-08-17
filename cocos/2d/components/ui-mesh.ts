/*
 Copyright (c) 2026
 Generic 2D mesh data consumer. The plugin / user feeds pre-baked vertex, index
 and segment data through setMeshData; this component owns the vertex buffers,
 batching and submission (via the 2D batcher). Rendering internals (RenderData /
 StaticVBAccessor) stay engine-side, so extensions can render custom meshes
 without touching engine internals.

 Vertex-space contract: incoming vertices are ALWAYS in the component node's
 local space; UIMesh owns applying the node's world matrix:
   * not batched -- on the GPU, via the USE_LOCAL macro + the per-draw
     cc-local UBO the 2D batcher already maintains for middleware draws
     (web: DrawBatch.useLocalData; native: RenderEntity useLocal bit);
   * batched     -- on the CPU, baked into the chunk copy right here, so
     draws still merge (a merged batch has no per-draw matrix).
 Either way the caller never touches USE_LOCAL / useLocalData /
 RenderEntity.setUseLocal -- those legacy switches are derived internally.
 There is no "already world-baked" mode: consumers feed node-local data and
 never apply the node transform themselves.

 Opacity contract: UIMesh data is FillColorType.VERTEX (vertex color is used
 as-is), so the batcher does not apply cascaded node opacity. UIMesh itself
 multiplies the cascaded opacity (own color alpha x every ancestor's
 UIOpacity-driven localOpacity) into the copied vertices every frame.
 `premultipliedAlpha` declares the data format: straight data fades through
 the alpha byte only; premultiplied data scales light RGBA + dark RGB so the
 blend result stays linear in opacity.
*/

import { JSB } from 'internal:constants';
import { ccclass, editable, serializable } from 'cc.decorator';
import { errorID } from '../../core';
import { UIRenderer } from '../framework/ui-renderer';
import { RenderData } from '../renderer/render-data';
import { RenderDrawInfo, RenderDrawInfoType } from '../renderer/render-draw-info';
import { StaticVBAccessor } from '../renderer/static-vb-accessor';
import type { Batcher2D } from '../renderer/batcher-2d';
import { vfmtPosUvColor4B, vfmtPosUvTwoColor4B, getAttributeStride } from '../renderer/vertex-format';
import { RenderEntity, RenderEntityType } from '../renderer/render-entity';
import { director } from '../../game';
import { Texture2D } from '../../asset/assets';
import { builtinResMgr } from '../../asset/asset-manager';
import { BlendFactor } from '../../gfx';
import type { MeshBuffer } from '../renderer/mesh-buffer';
import type { MaterialInstance } from '../../render-scene';
import type { Material } from '../../asset/assets/material';
import type { Node } from '../../scene-graph';

/**
 * @en A segment of the mesh: a range of indices drawn with one texture+material.
 * @zh 网格的一个片段：一段索引，用同一纹理+材质绘制。
 */
export interface UIMeshSegment {
    indexOffset: number;
    indexCount: number;
    texture: Texture2D | null;
    material: MaterialInstance | null;
}

/**
 * @en Pre-baked mesh data for one frame.
 * @zh 一帧的预烘焙网格数据。
 * vertexStride: 24 (single-color V3F_T2F_C4B) or 28 (two-color V3F_T2F_C4B_C4B).
 */
export interface UIMeshData {
    vertexCount: number;
    vertexStride: number;
    vertexData: Uint8Array;
    indexCount: number;
    indexData: Uint8Array;
    segments: UIMeshSegment[];
}

// Shared static vertex-buffer accessors, isolated per Batcher2D instance.
// Batcher2D.destroy() destroys every accessor registered with it, so whenever
// the current batcher changes (a root destroyed and rebuilt within the same JS
// context) the cache is invalidated: a destroyed accessor must never be reused,
// and every new accessor must be registered with the new batcher or its
// buffers would never be uploaded or reset.
let _accessorBatcher: Batcher2D | null = null;
let _sharedAccessor: StaticVBAccessor | null = null;
let _sharedTintAccessor: StaticVBAccessor | null = null;

// Registration keys in the batcher's accessor map (base-36 namespaced, the
// same convention as the built-in middleware assemblers — spine/dragon-bones).
const UIMESH_ACCESSOR_KEY = Number.parseInt('UIMESH', 36);
const UIMESH_TINT_ACCESSOR_KEY = Number.parseInt('UIMESHTINT', 36);

// The two vertex formats UIMesh consumes; strides derived from the format
// definitions themselves (24 = V3F_T2F_C4B, 28 = V3F_T2F_C4B_C4B). Anything
// else would desync the byte math from the allocated chunk's format.
const MESH_STRIDE_BYTES = getAttributeStride(vfmtPosUvColor4B);
const MESH_STRIDE_TINT_BYTES = getAttributeStride(vfmtPosUvTwoColor4B);

/**
 * @en A generic 2D mesh renderer that consumes pre-baked vertex/index data.
 * The data provider (e.g. a spine plugin) fills setMeshData every frame; this
 * component handles buffer allocation, batching and submission.
 * @zh 通用 2D 网格渲染器，消费预烘焙的顶点/索引数据。数据提供方（如 spine 插件）
 * 每帧调用 setMeshData，本组件负责缓冲分配、合批与提交。
 */
@ccclass('cc.UIMesh')
export class UIMesh extends UIRenderer {
    @serializable
    protected _enableBatch = false;

    /**
     * @en Whether the incoming color data is premultiplied-alpha. Declares how
     * cascaded opacity is folded into the vertices (alpha byte only vs
     * RGBA + dark RGB) and the blend factors of the builtin material.
     * @zh 输入颜色数据是否为预乘 alpha 格式。决定级联不透明度折算方式
     * （仅 alpha 字节 vs RGBA + dark RGB）及内置材质混合因子。
     */
    @serializable
    protected _premultipliedAlpha = false;

    protected _meshData: UIMeshData | null = null;
    protected _useTint = false;
    private _drawInfoList: RenderDrawInfo[] = [];

    // JSB staleness poll cache (see update): the opacity / world-affine values
    // captured by the last _prepareBuffers run. Drift means the vertex bytes
    // (baked transform / folded opacity) no longer match the node state.
    private _pollOpacity = 1;
    private _pollM00 = 1;
    private _pollM01 = 0;
    private _pollM04 = 0;
    private _pollM05 = 1;
    private _pollM12 = 0;
    private _pollM13 = 0;

    constructor () {
        super();
        this._useVertexOpacity = true;
    }

    /**
     * @en Feeds the pre-baked mesh data for the current frame.
     * @zh 喂入当前帧的预烘焙网格数据。
     */
    public setMeshData (data: UIMeshData): void {
        // Boundary validation: bad input is reported here, at the call site,
        // instead of corrupting shared vertex buffers or throwing mid-render.
        // A rejected frame keeps the last accepted mesh.
        if (!this._validateMeshData(data)) return;
        const useTint = data.vertexStride === MESH_STRIDE_TINT_BYTES;
        if (useTint !== this._useTint) {
            this.destroyRenderData();
            this._useTint = useTint;
            this._flushAssembler();
            // The builtin fallback material follows the stride (TWO_COLORED).
            this.updateMaterial();
        }
        this._meshData = data;
        this._markForUpdateRenderData();
    }

    private _validateMeshData (data: UIMeshData): boolean {
        const vc = data.vertexCount;
        const ic = data.indexCount;
        if (data.vertexStride !== MESH_STRIDE_BYTES && data.vertexStride !== MESH_STRIDE_TINT_BYTES) {
            errorID(9010, data.vertexStride, MESH_STRIDE_BYTES, MESH_STRIDE_TINT_BYTES);
            return false;
        }
        if (vc < 0 || ic < 0) {
            errorID(9011, vc, ic);
            return false;
        }
        // Capacity limits come from the accessor that will serve the data.
        const accessor = this.ensureAccessor(data.vertexStride === MESH_STRIDE_TINT_BYTES);
        if (vc > accessor.maxVertexCount || ic > accessor.maxIndexCount) {
            errorID(9016, vc, ic, accessor.maxVertexCount, accessor.maxIndexCount);
            return false;
        }
        if (!data.vertexData || data.vertexData.byteLength < vc * data.vertexStride) {
            errorID(9012, data.vertexData ? data.vertexData.byteLength : 0, vc, data.vertexStride);
            return false;
        }
        if (!data.indexData || data.indexData.byteOffset % 2 !== 0 || data.indexData.byteLength < ic * 2) {
            errorID(9013, data.indexData ? data.indexData.byteLength : 0,
                data.indexData ? data.indexData.byteOffset : 0, ic, ic * 2);
            return false;
        }
        // Indices are mesh-local; anything >= vertexCount would sample vertices
        // of other chunks in the shared buffer (silent geometry corruption).
        const indices = new Uint16Array(data.indexData.buffer, data.indexData.byteOffset, ic);
        for (let i = 0; i < ic; ++i) {
            if (indices[i] >= vc) {
                errorID(9014, i, indices[i], vc);
                return false;
            }
        }
        for (let i = 0; i < data.segments.length; ++i) {
            const seg = data.segments[i];
            if (seg.indexOffset < 0 || seg.indexCount < 0 || seg.indexOffset + seg.indexCount > ic) {
                errorID(9015, i, seg.indexOffset, seg.indexOffset + seg.indexCount, ic);
                return false;
            }
        }
        return true;
    }

    /**
     * @en Whether to enable sprite batching.
     * @zh 是否启用合批。
     */
    @editable
    get enableBatch (): boolean { return this._enableBatch; }
    set enableBatch (value: boolean) {
        this._enableBatch = value;
        this._syncTransformMode();
        this.updateMaterial();
    }

    /**
     * @en Whether the input color data is premultiplied-alpha.
     * @zh 输入颜色数据是否为预乘 alpha 格式。
     */
    @editable
    get premultipliedAlpha (): boolean { return this._premultipliedAlpha; }
    set premultipliedAlpha (value: boolean) {
        this._premultipliedAlpha = value;
        this.updateMaterial();
        this._markForUpdateRenderData();
        this.onPremultipliedAlphaChanged();
    }

    /**
     * Notifies subclasses that the declared data format changed. The property
     * itself is owned here (single source of truth); data producers — e.g. a
     * spine plugin whose C++ side premultiplies vertex colors — override this
     * to forward the format to their baker instead of redeclaring the field.
     */
    protected onPremultipliedAlphaChanged (): void {}

    public onLoad (): void {
        super.onLoad();
        // Deserialization has applied _enableBatch by now; the derived
        // legacy-switch state may differ from the constructor default.
        this._syncTransformMode();
    }

    /**
     * Derives every legacy transform switch (vertices are always node-local).
     * Invariant: RenderEntity useLocal == "vertices are still node-local at
     * submit time". Batching bakes the world transform on the JS
     * side (_prepareBuffers), so by submit time that data is world-space and
     * the entity must report local = false — on native, middleware draws only
     * merge when !useLocal, so useLocal is simply !enableBatch: only a merged
     * batch carries world-baked vertices (baked by _prepareBuffers).
     */
    private _syncTransformMode (): void {
        this._renderEntity.setUseLocal(!this._enableBatch);
        this._markForUpdateRenderData();
    }

    protected _updateColor (): void {
        super._updateColor();
        // VERTEX-type data has no assembler color pass; the opacity multiply in
        // _prepareBuffers reads this._color, so a change must re-prepare.
        this._markForUpdateRenderData();
    }

    /**
     * JSB staleness poll. The native draw-info path re-runs _prepareBuffers
     * (which bakes the world transform and folds cascaded opacity into the
     * vertex bytes) only when this renderer is marked dirty — and neither node
     * transforms nor UIOpacity mark middleware renderers (TRANSFORM_CHANGED
     * fires only on the changed node, UIOpacity writes localOpacity with no
     * event). Poll the captured inputs and re-mark on drift. Web runs
     * _prepareBuffers unconditionally through fillBuffers, so skip there.
     * Subclasses overriding update should call super.update(dt).
     */
    public update (dt: number): void {
        if (!JSB || !this._renderData || !this._meshData) return;
        if (this._enableBatch) {
            const m = this.node.worldMatrix;
            if (m.m00 !== this._pollM00 || m.m01 !== this._pollM01 || m.m04 !== this._pollM04
                || m.m05 !== this._pollM05 || m.m12 !== this._pollM12 || m.m13 !== this._pollM13) {
                this._markForUpdateRenderData();
                return;
            }
        }
        if (this._computeCascadedOpacity() !== this._pollOpacity) {
            this._markForUpdateRenderData();
        }
    }

    protected _flushAssembler (): void {
        if (this._renderData === null) {
            const accessor = this.ensureAccessor(this._useTint);
            this._renderData = RenderData.add(this._useTint ? vfmtPosUvTwoColor4B : vfmtPosUvColor4B, accessor);
        }
    }

    public override updateRenderer (): void {
        super.updateRenderer();
        if (!JSB) return;
        if (this._renderFlag) {
            this._prepareNativeDrawInfos();
        } else {
            this._renderEntity.clearDynamicRenderDrawInfos();
        }
    }

    protected _render (batcher: any): void {
        const prepared = this._prepareBuffers();
        if (!prepared || !this._meshData) return;
        const { meshBuffer, startIndex } = prepared;
        const data = this._meshData;

        // Commit each segment with its texture + material. A segment without
        // its own material falls back to the component material (the builtin
        // spine effect, kept in step with the declared vertex space).
        for (const seg of data.segments) {
            const mat = seg.material || this.getRenderMaterial(0);
            if (seg.texture && mat) {
                batcher.commitMiddleware(this, meshBuffer, startIndex + seg.indexOffset, seg.indexCount,
                                         seg.texture, mat, this._enableBatch);
            }
        }
    }

    private _prepareBuffers (): { meshBuffer: MeshBuffer, startIndex: number } | null {
        if (!this._renderData || !this._meshData) return null;
        const data = this._meshData;
        const rd = this._renderData;
        const vc = data.vertexCount;
        const ic = data.indexCount;
        if (vc < 1 || ic < 1) return null;
        const vLength = vc * data.vertexStride;

        // Ensure the render data buffers are large enough. The reserved capacity
        // keeps ~10% head room but is clamped to the accessor's per-chunk caps:
        // allocateChunk rejects anything above them, so an unclamped reserve
        // would permanently fail data that actually fits (30000 vertices ->
        // 33000 requested > 32767). The actual per-frame counts are tracked on
        // the render data; the reserve lives in the chunk (vb bytes, indexCount).
        if (!rd.chunk || rd.chunk.vb.byteLength < vLength || rd.chunk.indexCount < ic) {
            rd.resize(
                Math.min(Math.ceil(vc * 1.1), rd.accessor.maxVertexCount),
                Math.min(Math.ceil(ic * 1.1), rd.accessor.maxIndexCount),
            );
            if (!rd.chunk) {
                errorID(9017, vc, ic, rd.accessor.maxVertexCount, rd.accessor.maxIndexCount);
                return null;
            }
            rd.updateSize(vc, ic);
        } else if (rd.vertexCount !== vc || rd.indexCount !== ic) {
            rd.updateSize(vc, ic);
        }
        if (!rd.chunk) return null;
        // Copy vertex data into the chunk's vertex view (a view of the shared
        // vData at the chunk's vertexOffset).
        const vbuf = rd.chunk.vb;
        const vU8 = new Uint8Array(vbuf.buffer, vbuf.byteOffset, vLength);
        vU8.set(data.vertexData.subarray(0, vLength));

        // Node-local vertices + batched mode: a merged batch carries no
        // per-draw matrix, so the node's world transform is baked into the
        // positions right here. Only the chunk copy is touched — the incoming
        // vertexData may be a view of memory shared with a worker.
        if (this._enableBatch) {
            this._bakeWorldTransform(vbuf, vLength, data.vertexStride);
        }

        // Cascaded opacity: VERTEX-type data gets no engine-side fade, UIMesh
        // applies it while copying (see the opacity contract in the header).
        const opacity = this._computeCascadedOpacity();
        if (opacity < 0.9999) {
            this._applyOpacity(vU8, vc, data.vertexStride, opacity);
        }

        // Capture the inputs consumed above for the JSB staleness poll (update).
        this._pollOpacity = opacity;
        if (this._enableBatch) {
            const m = this.node.worldMatrix;
            this._pollM00 = m.m00; this._pollM01 = m.m01; this._pollM04 = m.m04;
            this._pollM05 = m.m05; this._pollM12 = m.m12; this._pollM13 = m.m13;
        }

        // Offset the indices by the chunk's vertexOffset and append them into
        // the shared index buffer. appendIndices grows the buffer as needed and
        // advances meshBuffer.indexOffset; commitMiddleware reads meshBuffer.iData.
        const meshBuffer = rd.getMeshBuffer()!;
        // The native batcher resets its mesh-buffer offset through the shared
        // memory view after uploading. Synchronize the JS-side cached value
        // before appending this frame's indices.
        if (JSB) meshBuffer.indexOffset = meshBuffer.sharedBuffer[2];
        const startIndex = meshBuffer.indexOffset;
        const chunkOffset = rd.chunk.vertexOffset;
        const offsetIndices = new Uint16Array(ic);
        new Uint8Array(offsetIndices.buffer).set(data.indexData.subarray(0, ic * 2));
        for (let i = 0; i < ic; i++) offsetIndices[i] += chunkOffset;
        rd.chunk.vertexAccessor.appendIndices(rd.chunk.bufferId, offsetIndices);

        if (vc > 0 || ic > 0) rd.chunk.vertexAccessor.getMeshBuffer(rd.chunk.bufferId).setDirty();
        return { meshBuffer, startIndex };
    }

    /**
     * Bakes the node's world matrix into the chunk copy's positions (2D affine
     * of the world matrix, column-major: x' = m00*x + m04*y + m12). Skipped
     * when the matrix is the identity. Runs every frame so node movement is
     * picked up with no dirty tracking.
     */
    private _bakeWorldTransform (vbuf: Float32Array, byteLength: number, stride: number): void {
        const m = this.node.worldMatrix;
        const m00 = m.m00; const m01 = m.m01; const m04 = m.m04; const m05 = m.m05;
        const m12 = m.m12; const m13 = m.m13;
        if (m00 === 1 && m01 === 0 && m04 === 0 && m05 === 1 && m12 === 0 && m13 === 0) return;
        const floats = new Float32Array(vbuf.buffer, vbuf.byteOffset, byteLength >> 2);
        const strideF = stride >> 2;
        const vertexCount = byteLength / stride;
        for (let i = 0; i < vertexCount; i++) {
            const o = i * strideF;
            const x = floats[o];
            const y = floats[o + 1];
            floats[o] = m00 * x + m04 * y + m12;
            floats[o + 1] = m01 * x + m05 * y + m13;
        }
    }

    /**
     * Cascaded opacity as the batcher would compute it for COLOR-type data:
     * own color alpha x every ancestor's localOpacity (what UIOpacity writes).
     */
    private _computeCascadedOpacity (): number {
        let opacity = this._color.a / 255;
        for (let node: Node | null = this.node; node; node = node.parent) {
            opacity *= node._uiProps.localOpacity;
        }
        return opacity;
    }

    /**
     * Folds opacity into the copied vertices. Layout: pos*3f + uv*2f puts the
     * light color at bytes 20..23; two-color data carries dark at 24..27.
     * Straight data fades through alpha only (SRC_ALPHA blending scales the
     * whole source at blend time); premultiplied data scales light RGBA and
     * dark RGB (dark alpha is the PMA sentinel, not a fade channel) so the
     * blend result stays linear in opacity.
     */
    private _applyOpacity (vU8: Uint8Array, vc: number, stride: number, opacity: number): void {
        const pma = this._premultipliedAlpha;
        const darkRGB = (pma && stride === MESH_STRIDE_TINT_BYTES) ? 3 : 0;
        for (let i = 0; i < vc; i++) {
            const o = i * stride + 20;
            if (pma) {
                vU8[o]     = (vU8[o] * opacity + 0.5) | 0;
                vU8[o + 1] = (vU8[o + 1] * opacity + 0.5) | 0;
                vU8[o + 2] = (vU8[o + 2] * opacity + 0.5) | 0;
            }
            vU8[o + 3] = (vU8[o + 3] * opacity + 0.5) | 0;
            for (let j = 0; j < darkRGB; j++) {
                vU8[o + 4 + j] = (vU8[o + 4 + j] * opacity + 0.5) | 0;
            }
        }
    }

    private _prepareNativeDrawInfos (): void {
        this._renderEntity.clearDynamicRenderDrawInfos();
        const prepared = this._prepareBuffers();
        const data = this._meshData;
        const rd = this._renderData;
        if (!prepared || !data || !rd?.chunk) return;

        const { startIndex } = prepared;
        let drawIndex = 0;
        for (const seg of data.segments) {
            const mat = seg.material || this.getRenderMaterial(0);
            if (!seg.texture || !mat) continue;
            let drawInfo = this._drawInfoList[drawIndex];
            if (!drawInfo) {
                drawInfo = new RenderDrawInfo();
                drawInfo.setDrawInfoType(RenderDrawInfoType.MIDDLEWARE);
                this._drawInfoList[drawIndex] = drawInfo;
            }
            drawInfo.setAccAndBuffer(rd.accessor.id, rd.chunk.bufferId);
            drawInfo.setIndexOffset(startIndex + seg.indexOffset);
            drawInfo.setIBCount(seg.indexCount);
            drawInfo.setTexture(seg.texture.getGFXTexture());
            drawInfo.setSampler(seg.texture.getGFXSampler());
            drawInfo.setMaterial(mat);
            this._renderEntity.setDynamicRenderDrawInfo(drawInfo, drawIndex);
            drawIndex++;
        }
    }

    /**
     * The builtin material is the spine effect (default-spine-material): the
     * stock ui-sprite-material has no USE_LOCAL variant, so node-local input
     * through the component material would render stuck at the origin. The
     * spine effect carries both USE_LOCAL and TWO_COLORED macros; segment
     * materials supplied via setMeshData are the provider's own contract.
     */
    protected _updateBuiltinMaterial (): Material {
        return builtinResMgr.get<Material>('default-spine-material');
    }

    /**
     * Keeps the builtin material instance in step with the declared vertex
     * space / data format: USE_LOCAL for the GPU take-over mode, TWO_COLORED
     * for two-color data, and blend factors matching the alpha format.
     */
    public updateMaterial (): void {
        // Align the legacy blend-factor fields first so _updateBlendFunc
        // (inside super) never fights the explicit patching below.
        this._srcBlendFactor = this._premultipliedAlpha ? BlendFactor.ONE : BlendFactor.SRC_ALPHA;
        this._dstBlendFactor = BlendFactor.ONE_MINUS_SRC_ALPHA;
        super.updateMaterial();
        if (this._customMaterial) return;   // custom materials are the user's contract
        const inst = this.getMaterialInstance(0);
        if (!inst) return;
        inst.recompileShaders({
            USE_LOCAL: !this._enableBatch,
            TWO_COLORED: this._useTint,
        });
        // Straight data: src_alpha / 1-src_alpha (the effect default);
        // premultiplied data: ONE / 1-src_alpha, color and alpha channels.
        const src = this._premultipliedAlpha ? BlendFactor.ONE : BlendFactor.SRC_ALPHA;
        const pass = inst.passes[0];
        const target = pass.blendState.targets[0];
        target.blend = true;
        target.blendSrc = src;
        target.blendSrcAlpha = src;
        target.blendDst = BlendFactor.ONE_MINUS_SRC_ALPHA;
        target.blendDstAlpha = BlendFactor.ONE_MINUS_SRC_ALPHA;
        pass.blendState.setTarget(0, target);
        pass._updatePassHash();
    }

    protected createRenderEntity (): RenderEntity {
        const entity = new RenderEntity(RenderEntityType.DYNAMIC);
        // Vertices are always node-local: useLocal mirrors "not batched" and is
        // re-derived in onLoad/_syncTransformMode once deserialization has run.
        entity.setUseLocal(!this._enableBatch);
        return entity;
    }

    private ensureAccessor (useTint: boolean): StaticVBAccessor {
        const batcher = director.root!.batcher2D;
        // Invalidate the shared cache when the batcher changed: the previous
        // batcher destroyed its accessors together with itself (Root.destroy),
        // so a cached one would be dead and unregistered.
        if (_accessorBatcher !== batcher) {
            _accessorBatcher = batcher;
            _sharedAccessor = null;
            _sharedTintAccessor = null;
        }
        let accessor = useTint ? _sharedTintAccessor : _sharedAccessor;
        if (!accessor) {
            const device = director.root!.device;
            // Copy the format: the accessor empties its attributes array on
            // destroy, and the vfmt* constants are shared module-level state.
            const attributes = (useTint ? vfmtPosUvTwoColor4B : vfmtPosUvColor4B).slice();
            // 32767 matches the engine's spine middleware assembler (Simple.vCount,
            // cocos/spine/assembler/simple.ts): the established per-chunk cap for
            // middleware meshes, half the Uint16 index space.
            accessor = new StaticVBAccessor(device, attributes, 32767);
            // Registration makes the batcher upload/reset the accessor every
            // frame and destroy it together with itself.
            batcher.registerBufferAccessor(useTint ? UIMESH_TINT_ACCESSOR_KEY : UIMESH_ACCESSOR_KEY, accessor);
            if (useTint) {
                _sharedTintAccessor = accessor;
            } else {
                _sharedAccessor = accessor;
            }
        }
        return accessor;
    }
}
