import { UIMesh, UIMeshData } from '../../cocos/2d/components/ui-mesh';
import { UITransform } from '../../cocos/2d';
import { Node } from '../../cocos/scene-graph/node';
import { Scene, director } from '../../exports/base';
import { Batcher2D } from '../../cocos/2d/renderer/batcher-2d';
import { vfmtPosUvColor4B, vfmtPosUvTwoColor4B } from '../../cocos/2d/renderer/vertex-format';
import { captureErrorIDs } from '../utils/log-capture';

// Mirrors sprite.test.ts: a headless batcher so UIMesh can create its shared
// StaticVBAccessor and allocate chunks from it.
// @ts-expect-error
director.root!._batcher = new Batcher2D(director.root!);
const scene = new Scene('uimesh-test');
director.runSceneImmediate(scene);

const ACCESSOR_VERTEX_COUNT = 32767;

function createUIMesh (): { mesh: UIMesh, anyMesh: any } {
    const node = new Node('mesh');
    node.addComponent(UITransform);
    scene.addChild(node);
    const mesh = node.addComponent(UIMesh);
    return { mesh, anyMesh: mesh as any };
}

function makeMeshData (vc: number, stride = 24): UIMeshData {
    const quadCount = Math.floor(vc / 4);
    const ic = quadCount * 6;
    const vertexData = new Uint8Array(vc * stride);
    const indices = new Uint16Array(ic);
    for (let q = 0; q < quadCount; ++q) {
        const v = q * 4;
        const o = q * 6;
        indices[o] = v; indices[o + 1] = v + 1; indices[o + 2] = v + 2;
        indices[o + 3] = v + 2; indices[o + 4] = v + 1; indices[o + 5] = v + 3;
    }
    return {
        vertexCount: vc,
        vertexStride: stride,
        vertexData,
        indexCount: ic,
        indexData: new Uint8Array(indices.buffer),
        segments: [{ indexOffset: 0, indexCount: ic, texture: null, material: null }],
    };
}

describe('UIMesh: accessor capacity', () => {
    test('30000 vertices render — the 10% reserve is clamped to the accessor cap', () => {
        const { mesh, anyMesh } = createUIMesh();
        const data = makeMeshData(30000); // fits, but ceil(30000 * 1.1) > 32767
        mesh.setMeshData(data);
        expect(anyMesh._meshData).toBe(data);
        expect(anyMesh._prepareBuffers()).not.toBeNull();
        const rd = anyMesh._renderData;
        // Actual counts are tracked; the reserve lives in the chunk.
        expect(rd.vertexCount).toBe(30000);
        expect(rd.indexCount).toBe(data.indexCount);
        expect(rd.chunk).toBeTruthy();
        expect(rd.chunk.vb.byteLength).toBe(ACCESSOR_VERTEX_COUNT * 24);
    });

    test('32767 vertices (exact accessor cap) render', () => {
        const { mesh, anyMesh } = createUIMesh();
        mesh.setMeshData(makeMeshData(32767));
        expect(anyMesh._prepareBuffers()).not.toBeNull();
        const rd = anyMesh._renderData;
        expect(rd.vertexCount).toBe(32767);
        expect(rd.chunk.vb.byteLength).toBe(ACCESSOR_VERTEX_COUNT * 24);
    });

    test('data beyond the accessor cap is rejected with an error', () => {
        const { mesh, anyMesh } = createUIMesh();
        const watcher = captureErrorIDs();
        mesh.setMeshData(makeMeshData(32768));
        expect(watcher.captured).toHaveLength(1);
        expect(watcher.captured[0]).toEqual([9016, 32768, 49152, 32767, 131068]);
        watcher.clear();
        expect(anyMesh._meshData).toBeNull(); // rejected frame stores nothing
    });

    test('growth within the reserve does not reallocate the chunk', () => {
        const { mesh, anyMesh } = createUIMesh();
        mesh.setMeshData(makeMeshData(100));
        expect(anyMesh._prepareBuffers()).not.toBeNull();
        const chunk = anyMesh._renderData.chunk;
        mesh.setMeshData(makeMeshData(105)); // within the ~10% head room
        expect(anyMesh._prepareBuffers()).not.toBeNull();
        expect(anyMesh._renderData.chunk).toBe(chunk);
        expect(anyMesh._renderData.vertexCount).toBe(105);
    });
});

describe('UIMesh: setMeshData boundary validation', () => {
    let mesh: UIMesh;
    let anyMesh: any;
    let watcher: ReturnType<typeof captureErrorIDs>;

    beforeEach(() => {
        ({ mesh, anyMesh } = createUIMesh());
        watcher = captureErrorIDs();
    });

    // The watcher must be empty by test end (log-capture afterEach enforces it):
    // every test asserts its single errorID call and clears it. Entries are the
    // raw errorID arguments — [id, ...params]; the texts live in DebugInfos.json.
    afterEach(() => {
        watcher.clear();
    });

    test('rejects unsupported vertex stride', () => {
        mesh.setMeshData(makeMeshData(8, 32));
        expect(watcher.captured).toHaveLength(1);
        expect(watcher.captured[0]).toEqual([9010, 32, 24, 28]);
        expect(anyMesh._meshData).toBeNull();
    });

    test('rejects vertexData shorter than vertexCount * stride', () => {
        const data = makeMeshData(8);
        data.vertexData = data.vertexData.slice(0, data.vertexData.byteLength - 1);
        mesh.setMeshData(data);
        expect(watcher.captured).toHaveLength(1);
        expect(watcher.captured[0]).toEqual([9012, 191, 8, 24]);
        expect(anyMesh._meshData).toBeNull();
    });

    test('rejects indexData shorter than indexCount * 2', () => {
        const data = makeMeshData(8);
        data.indexData = data.indexData.slice(0, data.indexData.byteLength - 2);
        mesh.setMeshData(data);
        expect(watcher.captured).toHaveLength(1);
        expect(watcher.captured[0]).toEqual([9013, 22, 0, 12, 24]);
        expect(anyMesh._meshData).toBeNull();
    });

    test('rejects indices out of vertex range', () => {
        const data = makeMeshData(8);
        const indices = new Uint16Array(data.indexData.buffer, data.indexData.byteOffset, data.indexCount);
        indices[0] = data.vertexCount; // one past the last vertex
        mesh.setMeshData(data);
        expect(watcher.captured).toHaveLength(1);
        expect(watcher.captured[0]).toEqual([9014, 0, 8, 8]);
        expect(anyMesh._meshData).toBeNull();
    });

    test('rejects segment ranges beyond indexCount', () => {
        const data = makeMeshData(8);
        data.segments = [{ indexOffset: 0, indexCount: data.indexCount + 1, texture: null, material: null }];
        mesh.setMeshData(data);
        expect(watcher.captured).toHaveLength(1);
        expect(watcher.captured[0]).toEqual([9015, 0, 0, 13, 12]);
        expect(anyMesh._meshData).toBeNull();
    });

    test('a rejected frame keeps the last accepted mesh', () => {
        const good = makeMeshData(8);
        mesh.setMeshData(good);
        mesh.setMeshData(makeMeshData(32768)); // over cap, rejected
        expect(watcher.captured).toHaveLength(1);
        expect(watcher.captured[0]).toEqual([9016, 32768, 49152, 32767, 131068]);
        expect(anyMesh._meshData).toBe(good);
    });
});

describe('UIMesh: accessor lifetime follows the batcher', () => {
    test('a rebuilt root/batcher never reuses a destroyed accessor (single- and two-color)', () => {
        const UIMESH_KEY = Number.parseInt('UIMESH', 36);
        const UIMESH_TINT_KEY = Number.parseInt('UIMESHTINT', 36);

        // First root: a UIMesh creates its accessors and registers them with
        // the current batcher.
        const first = createUIMesh();
        first.mesh.setMeshData(makeMeshData(8));
        expect(first.anyMesh._prepareBuffers()).not.toBeNull();
        const oldAccessor = first.anyMesh._renderData.accessor;
        const oldMap: Map<number, any> = (director.root!.batcher2D as any)._bufferAccessors;
        expect(oldMap.get(UIMESH_KEY)).toBe(oldAccessor); // registered with its batcher

        // Root.destroy(): the batcher destroys every accessor it owns, is
        // dropped, and a rebuilt root creates a fresh batcher with an empty map
        // — all within the same JS context.
        const root: any = director.root!;
        const oldBatcher: Batcher2D = root.batcher2D;
        oldBatcher.destroy();
        expect(oldMap.size).toBe(0); // accessors released with the batcher
        expect((oldAccessor as any)._buffers.length).toBe(0); // buffers gone
        root._batcher = new Batcher2D(root);

        // UIMesh components under the new root must resolve fresh accessors
        // from the new batcher. A batcher-keyed cache that forgot to invalidate
        // would hand back the destroyed accessor and skip registration,
        // breaking upload/reset.
        const second = createUIMesh();
        second.mesh.setMeshData(makeMeshData(8));
        expect(second.anyMesh._prepareBuffers()).not.toBeNull();
        const newAccessor = second.anyMesh._renderData.accessor;
        expect(newAccessor).not.toBe(oldAccessor);
        expect((newAccessor as any)._buffers.length).toBeGreaterThan(0);

        const newMap: Map<number, any> = (director.root!.batcher2D as any)._bufferAccessors;
        expect(newMap.get(UIMESH_KEY)).toBe(newAccessor); // registered with the new batcher

        // Two-color branch: same guarantee for the tint accessor.
        const tinted = createUIMesh();
        tinted.mesh.setMeshData(makeMeshData(8, 28));
        expect(tinted.anyMesh._prepareBuffers()).not.toBeNull();
        const newTintAccessor = tinted.anyMesh._renderData.accessor;
        expect(newTintAccessor).not.toBe(oldAccessor);
        expect(newMap.get(UIMESH_TINT_KEY)).toBe(newTintAccessor);

        // The accessors hold copies of the vertex formats: destroying them with
        // the old batcher must not empty the shared module-level constants.
        expect(vfmtPosUvColor4B).toHaveLength(3);
        expect(vfmtPosUvTwoColor4B).toHaveLength(4);
    });
});
