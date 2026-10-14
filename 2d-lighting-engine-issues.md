# 2D 光照 Phase 0 引擎问题记录

> 2026-10-09 · 在 `feat/2d-lighting` 分支的 Phase 0 原型验证（测试项目 `~/Documents/projects/2d-light`，Creator 3.8.8 + 本引擎，WebGL2 / custom pipeline）过程中确认。
> 每个问题附：证据链（文件:行号 + 实测数据）、触发条件、影响面、真实性结论、修复建议。

---

## 问题 1：动态合图对 MemImageSource 走错 GL 重载（确认是真 bug）

### 现象

预览页瞬间刷出上千条异常并黑屏（实测 18 秒内 1480 条）：

```
TypeError: Failed to execute 'texSubImage2D' on 'WebGL2RenderingContext': Overload resolution failed.
    at WebGL2CmdFuncCopyTexImagesToTexture (webgl2-commands.ts:2690)
    at WebGL2Device.copyTexImagesToTexture
    at DynamicAtlasTexture.drawTextureAt        (cocos/2d/utils/dynamic-atlas/atlas.ts:276)
    at drawTextureAt / Atlas.insertSpriteFrame
    at DynamicAtlasManager.insertSpriteFrame / packToDynamicAtlas
    at Simple.updateRenderData → Sprite.updateRenderer → UIRendererManager.updateAllDirtyRenderers
```

### 因果链（每环均已代码/实测验证）

1. **数据源是纯 JS 对象**。内置纹理全部用 `IMemoryImageSource` 创建，例如
   `cocos/asset/asset-manager/builtin-res-mgr.ts:150`：
   ```ts
   const whiteMemImageSource: ImageSource = {
       width: 2, height: 2,
       _data: whiteValueView,        // Uint8Array（RGBA 像素）
       _compressed: false, format: PixelFormat.RGBA8888,
   };
   ```

2. **`ImageAsset.data` 对 mem source 返回的是 Uint8Array**。`cocos/asset/assets/image-asset.ts:572`：
   ```ts
   get data () {
       if (isNativeImage(this._nativeData)) return this._nativeData; // DOM/ImageBitmap 走这
       return this._nativeData && this._nativeData._data;             // mem source → Uint8Array
   }
   ```

3. **调用点用类型断言掩盖了真实类型**。`cocos/2d/utils/dynamic-atlas/atlas.ts:276`：
   ```ts
   gfxDevice.copyTexImagesToTexture([image.data as HTMLCanvasElement], gfxTexture, [region]);
   //                                       ^^^^^^^^^^^^^^^^^^^^^^^ 实际传入的是 Uint8Array
   ```

4. **GL 层走了只收 DOM 元素的重载**。`cocos/gfx/webgl2/webgl2-commands.ts:2690`：
   ```ts
   gl.texSubImage2D(target, level, x, y, glFormat, glType, texImages[n]);  // 7 参重载
   ```
   WebIDL 规定 7 参重载的第 7 参必须是 `TexImageSource`
   （`HTMLImageElement | HTMLCanvasElement | ImageBitmap | ImageData | OffscreenCanvas | HTMLVideoElement | VideoFrame`）。
   `Uint8Array` 不在其中 → 重载决议失败 → `TypeError`。
   （`Uint8Array` 本可走 9 参重载 `texSubImage2D(target, level, x, y, w, h, format, type, ArrayBufferView)`，但此处只传了 7 个参数。）

5. **爆炸半径**：异常从 `updateRenderData` 一路抛穿当帧 Batcher2D walk → 渲染中断 → 黑屏；
   且 pack 永不成功（`spriteFrame.original` 未置位）→ 每帧每个 sprite 重试 → 错误刷屏。

### 触发条件（前两条均为默认值，即默认配置即可触发）

| # | 条件 | 默认状态 |
|---|---|---|
| 1 | 动态合图开启 | `macro.CLEANUP_IMAGE_CACHE` 默认 `false`（core/platform/macro.ts:1132）→ `DynamicAtlasManager.init()` → `enabled = true`（atlas-manager.ts:170） |
| 2 | sprite 纹理来自 mem-source ImageAsset | 全部内置纹理（white/black/grey/normal-texture）以及运行时 `new ImageAsset({width, height, _data})` / `SpriteFrame.createWithImage(memImage)`（程序化纹理的标准做法） |
| 3 | sampler 为 LINEAR 且 `frame.packable` | 均为默认 |

**典型中招场景**：「用内置白色纹理画色块」（UI 开发极常见）、「readPixels/程序生成像素后建 sprite」。

### 真实性结论

**真实存在，已实测复现**。堆栈逐级吻合；`as HTMLCanvasElement` 断言在编译期掩盖了类型不匹配。

### 修复建议（A + C，B 可选加固）

```ts
// A. atlas.ts drawTextureAt —— 按数据形态分流（首选，语义最正确）
const src = image.data;
if (src instanceof ArrayBufferView) {
    // 像素数据走 buffers 路径；region 的 texOffset/texExtent 已构造好，正是为此设计
    gfxDevice.copyBuffersToTexture([src as Uint8Array], gfxTexture, [region]);
} else {
    gfxDevice.copyTexImagesToTexture([src as TexImageSource], gfxTexture, [region]);
}

// C. packToDynamicAtlas / insertSpriteFrame 前置守卫：非 native image 直接不合图
//    （2×2 白图合图本就零收益；可复用/导出 image-asset.ts 的 isNativeImage 判定）

// B.（加固）WebGL2CmdFuncCopyTexImagesToTexture 运行时检测非 TexImageSource 项，
//    兜底转 9 参 buffer 重载（防御未来其它调用点）
```

**另需审查**：WebGPU 后端同样透传 `texImages`（`cocos/gfx/webgpu/webgpu-device.ts:797` → `WebGPUCmdFuncCopyTexImagesToTexture`），mem source 在该路径的行为需单独验证/修复。

---

## 问题 2：GL 侧 UBO 绑定失败静默跳过（真实的可诊断性缺口）

### 位置

`cocos/gfx/webgl2/webgl2-commands.ts:2259-2291`（draw 时 UBO 绑定循环）：

```ts
for (let j = 0; j < blockLen; j++) {
    const glBlock = gpuShader.glBlocks[j];
    const gpuDescriptorSet = gpuDescriptorSets[glBlock.set];
    const descriptorIndex = gpuDescriptorSet && gpuDescriptorSet.descriptorIndices[glBlock.binding];
    const gpuDescriptor = descriptorIndex >= 0 && gpuDescriptorSet.gpuDescriptors[descriptorIndex];
    if (!gpuDescriptor || !gpuDescriptor.gpuBuffer) {
        // error(`Buffer binding '${glBlock.name}' at set ${glBlock.set} binding ${glBlock.binding} is not bounded`);
        continue;   // ← 静默跳过：该 block 在 shader 中读零，无任何日志
    }
    ...
}
```

同款被注释的诊断还有两处：`webgl2-commands.ts:184364`（legacy uniform 同步路径）、`184544`（sampler 绑定）。

### 触发条件与后果

- 触发：shader 反射出的 uniform block 在当前绑定 DS 的布局中查不到 binding
  （`descriptorIndices[binding]` 为 undefined）。典型场景：材质 DS 布局与 shader 宏变体反射不一致、
  自定义 UBO 声明进错 set、布局缓存过期。
- 后果：该 uniform 在 shader 中**读零**，画面表现为「材质默认值 / 全黑」，引擎零输出。

### 真实性结论（需要诚实区分两层）

- ✅ **缺口真实存在**：失败路径存在、诊断被注释、无替代输出。
- ❌ **但它不是本次 Phase 0 黑屏的元凶**：插桩实测 `Phase0Lights` / `GlowParams` 全部命中绑定
  （HIT）、零 MISS。本次黑屏根因是测试脚本把 sprite 尺寸设成了 2×2。
- 实际危害是**排障成本**：引擎在该层零输出，导致无法信任任何中间结论，只能给编译产物
  打补丁逆向验证——本次排障耗时被放大了数倍。

### 修复建议（已在预览缓存包上原型验证，零噪音）

```ts
if (!gpuDescriptor || !gpuDescriptor.gpuBuffer) {
    if (DEBUG) {
        const key = `${glBlock.name}:${glBlock.set}:${glBlock.binding}`;
        if (!reportedMissingBindings.has(key)) {      // 模块级 Set<string>
            reportedMissingBindings.add(key);
            error(`[gfx] UBO '${key}' not bound at draw; shader will read zeros`);
        }
    }
    continue;
}
```

DEBUG 门控 + 每个 `name:set:binding` 只报一次：既不像无条件 `error` 那样在合法可选绑定场景刷屏，
又把最阴险的「静默零 uniform」变成一条明确定位的报错。三处被注释的诊断（UBO ×2、sampler ×1）
可同法处理。

---

## 附录：过程中确认的 API 陷阱（非 bug，但值得在文档/类型层面加强）

1. **`Sprite.spriteFrame` 赋值会重置 contentSize**：sizeMode 为默认 TRIMMED 时，赋 frame 会把
   UITransform 重置为 frame 尺寸。`sizeMode = CUSTOM` 必须在赋 frame **之后**、
   `setContentSize` **之前**。本次黑屏的直接根因（sprite 全变 2×2）。
2. **`Material.setProperty` 的语义是一次性设置**：文档明确 per-frame 更新应走
   `Pass.setUniform(pass.getHandle(name), value)`。本次实测两条路径均能到达 shader；
   但 `setProperty` 在 2D 路径逐帧调用失败时无任何提示（与问题 2 同类的静默问题）。
3. **cocos4 运行时已是 custom-pipeline-only**：`legacy-pipeline` 模块设置为摆设
   （编辑器 UI 无此选项，改了也不生效，实测重启后仍跑 WebPipeline）；
   `enableEffectImport` 硬编码 `true`（`cocos/rendering/custom/index.ts:49`）。
   调研报告中「legacy 与 custom 两条消费路径都在维护」的表述需要修正为
   「legacy 代码存在但运行时不可达」。

---

## 2026-10-14 · 编辑器 ↔ v4 引擎编译器不匹配（阻塞自定义引擎）

**现象**：编辑器 3.8.8 重启后预览退回 builtin 引擎；`engine.json` profile 的
`javascript.builtin` 被写回 `true`。日志链：`compile-custom-engine-with-caching-success` →
`[Assets] preload engine failed!` → 兜底 builtin。

**根因**：编辑器内置的 compile-custom-engine 重编 `bin/.cache` 时生成的
`import-map.json` 用 `q-bundled:///fs/pal/system-info` 作键，而引擎 bundle 内部模块
（如 `cocos/gfx/webgl2/webgl2-device.js`）依赖的是**裸 `pal/system-info`**——builtin
引擎（官方 CI 构建）的 import-map 有裸键别名。asset-db worker 的 SystemJS 因此
Error#8，preload 失败。`cc.config.json` 的 `moduleOverrides/isVirtualModule` 段两侧
schema 一致（builtin 指向 .ts、v4 指向 .js，结构相同），差异在编辑器编译器如何
产出别名——怀疑 v4 引擎的导出图/ccbuild 与 3.8.8 编辑器编译器（app.asar 内
`builtin/engine/static/engine-compiler`）版本不匹配。

**复现**：全清 `bin/.cache` 后启动编辑器 → 必现。手工给 import-map 补裸 pal 键有效，
但编辑器每次启动都会重编并覆盖（"compile-custom-engine-with-caching" 每次跑 ~5s）。

**连带**（builtin 引擎上）：见 phase1-plan「环境事故记录」——RenderTexture passInfo
覆写、packer CJS 坏块（fix-preview-chunks.mjs 临时桥）、动态图集 texSubImage2D
Overload 失败。

**修复方向**：①v4 引擎仓跟进构建侧（生成裸别名或对齐 ccbuild 版本）②或升级编辑器
到与 v4 工具链匹配的版本 ③短期：builtin + plugin 适配（已做）。
