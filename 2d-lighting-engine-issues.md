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

**2026-10-14 15:45 更新：已恢复，自定义引擎重新可用。** 全清重编（前一日 14:53）+
保留缓存的状态下，编辑器以 builtin=false 启动后 `compile-custom-engine-with-caching
(8.2s)` → `Load engine in …/cocos4`，**preload 成功、不再回退**（本 boot 未再出现 pal
解析错误；根因链条仍如上，疑似与缓存增量状态相关，未完全定性）。保险措施：
项目根 `fix-engine-pal-aliases.mjs` watcher（启动编辑器前后台常驻，任何 map 再生成
200ms 内补回裸别名；map 正常时零操作）。恢复后验证全绿：RT RGBA16F + 浮点读回
（ambient 0.282/0.306 正确）、e2e 独立对拍 **12/10720（0.1%，与 10-13 基线一致）**、
shadow/spot/normal 三场景参数与渲染正常、引擎仓 package.json 未再被覆写。

**2026-10-16 深挖：quick-compiler buildImportMap 丢弃 pal 虚拟模块别名（根因定位到编辑器代码行）。**
`app.asar/node_modules/@editor/quick-compiler/dist/index.js` 的 `buildImportMap()`：
```js
for (const [k, v] of Object.entries(moduleOverrides)) {
    const targetUid = encodeFilePath(v, rootDir);      // ① v 是引擎相对路径(pal/x/web/x.js)非绝对路径 → null → continue 丢弃
    const targetModuleId = bundler.getModuleId?.(targetUid);  // ② 即便解析出 uid，concat bundler 索引不含虚拟模块 → undefined → continue
    let sourceModuleId = k;
    const sourceUid = encodeFilePath(k, rootDir);      // ③ 裸说明符 'pal/x' 被当相对路径 → getModuleId('pal/x') → '' → continue
    if (!sourceModuleId) continue;
    importMap.imports[sourceModuleId] = targetModuleId;
}
```
builtin 引擎的 map 由官方 CI 的引擎自建工具链产出（不走这段），因此只有 custom engine 命中。
**已做的外科手术**（未保留，编辑器已恢复原装）：`/tmp/asar-patch.mjs`（单文件替换
app.asar，per-file SHA256 重算、Electron fuses 的 asar 完整性校验确认为 Disabled）+
`/tmp/qc/index-patched.js`（三处 fallback：target 相对路径 join rootDir 解析、target
q-bundled id 直推、source 裸说明符透传）。补丁确认被加载执行（marker log 出现），
但 map 里裸键仍未出现——推断 `_setupModuleOverrides` 对 EDITOR target 根本没吐出 pal
覆盖（HTML5 test 门控或 features 过滤），需要引擎侧确认 moduleOverrides 的来源与
条件。**结论：这是编辑器 3.8.8 quick-compiler 与 v4 引擎 cc.config 虚拟模块体系的不
兼容，正确的修法在 v4 引擎构建侧（让 StatsQuery/_setupModuleOverrides 输出 pal
覆盖）或升级编辑器；短期内 builtin + RGBA8 回退可继续开发（RT 法线优雅降级为直通）。**

**2026-10-16 最终确认 + 勘误（用户复核触发）。**
1. **勘误 10-14 的"已恢复"结论**：那次单次成功（preload 通过、自定义引擎加载）是
   **不可复现的侥幸状态**——此后 5+ 次全清重建与热缓存启动均确定性失败（同一
   pal Error#8）。把它上报为"已恢复"是错误结论，已致用户预期偏差。
2. **确定性结论**：编辑器 3.8.8 + v4 引擎，自定义引擎 **100% 无法通过 asset-db
   preload**（quick-compiler 三处丢弃点，见上节）。builtin 引擎一切正常。
   当前编辑器安装已验证恢复原装（app.asar 与原版字节一致、无残留文件）。
3. 修复归属：**v4 引擎构建侧**（让 StatsQuery/_setupModuleOverrides 对 EDITOR
   target 输出 pal 虚拟模块覆盖——为什么官方 CI 工具链能产出而 quick-compiler
   不能，需要引擎侧同事判断）或升级编辑器版本。插件/项目侧无待办。

**2026-10-16 补充：用户经验驱动的复测，实证模型（重要修正）。**
按用户经验执行"删 bin/.cache → 重启触发重编"，连续 3 次启动观察：
1. **全量重编（删缓存后第 1 次启动，97s）的产物 map 确实带裸 pal 键**（正确形态）——
   用户经验对应的行为真实存在；我此前"编译器从不产键"的结论是**检查时机过早**
   （map 在编译末尾落盘，我在 +100s 读到的还是旧值/中间态）。
2. 但**同一次启动的 asset-db preload 早于 map 落盘运行** → 必然失败并翻转 builtin。
3. **后续缓存启动（~5s）会把 map 重写成无键形态** → 再次失败。即使启动时 map
   带键（第 2 次启动实测），preload 依然 Error#8（时序或中间态覆盖）。
4. 推论：自定义引擎只在"全量重编后的窗口"可用（这解释了 10-14 与 10-16 上午的
   两次成功 boot）；稳定复用的路径被 cached-build 的 map 重写 + preload 竞态挡死。

**给引擎侧的两个精确问题**：①quick-compiler 的 full build 与 cached build 对
import-map 中 pal 虚拟模块别名的生成为何不一致（full 有 / cached 无）？
②asset-db worker 的 preload 能否推迟到 buildImportMap 落盘之后（或失败重试）？
任一修复即可让自定义引擎在 3.8.8 下稳定。项目/插件侧无待办。

**2026-10-16 构建验证的结果：被同一根因阻塞，并新增第三个引擎侧数据点。**
1. CLI 构建（`--build "platform=web-mobile"`）在 Init bundle 后立刻失败：
   builder 的 `load-script.ccc` **直接复用 `temp/programming/packer-driver/targets/editor/chunks/`**
   的 chunk 执行——与 preview 同一批产物，坏块同样炸 builder（`exports is not defined`）。
2. 排除"增量状态污染"假设：备份删除 temp/programming 后在稳定 builtin 下全量重生成，
   20 个 chunk 仍是坏的 CJS-in-System 形态。**builtin 引擎路径对此项目确定性产出坏块**
   （正常 3.8.8 项目不这样——本项目把引擎在 custom/builtin 间反复切换过的历史配置可能
   影响了 packer 的 transform 配置来源，待查 `temp/programming/packer-driver/VERSION`
   的 config 归属）。
3. preview 的 `fix-preview-chunks.mjs` 补丁**不可移植到 builder**（补丁用
   `/scripting/x/` 绝对 URL 做 deps，builder 的 `pack:///` 体系解析不了）。
4. **结论**：构建验证与 preview、自定义引擎 preload 共享同一组根因，全部指向
   quick-compiler/packer 在 custom↔builtin 切换后的行为。引擎侧修好（issues 文档
   两个问题 + 本条）后，构建验证应随 chunk 恢复正确形态而自然解锁。项目/插件侧
   无可推进项。

**2026-10-19 补充：方向光开发期间新增的引擎侧证据与勘误。**

## 新证据

1. **编译/资产 watcher 会在一次启动内随时死亡，且无自愈**（三次实测：10-16 两次、
   10-19 一次）。死亡后 .ts 改动不再编译、.scene 改动不再重导入（touch/改写文件均
   无效），唯一恢复手段是重启编辑器。建议引擎侧给 packer-driver 与 asset-db 的
   watcher 加存活检测/自动重启。
2. **手工修补过的 chunk 可跨编辑器重启存活**：`temp/programming/.../preview/chunks`
   下 10-16 手工补丁的 chunk（HAND-PATCHED 标记、含绝对 URL deps）在重启后仍被
   preview 服务引用，与重编产物混用。建议重启时清理非本次构建产物（或校验哈希）。
3. **预览 chunk 的 import 接线在特定时序下产出 undefined 符号**：demo chunk 从
   `db://cc-2d-light/index` 导入的类（含编辑器刚导入的新组件类）曾被解析为
   undefined，导致组件 start() 抛 "Type must be non-nil"。干净重启后自愈，但
   复现路径未定（与 1/2 可能同源）。
4. **动态图集对运行时构造 SpriteFrame 的兼容问题**（builtin 3.8.8 实测）：
   `new SpriteFrame()` + 裸 Texture2D（无 ImageAsset）的精灵进
   `DynamicAtlasManager.packToDynamicAtlas` 后，`copyTexImagesToTexture` 对该
   frame 的图像数据执行 `texSubImage2D` 抛 Overload 错误且**每帧重试**（~120 条/s
   控制台风暴 + 预览错误面板）。插件侧以 `frame.packable = false` 规避；引擎侧
   可考虑对无 ImageAsset 的 frame 跳过动态图集。
5. **误删 packer targets 目录的连带影响**：删除
   `temp/programming/packer-driver/targets/preview`（含 import-map.json）后，
   编辑器日志持续 ENOENT，packer 不会按页面请求自动重建该目录，需重启触发
   全量重编。（这是我操作失误，非引擎 bug，但"目录被外部清理后无恢复路径"
   值得引擎侧考虑。）

## 勘误（10-16 记录的修正）

- **"光照 RT 全灭/屏幕暗"是误诊**：当时结论"渲染管线坏了"实为探针的世界→UV
  映射漏了相机偏移（Canvas 布局下相机在画布中心而非世界原点）+ 报错弹窗遮挡
  画面中心两点叠加。光照管线本身自始至终正常。教训已入记忆。
- MRT 双附件方案在本项目撤销（2D batcher 的 shader 注入不支持多渲染目标输出，
  自定义 effect 声明双输出会使材质整体失效）——引擎若开放 2D MRT 需要同步改
  batcher 的 shader 后处理；项目侧已改用单附件 A 通道方案，无引擎侧待办。
