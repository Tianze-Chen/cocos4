# 2D 光照调研报告

> 2026-10 · 基于分支 feat/plugin_support 的现状调研 + 业界方案分析
> 三路并行调研：① 本仓库 2D 渲染管线；② 本仓库光照/后处理设施；③ 业界方案（Unity URP 2D / Godot 4 / Box2DLights）

---

## 1. 结论速览

1. **架构选型：Unity 式「屏幕空间光照累积 RT」**——只维护一张（起步阶段）0.5x 分辨率的 RT，把每盏光的形状以 additive 混合画进去，sprite 在正常前向渲染时采样它合成最终颜色。既不用为每盏光单独开 FBO，也不用画完整的 G-buffer。
2. **本引擎的落地路径已经验证可行**：custom pipeline 的 render graph（`addRenderPass` + `addDraw2D`）是引擎级挂钩；`StencilManager` 证明了「遍历过程中插入额外 draw」这条路是通的；多 pass 加 additive 混合在 2D 全链路都已支持。
3. **L0~L2（环境光、点光、阴影）全程不需要动 2D 顶点格式**——光照 RT 的采样坐标可以在 shader 里由 position 算出，法线图走材质的第二个纹理槽。这样就避开了 `ecs-bindless-plan.md` §5 指出的「每种 assembler 都要改一遍」的结构性痛点。
4. **光照数据离 2D 很近**：主光、环境光的 uniform（`cc_mainLitDir/cc_mainLitColor/cc_ambientSky/Ground`）已经绑在 2D 绘制所在 pass 的 GLOBAL set 上，shader 里声明即可使用；逐点光走「把光当几何画进 RT」的路线，连逐光的 UBO 都不需要。
5. **阴影按平台分档实现**：基线用 CPU raycast + 顶点 alpha 三角扇（Box2DLights 模式，配合内置 2D 物理，几百行代码）；GPU 档用 Godot 式 shadow atlas 深度条带（R32F）；SDF（jump flooding）留作远期高级档。
6. **主要风险**：JSB 双端同步（native 的 Batcher2d.cpp / NativePipeline 镜像）、legacy 与 custom 两条 2D 消费路径、法线图与动态合图的配合、spine 的 PMA 约定。

---

## 2. 需求分层：法线贴图不是必须的

2D 光照效果分四层，法线只出现在最高层。**阴影（L2）与法线（L3）是两个正交的特性**——阴影来自「遮挡体挡住了光」，和表面朝向无关。

| 层级 | 效果 | 需要法线 | 需要的数据 | 参考游戏 |
|---|---|---|---|---|
| L0 环境光/全局色 | 昼夜变化、整体压暗再提亮 | ❌ | 一个颜色 | 几乎所有 |
| L1 无阴影局部光 | 火把照亮周围、径向衰减 | ❌ | 2D 位置 + 半径 + 颜色 | Terraria |
| L2 阴影 | 墙体挡光、投影 | ❌ | occluder 几何（多边形/SDF） | 饥荒、Mark of the Ninja |
| L3 表面浮雕 | 砖墙凹凸、金属高光 | ✅ | normal map + 假想光高 | Unity 2D demo、死亡细胞局部 |

**法线的「伪 3D」约定**（解答「光源没有 z 轴怎么算法线光照」）：把画面当成 z=0 的平面，相机永远在正上方俯视，光源悬停在一个假想高度 h 上：

```
n = normalTex * 2 - 1                // 平坦区域 (0,0,1)
L = normalize(vec3(lightPos.xy - pixelPos.xy, h))
diffuse = max(dot(n, L), 0)
spec:   view 恒为 (0,0,1),half = normalize(L + view)
```

- h 取固定常量，是 Unity（`Normal Map Distance` 可调）和 Godot（`Height` 可调）的共同做法
- h 小 → 掠射光，浮雕感夸张（日落侧光的效果）；h 大 → 接近顶光，浮雕平缓
- 法线图只与 L 的 xy/z 比例有关，所以整个系统只需要一个标量 h，不需要真实的 3D 坐标系

**L3 的美术制作成本**：每张 sprite 都要配套法线图（工具：Laigter 开源 / SpriteDlight / Sprite Lamp）；骨骼动画（spine）的法线如何跟随网格变形是业界长期没有解决的难题，务实的做法是**角色只接受点光和环境光，不参与法线光照**。做到 L2 已经能满足大多数 2D 游戏的氛围需求。

### 2.1 能力层级设计（定稿）

需求分层（上表）回答「游戏需要什么」；能力层级回答「引擎按什么组合交付」。三层分离：**原子能力**（约 10 个正交 feature flag）→ **需求层级 L0~L4**（官方预设组合，项目声明目标层级）→ **质量档**（运行时按设备选实现与预算，见 §6.2）。层级是预设不是牢笼：阶梯按累积设计（L2 ⊃ L1），但法线与阴影正交，留跳级口子（见决议 1）。

| 层级 | 定位 | 收编的特效（§7 命名） | 架构形态 | 对应 Phase |
|---|---|---|---|---|
| L0 静态氛围 | 一个 uniform，一张图都不画 | 环境光/全局色、昼夜循环、自发光、负光压暗、烘焙 lightmap（含静态阴影） | 无光照 RT；sprite 乘环境色 + 可选采一张 lightmap | P4 烘焙 |
| L1 动态光（无影） | 光会动，影没有 | 点光、锥光、方向光（无影）、freeform、贴图光、自定义衰减、过曝（RGBA8 档）、光源动画、受光层集合、Mask 通道受光、逐 sprite 受光系数、无影体积光、像素化光照 | 光照累积 RT（0.5x）+ 合成；阴影入口留空 | P1 |
| L2 阴影 | 光被挡住 | 硬阴影·raycast（基线）、硬阴影·GPU 挤出（可选）、软阴影·渐变条带、软阴影·RT 模糊、彩色阴影、自阴影开关、有影体积光、方向光阴影（限制支持） | 遮挡 pass 画进 RT + occluder 几何系统；实现可换（raycast/条带/SDF，语义不变） | P2 |
| L3 法线材质（与 L2 正交，可跳级） | 表面有起伏 | 法线浮雕 N·L、高光 specular、法线资产链（Laigter）、法线动态合图 | 灯表 UBO + sprite pass 前向计算，与阴影实现无关 | P3 |
| L4 高级/研究 | 中间图基础设施的红利 | SDF 软阴影（替换 L2 实现）、半透明阴影（SDF+ID）、2D GI、折射/描边、HDR 编码 | SDF 生成管线（jump flooding），WebGPU/原生先行 | P4 |

设计要点：**L0 ≠ 无阴影**——静态影子可烘进 lightmap，这是低端档的视觉底线；体积光拆两半（无影归 L1、带遮挡归 L2），它是参数不是层；**层级即发布切片**——L1~L4 与 Phase 1~4 对应，每层都是可交付的里程碑。API 侧 Light2D 面板参数按层分组（形状/阴影/法线响应），未达目标层级的参数灰显而非隐藏，项目升级层级时零摸索成本。

三条设计决议（已确认）：

1. **法线与阴影是独立开关**：L1+L3（无影法线）是合法组合——正交性是硬结论，阶梯只是预设；强绑定会逼项目为法线白付阴影的钱（美术还要给不存在的遮挡体摆多边形）。
2. **方向光阴影不承诺**：影子无限长，两套方案都难（Unity/Godot 的 2D 方向光同样无阴影）。L2 只承诺点/锥光阴影，方向光阴影标「限制支持」，这类需求用拉长锥光或烘焙顶替。
3. **L4 只对内存在**：SDF/GI 是研究级，不进对外特性表——公布即 SLA，不公布才保留换做法甚至砍掉的自由。可在高档质量档挂实验开关收集反馈，扎实后再升级为正式特性。

---

## 3. 业界三大方案拆解

### 3.1 Unity URP 2D Renderer（业界事实上的标准）

**光源类型**：`Freeform`（spline 多边形）、`Sprite`（任意贴图当光形状）、`Parametric`（已弃用）、`Spot`（双锥 + 双半径）、`Global`（每个 blend style × 每个 sorting layer 只允许一盏，当环境光用）。

通用参数：`Intensity`、`Overlap Operation`（Additive/Alpha Blend）、**`Target Sorting Layers`（光只影响选中的层——这是 2D 光照正确性的核心机制）**、`Blend Style`（4 个槽位）、`Light Order`、`Shadow Strength`、`Volumetric Intensity`（体积光）、`Normal Map Quality`（Disabled/Fast/Accurate，逐光开关）、`Normal Map Distance`（虚拟光源高度）。

**Blend Styles（4 个槽位）**：每个槽位 = `Mask Texture Channel` + `Render Texture Scale`（默认 0.5x，是引擎侧最重要的性能旋钮）+ `Blend Mode`。合成公式：

```
final.rgb = albedo.rgb * Modulate * lightRT.rgb + Additive * lightRT.rgb
// Multiplicative: (1,0)  Additive: (0,1)  Subtractive: (0,-1)  Custom: 任意
```

sprite shader 最多采样 4 张光照 RT（`_ShapeLight0..3_2D`）；用 Mask 通道就能做出「窗户只透光、水面只吃高光」这类逐像素的受光差异。

**阴影：Shadow Caster 2D** = CPU 侧用 Clipper 库把 caster 多边形膨胀成 shadow hull mesh，逐光画进该光的目标光照 RT（shader 顶点级挤出）；URP 17（2023.3+）改成了 shadow/unshadow 双材质 + RG/B 通道编码 + stencil 分组，并用 `_SoftShadowAngle`（上限 15°）做软阴影。`Composite Shadow Caster 2D` 负责合并轮廓，消除 tile 之间的内部阴影线。

**内部管线**：

```
Pre-phase: 连续且"光源集合相同"的 sorting layers 合并为一个 batch,共享同一套光照 RT
Phase 1: 逐 batch × 逐个在用的 blend style 一张 RT
   a. 阴影 pass(把 shadow hull 画进光贡献)
   b. 每盏光一个 draw,以 Additive/AlphaBlend 画形状进 RT
Phase 2: 从后往前画 sorting layers,sprite shader 采样 ≤4 张光照 RT 合成
```

关键事实：光并不是各占一张 RT，而是**每个在用的 blend style 一张屏幕空间累积 RT（最多 4 张），多盏光 additive 叠加进同一张**——这是「屏幕空间 light buffer」，不是「per-light RT」；光数据走 `ConstantBuffer.Light2DData`（SRP Batcher 友好）；开启法线后**每个 layer batch 需要一个全尺寸的法线预 pass**（官方文档原话 "very expensive"）。

### 3.2 Godot 4（与 Unity 相反：纯前向、无光照 RT）

- **节点**：`CanvasModulate`（环境色乘法；没有它场景默认全亮）、`PointLight2D`（纹理即光形状）、`DirectionalLight2D`、`LightOccluder2D + OccluderPolygon2D`（closed、cull mode、light mask）、`CanvasTexture`（Diffuse/Normal/Specular 三槽）。
- **前向多光**：canvas shader 内每个 draw item 最多 **15 盏 point 光**（位域 4bit），光数据放在 storage buffer 里（全局上限 256 盏）；ADD/SUB/MIX 混合逐光在 shader 内完成，**不打断合批**。
- **阴影 = 2D shadow map**：一张 R32F atlas（宽 2048，高 = 光数 × 2 的条带）；occlusion shader 顶点输出 `depth = dot(light_dir, vertex.xy)`（深度 = 顶点在光方向上的投影距离），positional 光选 4 个 90° 正交方向之一；采样时 `step()` 比较，PCF5/PCF13 做软阴影；`Shadow Color` 原生支持**彩色阴影**。
- **SDF（独立于阴影体系）**：开启 `SDF Collision` 的 occluder 先光栅化，再用 **jump flooding** 生成屏幕空间距离场；shader 内暴露 `screen_uv_to_sdf/texture_sdf` 等内建函数，供软阴影、2D GI、描边、折射使用；仅 Forward+/Mobile 渲染器可用（GLES3 不支持）。
- 法线：前向 N·L + Blinn-Phong，光向量 `normalize(mix(vec3(pos.xy,0), vec3(0,0,1), height))`；法线采样时要对 Y 翻转、合批旋转 90° 的情况做修正（**动态合批方案必须处理网格被转置的问题**）。

### 3.3 Box2DLights（CPU raycast 路线）

- occluder = Box2D fixture（物理体和光照遮挡体天然就是同一份几何，直接复用）；每盏光发 100~500 条射线 `world.rayCast`，用命中点构建 **triangle fan，顶点色 alpha 表示光在该方向能传播多远**，再以 additive 画入单张 **1/4 屏幕的 lightmap FBO**；一次可分离高斯模糊（Android 上 1/4 FBO 约 1ms）；合成时非光区域显示 ambient 色。
- 软阴影 = 命中点向外延伸的渐变条带（廉价的半影近似）。
- 性能开关：`culling`（默认开）、`staticLight`（准烘焙，省约 90% CPU）、`xray`（不投影，省约 70% CPU）、`ignoreAttachedBody`（角色自身不挡光）。

### 3.4 对比表

| 维度 | Unity URP 2D | Godot 4 | Box2DLights |
|---|---|---|---|
| 架构 | 光照累积 RT（≤4）+ 前向合成 | 纯前向多光（每对象 15 盏） | CPU raycast + 1/4 lightmap FBO |
| 光形状 | 参数化/sprite/freeform | 纹理 | 参数化（点/锥/平行/链） |
| 阴影 | CPU hull 挤出进 RT | R32F 深度条带 + PCF | 射线裁剪 + 顶点 alpha |
| 软阴影 | 挤出角度控制 | PCF5/13 + smooth | 渐变条带 |
| 彩色阴影 | ❌（只能变黑） | ✅ 原生 | ambient rgb 近似 |
| 法线 | ✅（要全尺寸预 pass） | ✅（前向，合批要处理转置） | ✅（扩展库 Gdx-Normal-Light） |
| 合批友好 | 不破坏批次，但 layer batching 决定 RT 数 | 完全不破坏 | 不影响 sprite 批 |
| 光数量 | 无硬上限（受 fill-rate 限制） | 每对象 15 盏、全局 256 盏 | 受 CPU 限制 |
| 成本中心 | fill-rate + RT 带宽 | shader ALU/寄存器 | 主线程 CPU |
| 移动端 | 0.5x RT 默认 | 可行 | 优（老设备首选） |

---

## 4. 通用技术路线对比

| 路线 | 原理 | 优点 | 缺点 | 适用 |
|---|---|---|---|---|
| a. additive 光 sprite | 光晕贴图直接叠加 | 零侵入、合批不变、几乎免费 | 穿墙、无参数化衰减、叠多过曝 | 氛围/特效光，或大系统里的低成本档 |
| b. 法线贴图光照 | N·L + 假想光高 h | 表现力最高 | 美术量产成本；变形网格的法线跟随；Unity 式法线预 pass 开销大 | 高价值局部，不建议全场景 |
| c. 几何阴影 | raycast/可视多边形/挤出 hull | 精确、可与物理同步、CPU 档对 GPU 零压力 | CPU 复杂度 O(光数×射线数×碰撞体数)；软阴影只是近似 | top-down 生存/地牢类首选 |
| d. SDF 阴影 | JFA 生成屏幕距离场 + raymarch | 物理感软阴影（半影随距离变化）、彩色阴影、同一张图还能服务 GI/体积光/描边 | 每帧约 9~10 个全屏 pass；WebGL2 起步；细节遮挡物会丢失 | PC/WebGPU/原生，不进 MVP |
| e. 全屏 light buffer / deferred | 光累积 RT（Unity 式）或完整 G-buffer（pixi-lights 式） | 光数量与 sprite 数量解耦、光形状任意、合成公式可自定义 | RT 带宽；透明物体/后处理的时序要专门设计 | 中大型项目的系统级方案 |
| f. 进阶特性 | 彩色阴影 = 遮罩×色；体积光 = 光体积 sprite/SDF raymarch；烘焙 = 静态光离屏渲染成 lightmap sprite | | | 移动端默认走烘焙 + 少量动态光 |

**性能注意点**（业界共识）：

- **fill-rate 是 2D 光照的第一大杀手**（这条是 RT 方案与「光晕直接叠加」路线的成本；前向多光方案不付这笔钱——灯不产生像素写入，对应成本变成每像素灯循环的 ALU）：每盏光 = 其覆盖区域整块像素的写入，N 盏重叠 = N 倍 fill。主要旋钮：光半径、RT scale（0.5x 默认，1/4 会有运动 shimmer；仅 RT 方案有此旋钮）、同屏阴影光数量（两套方案都适用：前向方案的阴影条带同样要往 atlas 里画遮挡体）。
- 合批：光照 RT 档不破坏 sprite 批次；前向多光档要保证每个对象的灯列表在 CPU 剔除阶段保持稳定，避免批次抖动。
- tilemap：逐 tile 挂 occluder 会组件爆炸，应该由 collider/地形数据生成**合并后的 hull**。
- spine：光照方案必须提供 lit 材质变体接口，并明确 PMA（预乘 alpha）语义；角色的法线光照务实跳过。
- 像素风：光照按 viewport 分辨率计算；想要「像素化的光」需要对采样坐标做 grid snap，或者降低内部渲染分辨率。
- WebGL：光照 RT 用 RGBA8 起步（additive 累积够用，注意 clamp 过曝）；R32F 阴影条带需要 `EXT_color_buffer_float`；SDF 的 JFA 用 fragment ping-pong 替代 compute；WebGPU/原生没有这些限制。

---

## 5. 本引擎现状

### 5.0 现有 GPU 对象清单（代码盘点）

一帧 2D 渲染的对象流：

```
CPU 侧（每帧）
  Batcher2D.walk()            遍历节点树，顶点写进 MeshBuffer 的 CPU 数组
  autoMergeBatches()          合批 → DrawBatch2D 列表（纯数据，持引用不持 GPU 资源）
  uploadBuffers()             脏块整段 update 到 GPU VB/IB
  DescriptorSetCache.update() 回收死节点、刷新 local UBO
GPU 录制侧
  render graph 编译            DevicePass 持 RenderPass/Framebuffer，beginPass 绑全局 UBO
  _recordUI → recordCommand   绑 PSO → 材质 DS → local DS → IA → draw
  present 后 reset()          IA 池回收、StencilManager 复位
```

| 对象 | 现状与作用 |
|---|---|
| 顶点/索引 Buffer | 共享 chunk 池（`static-vb-accessor.ts`）：144KB/块 = 4096 顶点，溢出新开块不 resize；块内 draw 共享一个 VB/IB（`mesh-buffer.ts:418-454`）；**索引恒为 Uint16，65536 顶点硬上限**；默认顶点格式 36B（pos3f+uv2f+color4f，`vertex-format.ts:64-68`） |
| UBO | 合批路径**每 draw 无模型 UBO**（世界矩阵 CPU 烘进顶点，`assembler/sprite/simple.ts:68-96`）；全局 UBO `CCGlobal`/`CCCamera`（set 0 binding 0/1）每 pass 绑一次（`executor.ts:957-965`）；仅不合批的 spine/UIMesh 走 224B per-draw local UBO（`batcher-2d.ts:1086-1189`）；**全 2D 无 dynamic offset** |
| DescriptorSet | `DescriptorSetCache`（`batcher-2d.ts:1192-1286`）按 textureHash^samplerHash 跨帧缓存；合批形态只绑采样槽（binding 12）；纹理销毁时显式释放 |
| Texture/Sampler | sprite 图集/spine 贴图/BMFont 页；**动态合图 ≤5 张 2048² RGBA8**（场景启动 reset，`dynamic-atlas/atlas-manager.ts`）；label 为 CPU canvas 画完上传（`text-processing.ts:554-595`，不经 render pass）；采样器设备级缓存；RT 采样有 UV 翻转 define（`SAMPLE_FROM_RT`） |
| PSO/Shader | Pass 克隆时把 stencil DSS 混进 hash（`pass.ts:838-871`）→ `PipelineStateManager` 全局缓存（2D/3D 共用）；builtin-sprite 无光照钩子 |
| InputAssembler | 池化复用非每 draw 创建（`mesh-buffer.ts:327-351`）；每帧 reset 回池 |
| RenderPass/Framebuffer | custom：由 render graph raster 声明（主相机 = swapchain 附件，离屏 = 资源图管理的 RT）；legacy：UI 画在 3D 主 pass 尾部共用 framebuffer（`ui-phase.ts:45-76`） |
| Stencil（蒙版） | 非独立 GPU 对象：DSS 图形状态（`stencil-manager.ts:230-287`）+ 一次全屏清屏 draw（`batcher-2d.ts:1002-1032`） |

**2D 路径确认不存在**（grep 级验证）：SSBO、compute、indirect buffer、GPU query、32 位索引、instancing、per-draw dynamic-offset UBO、多 pass RT 效果、深度纹理。

**对光照的意义**：新增 GPU 对象仅三样——光照 RT 的 raster pass、灯表全局 UBO（走 CCGlobal 先例）、动态合图内的法线通道；受光层过滤有现成字段（DrawBatch2D.visFlags）。与任何现状不冲突。前置条件：工作区在途的三个 WebGPU 修复（copyTexImagesToTexture 立即执行、writeTexture 256 对齐、空实例 set 不占 local layout）恰好都打在这条上传/绑定路径上，宜先稳定。

### 5.1 2D 渲染链路（要点）

```
RenderRoot2D/Canvas → Batcher2D.walk(节点树, 级联透明度)
  → UIRenderer.fillBuffers → assembler 写共享大 buffer(StaticVBAccessor)
  → commitComp/commitModel/commitMiddleware 三条提交路径
  → DrawBatch2D(纹理、IA 区间、passes)→ scene.addBatch → RenderScene._batches
消费端(二选一):
  legacy:  UIPhase.render(cocos/rendering/ui-phase.ts, forward/deferred stage 末尾)
  custom:  executor.ts _recordUI(BlitType.DRAW_2D, 默认路径)
```

- 内置 effect：`editor/assets/effects/for2d/builtin-sprite.effect`（92 行，没有任何光照钩子，片元 = 纹理×顶点色 + alpha test）
- **默认走 custom pipeline**（`Root._usesCustomPipeline` 默认 true）；两条消费路径目前都在维护
- 多 pass / additive 混合：材质 pass 全链支持（pass 的 phase 必须是 `default`）
- 现成先例：**StencilManager**（遍历中按需插入额外 draw + 改渲染状态）、**UIMesh**（不动引擎、向 2D 管线注入自定义网格/材质段）
- 动态合图：散图自动合入 2048 图集保批（会影响「按纹理分桶」类设计）

### 5.2 光照数据离 2D 的距离

| 数据 | 距离 |
|---|---|
| 主光方向/颜色、环境光、主光阴影图 | **零距离**：已绑在 2D 绘制 pass 的 GLOBAL/per-pass set 上，声明即用 |
| 逐点光（位置/颜色/范围） | 一层 LOCAL set 之隔；但走「把光当几何画进 RT」的路线可完全绕开 |
| CPU 侧收集（`RenderScene.*Lights`）与打包（`SetLightUBO`） | 可以直接照抄 |
| 后处理设施（render graph/passContext/BasePass 链/BlitScreen） | 高度可复用，不区分 2D/3D 内容 |
| 聚簇光照（compute+SSBO） | 仅 native deferred，不可复用 |

### 5.3 挂钩点（按侵入度排序）

- **A. 纯资产层（零改动）**：从 builtin-sprite 派生 lit 变体 + `Sprite.customMaterial`；法线图走材质 uniform sampler。局限：参数跟着材质走、每个材质实例断批。适合原型验证。
- **B. 屏幕后处理式**：Canvas `targetTexture` → RT → 全屏合成（`SAMPLE_FROM_RT` 已有）；或在 custom pipeline 加 `PipelinePassBuilder` + `ppl.addRenderPass` + `addDraw2D(camera)`（`custom/pipeline.ts:540`）把 2D 画进任意 RT。**这是引擎级方案的主挂钩**。
- **C. 组件/遍历层**：仿照 StencilManager，在 `Batcher2D.walk` 里识别光组件、插入光照几何 draw；光源几何复用 UIMesh/commitModel；全局光数据挂 RenderScene（仿照 3D 光收集）。
- **D. 顶点格式层（高侵入，尽量避免）**：改 vertex-format + 全部 assembler + JSB 同步——`ecs-bindless-plan.md` §5 已把它定性为结构性痛点；**本方案 L0~L3 均不需要走这一层**。

### 5.4 风险清单

1. **JSB 双端**：所有 TS 侧遍历/合批改动都要同步 `native/cocos/2d/renderer/Batcher2d.cpp`；pipeline 层改动要同步 `NativePipeline/NativeExecutor` 镜像。
2. **legacy/custom 双消费路径**：ui-phase.ts 与 executor.ts 都要适配；或者 MVP 明确 custom-only（引擎默认已经是 custom）。
3. 动态合图 / USE_SORTING_2D 会改变纹理归属与绘制顺序，影响按纹理分桶类的设计。
4. spine（DragonBones）的 commitMiddleware 路径需要 lit 材质变体与 PMA 约定。
5. 光照分层：对应 Unity 的 Target Sorting Layers，Cocos 侧可以映射到已有的 layer/visibility 机制（`camera.visibility & batch.visFlags`）。

---

## 6. 推荐方案：分阶段路线

**主架构**（Unity 方案的简化版）：一张 0.5x RGBA8 光照累积 RT，光形状以 additive 画入，sprite 前向渲染时采样合成；受光层过滤是必须实现的核心能力；多张 RT（等价 blend style）留作扩展。

```
Phase 0  原型验证(不改引擎,1~2 周)
  - 从 builtin-sprite 派生 lit effect + customMaterial 试点
  - additive 光 sprite,验证 L1 视觉与 fill-rate
  - 产出:效果标杆 + 性能基线(移动端真机)

Phase 1  引擎级 L0+L1(核心,custom pipeline)
  - Light2D 组件(point/spot/global)→ RenderScene 新增 2D 光收集(仿 _sphereLights)
  - render graph:新增"光照 RT pass"(逐光把光形状 additive 画进 RT;阴影在 Phase 2 插到光形状之前)
  - 2D 场景本身正常前向绘制,sprite lit effect 采样光照 RT 合成(vs 里由 position 算屏幕 UV)
  - 受光 layer 过滤(复用 visFlags)
  - RT scale、光数上限等可调参数;global 光 = 全屏单色乘法项
  - 改动面:rendering/custom/(新 pass builder)、for2d lit effect、(可选)batcher 对 RT 的 descriptor
  - 明确 custom-only,legacy 不支持(文档写明)

Phase 2  L2 阴影(CPU 基线)
  - occluder 多边形(编辑器生成 + collider 派生,tilemap 走合并 hull)
  - 内置 2D 物理 raycast → triangle fan 顶点 alpha(Box2DLights 模式,约几百行)
  - 光照 RT 里:先画阴影遮挡,再画光形状
  - 直接照搬 Box2DLights 的开关:staticLight(准烘焙)/ xray(不投影)

Phase 3  L3 法线(可选层)
  - SpriteFrame 挂 normalMap(资产层);lit effect 加 N·L 项(前向、Godot 式,避开 Unity 的全尺寸法线预 pass)
  - 小 UBO 灯表(cc_light2DPos[8] 之类)供方向计算;per-light quality/distance
  - 法线图纳入动态合图(随主图合入,否则每张图断批)
  - Laigter 作为推荐工具链写进文档

Phase 4  高级档(按需)
  - GPU 阴影:Godot 式 R32F 深度条带(WebGL2 检测 float RT)
  - SDF(jump flooding):WebGPU/原生 compute 先行;同一张 SDF 同时做软阴影/彩色阴影/体积光
  - 烘焙:静态光离屏渲染成 lightmap sprite;移动端默认档 = 烘焙 + 2~3 盏动态点光
```

每个 Phase 都要过一遍双端同步的检查：TS 侧落地后，评估 native 镜像（Batcher2d.cpp / NativePipeline）是同步还是暂缓（Phase 1 主要是 pipeline 层，native custom pipeline 需要同步；若 native 走 legacy 路径，可先降级为「不支持光照」）。

### 6.1 终局架构（长远答案）

分阶段只是节奏，终局形态从第一天起就按下面设计——每个 Phase 的产出都是终局组件，没有弃子：

```
数据层   Light2D 组件（point/spot/freeform/sprite/global）
         一等参数：受光层集合、static/dynamic、质量档、形状资源（网格或贴图）
         收集走 RenderScene 2D 光列表（数据化，与 ECS render 方向平移兼容）
计算层   ① 光照累积 RT（0.5x RGBA8，可调）   ← 骨架，Unity 侧
         ② 灯表 UBO（≤16 盏）              ← 配件，Godot 侧
         ③ 阴影分档：raycast → 深度条带 → SDF（按质量档递进）
         ④ 烘焙管线：静态光 → lightmap tile（性能兜底）
合成层   唯一的 sprite lit effect：
         亮度/阴影 ← RT；法线/高光 ← 灯表；mask/自发光/顶点色本地合成
```

为什么这是终局：其一，业界趋同——Unity 证明了 RT 的效果上限，Godot 证明了前向的轻量可行，Unity 社区做 SDF/体积光时实际也落回 RT 形态，混合架构是两家实验结论的并集；其二，两根骨架接得住所有未来——§7 的 31 项特效归宿非「图」即「参数」，中间图骨架接住一切图类新效果（折射、描边、GI），灯表骨架接住一切参数类新效果（新光照模型），未来新特效必落两类之一；其三，一套代码全平台覆盖（见下表）；其四，与引擎演进城对齐——render graph 现成、不动 Batcher 遍历、不动顶点格式，光列表数据化可平移进 ECS。

### 6.2 质量分级（同一架构的旋钮，不是三套实现）

| 档位 | 平台 | 可跑层级 | 关键预算 |
|---|---|---|---|
| Low | 小游戏/低端机 | L0 完整；L1 降级；L2 仅烘焙静态影 + ≤1 盏动态影光 | RT 1/4 或免 RT、动态光 ≤4、灯表 ≤4 |
| Mid | 主流移动/web | L0~L2 完整；L3 可选 | RT 0.5x、raycast 128 射线、影光 ≤8、灯表 ≤8 |
| High | PC/原生/WebGPU | L0~L3 完整；L4 按需（内部） | RT 0.5~1x、SDF/条带可换、灯表 ≤16 |

降级三规则（质量档在层内怎么降）：

1. **语义不变原则**：降级降的是「实现与预算」，不是「正确性」——阴影可以变糙甚至消失（配置声明过），但不能错位、不能该暗不暗。
2. **降级链预先定义**：阴影 SDF→raycast→渐变条带→无影；RT 1x→0.5x→0.25x→纯烘焙；法线→关（回退 L2 视觉）。每一环都是配置，不是改代码。
3. **声明优先级**：项目声明目标层级 → 运行时质量档自动选实现 → 用户显式 override 优先级最高。

### 6.3 设计纪律（早期定死，避免后期返工）

1. **受光层集合是灯的一等参数**（Unity 的血泪教训，分层需求来了不动架构）
2. **static/dynamic 标记第一天就有**——烘焙依赖它，后补要遍历全场景
3. **光形状抽象成「网格或贴图」资源**，别写死参数化类型（freeform/贴图光才有归宿）
4. **质量档做成引擎级枚举**，不是一堆 per-feature 开关的组合爆炸
5. **灯表 UBO 布局在 Phase 3 前冻结**（字段、上限 N、std140 铺平方式）
6. **永不碰顶点格式**——L0~L3 已验证不需要；任何触碰 assembler/vertex-format 的提案一律打回（除非 ECS 路线统一接管）

---

## 7. 全特效实现对照（RT 方案 vs 前向方案）

> 难度指「在该方案内从零实现」的工程量（低/中/高）；「胜者」标注更顺手的一侧。运行时成本只列主要开销。
> 反复出现的规律：**凡「结果能画成一张图」的效果，RT 顺手；凡「需要灯的方向/参数逐像素参与计算」的效果，前向顺手。**

### 7.1 光源形状类

| 特效 | RT 方案怎么做 | 前向方案怎么做 | 难度 | 运行时成本 |
|---|---|---|---|---|
| 点光（径向衰减） | 单位圆网格＋衰减 shader，additive 画进 RT | 灯表字段，循环算 `1 - d/r` | 双低，RT 略直观 | RT：光的覆盖 fill；前向：每像素 ALU |
| 锥光/聚光 | 扇形网格＋内外角 smoothstep（Unity 双锥双半径） | 灯表加方向/锥角字段，dot 判定 | 双低 | 同上 |
| 平行光（方向光） | 全屏方向渐变或并入环境项 | 一个方向 uniform，无衰减，原生 | 双低；**但两边阴影都难**（影子无限长） | 极低 |
| 全局光/环境光 | RT 清屏色即环境光 | ambient uniform 进灯表 | 双极低 | 极低 |
| 自由形状光（freeform） | 任意多边形网格直接画，天然支持 | 参数表达不了，需把形状烘成贴图当衰减查找表 | **RT 胜**（前向每像素多一次采样） | RT：形状面积 fill；前向：+1 次采样 |
| 贴图光（sprite 灯、霓虹招牌） | 直接 additive 画 sprite | 灯贴图当衰减 LUT 采样 | **RT 胜** | 同上 |

### 7.2 衰减与混合类

| 特效 | RT 方案怎么做 | 前向方案怎么做 | 难度 | 运行时成本 |
|---|---|---|---|---|
| 自定义衰减曲线 | shader 公式或 1D LUT 纹理 | 同左 | 平手，双低 | 可忽略 |
| 过曝提亮（亮过原色） | additive 项；RGBA8 会 clamp，超 1 需 HDR 编码 | 数学天然无 clamp | **前向小胜** | RT 需编码；前向无额外 |
| 压暗/负光（subtractive） | blend 负系数（乘法/减法混合） | 光强取负值即可 | 前向小胜 | 均低 |
| Mask 通道受光（窗户只透光、水面高光） | 合成时 × mask（sprite 第二纹理通道） | 完全相同，合成点就在 sprite shader | 平手，双低 | 每像素 +1 次采样 |
| 自发光（不受光区域） | 合成公式的加法项 | 同左 | 平手，双低 | 可忽略 |

### 7.3 阴影类（细分为九档）

| 特效 | RT 方案怎么做 | 前向方案怎么做 | 难度 | 运行时成本 |
|---|---|---|---|---|
| 无阴影（光穿墙） | 直接画光 | 直接算 | 双零成本 | — |
| 硬阴影·CPU raycast 几何 | 射线求交 → 三角扇（顶点 alpha＝传播距离）画进 RT；配物理 raycast | 阴影几何必须先烘成中间图再给 sprite 采样——**实际又引入了 RT** | **RT 胜**（前向做＝架构外挂） | CPU O(光×射线×遮挡体)；GPU 极低 |
| 硬阴影·GPU 挤出 hull | caster 轮廓沿远离光方向挤出、减法画进 RT（Unity 式）；轮廓要 Clipper 合并 | 同左，同样需要中间图 | RT 胜 | 轮廓生成 CPU 低频；挤出 GPU 便宜 |
| 硬阴影·深度条带（shadow atlas） | 可接入：画光时采样该光的条带 | Godot 原生形态（occlusion shader＋step 比较） | 双高 | 每盏带影光一次条带渲染（R32F） |
| 软阴影·渐变条带 | 命中点向外延伸顶点渐变（Box2DLights） | 依赖几何方案，同左 | RT 胜 | 近似免费（顶点色） |
| 软阴影·后处理模糊 | 对光照 RT 一次可分离高斯（1/4 分辨率约 1ms） | 没有中间图可模糊，不可行 | **RT 独有** | 一次 1/4 全屏模糊 |
| 软阴影·SDF raymarch | 光 pass 内向灯 march（低分辨率摊销、结果全层共享） | 每 sprite 像素 × 每灯 march，ALU 爆炸 | **RT 完胜**（前向不建议做） | SDF 生成每帧约 10 pass＋march |
| 自阴影（self shadow） | 遮挡列表含自身轮廓，易出 artifact，需开关 | 同左依赖 | 平手（机制随所属阴影档） | 随所属档 |
| 彩色阴影 | 阴影区域画带色减光，或合成时 mix（shadow_color） | 需先有阴影采样再 mix | RT 顺手 | 低 |
| 半透明阴影（玻璃透光） | 几何路线：遮挡体标透射色，raycast 命中累积；或 SDF＋ID 伴生图 | 同左依赖 | 双高（业界无内建先例） | 中 |

### 7.4 表面响应类

| 特效 | RT 方案怎么做 | 前向方案怎么做 | 难度 | 运行时成本 |
|---|---|---|---|---|
| 法线浮雕（N·L） | 补小灯表，法线计算仍在 sprite pass；或法线预 pass（全尺寸 RT＋sprite 画两遍，贵） | 灯表原生，N·L 顺手（Godot 式） | **前向胜**（省一份灯表的维护） | 每像素每灯一次 N·L |
| 高光（specular） | 同法线（view 恒为 (0,0,1)，half 向量） | 同法线 | 随法线 | 每像素每灯几次 ALU |
| 逐 sprite 光强/受光系数 | 合成时乘 sprite 顶点色/实例参数 | 同左 | 平手 | 可忽略 |

### 7.5 全局与高级类

| 特效 | RT 方案怎么做 | 前向方案怎么做 | 难度 | 运行时成本 |
|---|---|---|---|---|
| 体积光/光束 | 光体积当发光 sprite 画进 RT＋阴影遮挡体积（Unity Volumetric 模式）；SDF raymarch 更高级 | 无中间结构，靠粒子＋贴图模拟，效果打折 | **RT 胜** | 光体积区域的 fill |
| 2D GI（光反弹） | SDF 上多 bounce raymarch（2DGI 路线）；有中间图基础设施 | 理论可行，ALU 不可行 | 双很高（研究级）；RT 相对可行 | 高 |
| 烘焙静态光 | 静态灯＋静态遮挡离屏渲一次 → lightmap tile，运行时零成本 | 烘焙结果仍要以纹理交给 sprite 采样——等于引入 RT 式合成 | **RT 胜** | 运行时 ≈ 0 |
| 昼夜循环 | 环境/全局光参数动画 | 同左 | 平手，双极低 | 可忽略 |
| 光源动画（闪烁/呼吸/拖尾） | 改 uniform/网格参数 | 改灯表字段 | 平手，双极低 | 可忽略 |
| 像素化光照 | 光照 RT 降内部分辨率＋采样 grid snap | 对光照计算输入（世界坐标）snap | 平手，双低 | 更省（低分辨率） |

### 7.6 判读汇总

- **RT 原生优势区**：任意光形状（freeform/贴图）、全部阴影九档中的七档、体积光、烘焙——凡「结果本身是一张图」的效果
- **前向原生优势区**：法线/高光（灯方向数据在）、无 clamp 的过曝、半透明 sprite 语义天然正确、分层受光免费（正交维度）
- **双方等价区**：点/锥/环境光、衰减曲线、mask、自发光、各类参数动画——选架构时这些不构成理由
- **全特性目标下的结论**：RT 骨架＋小灯表的混合架构（法线走 sprite pass 灯表、其余走 RT），与 §6 Phase 3/4 的设计一致

---

## 8. 参考资料

**官方文档/源码**
- Unity URP 2D 光照文档：https://docs.unity3d.com/Packages/com.unity.render-pipelines.universal@14.0/manual/Lights-2D-intro.html
- URP 2D 运行时源码：https://github.com/Unity-Technologies/Graphics/tree/master/Packages/com.unity.render-pipelines.universal/Runtime/2D
- Unity 免费电子书 Introduction to 2D Lighting：https://resources.unity.com/unity-engine-guide/2d-lighting-ebook
- Godot 2D lights and shadows：https://docs.godotengine.org/en/stable/tutorials/2d/2d_lights_and_shadows.html
- Godot canvas 渲染源码（canvas.glsl / canvas_occlusion.glsl）：https://github.com/godotengine/godot
- Box2DLights 源码：https://github.com/libgdx/box2dlights

**深度文章**
- Catlike Coding: Custom SRP 2D Lights and Shadows：https://catlikecoding.com/unity/tutorials/custom-srp/2d-lights-and-shadows/
- Roystan: 2D Lighting in URP：https://roystan.net/articles/2d-lighting-urp-part-1/
- Red Blob Games: 2D Visibility（可视多边形算法圣经）：https://www.redblobgames.com/articles/visibility/
- Inigo Quilez: 2D distance functions：https://iquilezles.org/articles/distfunctions2d/
- Samuel Bigos: 2DGI（Godot SDF 全局光照）：https://samuelbigos.github.io/posts/2dgi1-2d-global-illumination-in-godot.html
- GodotShaders: Dynamic 2D Lights and Soft Shadows：https://godotshaders.com/shader/dynamic-2d-lights-and-soft-shadows/
- pixi-lights（WebGL 2D deferred）：https://github.com/pixijs/pixi-lights
- StarCube Labs: Baking 2D Lighting：https://www.starcubelabs.com/baking-2d-lighting/

**工具**
- Laigter（开源法线生成）：https://github.com/azagaya/laigter
- box2d-lights web 版可交互 demo：https://lusito.github.io/box2d-lights/
