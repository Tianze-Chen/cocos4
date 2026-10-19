# 2D 光照实施计划（Phase 0 收尾 → Phase 1）

> 2026-10-12 · 基于调研报告（`2d-lighting-research.md`）与 Phase 0 实战结论（`2d-lighting-engine-issues.md`）的执行计划。
> 分支：`feat/2d-lighting`；测试项目：`~/Documents/projects/2d-light`（Creator 3.8.8 + 本引擎源码）。

---

## 当前状态

**Phase 0（原型验证）已完成**，交付：

- 效果标杆：石砖棋盘地面 + 3 盏动态光（指针跟随暖光 / 环绕冷光 / 闪烁篝火）+ 40s 昼夜循环，
  编辑器全节点化场景（165 对象）+ 4 个材质 + 2 个自定义 effect
- 技术验证结论（调研文档 Phase 1 假设全部成立）：
  - 合批路径下 `a_position` 即世界坐标 → **光照不需动顶点格式**（`vWorldPos = pos.xy` 一行截获）
  - 自定义 UBO（材质 set 1）+ `Pass.setUniform` 每帧更新全链路可用
  - 48 sprite 单纹理单材质 = 1 批次；additive 光晕 fill-rate 是唯一显著开销（Phase 1 RT 的优化目标）
- 验证方式：GL 级帧内 readPixels（headless 合成层有冻结假象，不可作为验收依据——见 engine-issues 文档附录）

**待办尾巴**：真机 GPU 人眼验收（30 秒刷新预览确认）。

---

## 第 1 步：引擎修复（Phase 1 地基，~半天）

> **状态（2026-10-12）**：代码已落地，`tsc --noEmit` 与 ESLint 通过；待测试项目预览回归（删 workaround 后无报错、画面不变）后关闭。

两个问题已在 `2d-lighting-engine-issues.md` 完整定位，此处只列执行项：

| # | 修复 | 位置 | 改动量 |
|---|---|---|---|
| 1 | 动态合图 MemImageSource 崩溃 | `cocos/2d/utils/dynamic-atlas/atlas.ts:276` 按 `instanceof ArrayBufferView` 分流到 `copyBuffersToTexture`；`packToDynamicAtlas` 加非 native image 前置守卫 | ~20 行 |
| 2 | GL 侧 UBO 绑定失败静默跳过 | `cocos/gfx/webgl2/webgl2-commands.ts` 三处被注释的 error（2266/184364/184544）→ DEBUG 门控 + 每 `name:set:binding` 去重一次 | ~10 行 |

回归标准：测试项目删除 `dynamicAtlasManager.enabled = false` workaround 后预览无报错、画面不变；
WebGPU 后端的 `copyTexImagesToTexture` 透传路径（`webgpu-device.ts:797`）一并审查。

---

## 第 2 步：Phase 1 最小切片——Light2D 组件化（1~2 周）

> **状态（2026-10-13）：✅ 验收通过**（编辑器+预览画面与 Phase 0 一致，headless 数据链路全绿）。
> 插件包形态（cocos-creator-plugin skill 配方）：
>
> 插件位于测试项目 `~/Documents/projects/2d-light/extensions/cc-2d-light/`，可整体拷贝给任意工程：
> - `package.json`：`contributions.asset-db.mount` 把 `runtime/` 只读挂载为工程脚本（照 cocos-spine-runtime 实测配方）
> - `runtime/`：`light-2d.ts`（组件，onEnable 直接向 manager 注册）+ `light-2d-manager.ts`（System，优先级
>   `SCHEDULER + 1`：组件 update 之后、batcher 上传 UBO 之前）+ `index.ts` 统一入口
> - `effects/sprite-lit.effect`：冻结灯表 effect 的参考副本（用户复制进工程使用）
> - 工程脚本经 `db://cc-2d-light` 导入；**装/更新插件后须重启编辑器**（挂载在启动期生效）
> - 引擎仓已回退到只含两个 bug 修复的提交（`287a54b09d`）；灯表 UBO 冻结布局不变
>
> 耦合触发点（**碰到时单独讨论**）：
>
> | 触发点 | 现状 | 需要引擎耦合时 |
> |---|---|---|
> | 光照 RT pass（第 3 步） | 未开始 | render graph 插 pass：管线定制 API vs 引擎 hook，届时评估 |
> | 材质自动发现 | 显式 `registerMaterial` | `DrawBatch2D.fillPasses` 一行钩子可全自动化 |
> | gizmo / Inspector 面板 | 无（Inspector 原生属性可用） | 插件的 `contributions.scene` / `inspector`（编辑器侧，非引擎耦合） |
> | native/JSB | 纯 JS，native 可跑但无 Batcher2d.cpp 镜像 | 上游化时同步 |
> | 相机剔除 | `cc.Camera` 组件近似（正交、忽略旋转） | 内部 render camera 精确矩形 |
> | 灯表数据化挂 RenderScene（ECS 对齐） | 放弃（自管注册表） | 上游化时恢复数据对象分层 |


### 落地踩坑记录（2026-10-13，全部实测）

| 坑 | 症状 | 规避 |
|---|---|---|
| **`CC` 前缀的 uniform block** | effect 编译器把 CC 开头的 block 当引擎全局块放 **set 0**（与 CCGlobal 同列），材质属性报 EFX3302、manager 写材质侧缓冲永远到不了 GPU | 自定义 block 禁用 CC/cc 前缀（本插件定名 `Lights2D`） |
| **一文件一 Component** | 项目脚本一个文件注册多个 @ccclass Component 直接报错，模块加载失败被包装成"db 未挂载" | 组件拆文件（引擎内部代码不受此限） |
| **effect 数组长度须字面量** | `light2DPosRadius[MAX]` 用 #define 报 EFX2202 | block 内数组长度写死 `[16]` |
| **ES 1.00 循环边界须常量** | `for (i < count)`（count 来自 uniform）报 EFX2406 | 常量上界 + `if (i < count)` 守卫 |
| **裸 `db://pkg` 说明符** | packer 编译期解析失败，静默生成"错误占位 chunk"并跨会话复用 | 导入必须带子路径 `db://cc-2d-light/index` |
| **touch effect → 依赖材质重导 → `importer: "*"` 竞态** | 材质 meta 被兜底导入器改写（ver 掉回 1.0.0），library 产物成 cc.Asset 空壳，材质永远不水合（画面缺材质内容） | **每次改 effect 后检查依赖材质的 .meta**；损坏则恢复 importer=material/ver=1.0.21 + touch 重导 |
| **headless 验证矩阵** | 截图与 readPixels 因合成层冻结不可信（两次运行数值逐位相同）；控制台/渲染批次/uniform 真值/组件状态全部可信 | 用 CDP 探针验证数据链路（探针脚本在测试项目根 headless-*.mjs） |

| **引擎仓 meta 污染（下午全量爆发的总根因）** | 引擎 editor/assets/ 36 个 meta 被改写为 importer:"*" → 内置资产被兜底导入器原样拷贝进项目 library → import://….json 404 → 编辑器启动雪崩（方向光/材质预览/Profiler 连环崩、项目 meta 被连带改写、编辑器卡死） | 恢复：git checkout 引擎 meta；项目 meta 按扩展名修复（typescript/4.0.24、material/1.0.21、effect/1.7.1、scene/1.1.50、image/1.0.27、directory/1.2.0，保留 uuid/userData）；清空 temp/+library/ 全量重导。预防：编辑器异常时先查引擎仓 git status 的 meta 改动 |
| **temp/ 清空的副作用** | 「当前打开场景」状态丢失，编辑器打开空白场景 → 预览黑屏无内容（场景资产完好） | 打开 assets/scene.scene 再预览 |
**验收标准一句话：Phase0Demo 里的全部 uniform 管理代码被删除，换成挂组件。**

### 新增内容

```
cocos/2d/components/light-2d.ts          Light2D 基类 + PointLight2D
   Light2D（抽象基类）: color / intensity / receiverLayers(受光层集合,
                        Unity 血泪教训,一等参数) / staticLight(烘焙标记,
                        设计纪律#2,第一天就有) / lightMask
   PointLight2D:        radius(组件属性,不用 UITransform 尺寸;编辑器 gizmo 画圈)
cocos/render-scene/scene/...             RenderScene 增加 2D 灯列表(照抄
                                         _sphereLights 收集模式: onEnable/
                                         onDisable 注册/注销)
灯表管理系统(内部,不暴露)                 每帧: 收集→视锥/距离剔除→超限按
                                         强度裁剪→统一 setUniform
editor/assets/effects/for2d/
builtin-sprite-lit.effect                demo 的 sprite-lit.effect 转正为内置
```

### 刻意不做（本切片内）

锥光、阴影、RT、受光侧组件——先让"点光 + 环境光 + AmbientLight2D 昼夜"以组件形态跑通全链路
（含编辑器 gizmo、Inspector 调参实时生效）。

### 灯表 UBO 布局冻结（设计纪律#5，本步必须完成）

字段定版、上限 16 盏、std140 铺平方式。Phase 3 法线复用此表，晚定多返工。

### 目标形态

demo 里三个灯节点各挂 `PointLight2D`、Canvas 挂 `AmbientLight2D`，`Phase0Demo`
萎缩为纯动画（光跟随/环绕/闪烁），不再出现 `getHandle`/`setUniform` 字样。

---

## 第 3 步：Phase 1 后半——光照累积 RT（1~2 周）

> **状态（2026-10-13）：完成。前向/RT 亮度逐点一致（24/24 网格采样点逐位相同，全图 99.997% 像素一致或 ±1 舍入），待用户肉眼复核。** 路线 C（双相机 light RT，纯公开 API）：
> - 灯相机（正交、visibility=1<<26 灯层、priority 先于 UI 相机、`targetTexture`=**RGBA16F RT（画布缓冲同尺寸）**、**clear 色=环境光**）拍衰减面片
> - 衰减面片：白图 Sprite + light-falloff.effect（additive，衰减公式与前向 calcLight 逐项一致），
>   manager 每帧同步位置/尺寸/颜色，池化复用；灯根节点在 Canvas 子树内（保证被 batcher 遍历）且主相机不可见
> - `sprite-lit-rt.effect`：vs 算屏幕 UV，fs 单次采样 `lightMap`（无 layout 声明的普通采样器 + 属性同名）合成
> - 材质自动发现时探测 `getBinding('lightMap')`，RT 创建/变更时统一 `bindTexture/bindSampler`
> - demo 按 **L 键 A/B** 切换地面材质（前向灯表 ↔ RT 采样），props 保留前向（两路径共存）
>
> **headless 验证记录**（`headless-rt-verify.mjs` / `headless-keycheck.mjs`）：
> 灯相机 ortho/层位/priority/RT[640x269]/clear 色随昼夜变化 ✓；3 面片位置正确且冷光环绕中 ✓；
> light-falloff×3 批次在渲染 ✓；L 切换后 `sprite-lit-rt` 批次接管、`lightMap` binding=1 绑定 RT 纹理 [640,269] ✓。
>
> 新增 effect 编译器规则（踩坑）：**向量 uniform 必须在 block 内**（EFX2201）；**带显式 layout 的采样器不进属性匹配**（EFX3302，改普通声明）。
> 遗留：RT 采样未做 Y 翻转（WebGL 正确，Metal/Vulkan 待验——native 时的耦合讨论点）；headless 下 CDP 合成按键不达引擎输入层（A/B 用直调方法验证，真实按键浏览器可用）。
>
> **亮度不一致问题（用户报告"按 L 前后内容不同"）——完整根因链（已解决）**：
> 1. ~~0.5x RT 双线性模糊×凹形衰减~~（lightMapScale 提到 1.0 后仍有 -10%~-22%，排除为主因）
> 2. ~~设计分辨率 vs 屏幕缓冲密度差~~（实测 headless 下 `getVisibleSize()` 已=缓冲 1280×538，排除）
> 3. **真根因：RGBA8 光照累积 RT 在 1.0 硬截断**。`readPixels` 直读 RT 证实：环境区=592（环境光原值），
>    灯池中心全部 **765=255×3 白色截断**；前向路径 float 计算无截断，`albedo×L` 中 L≈1.2~1.5 的池心
>    在 RT 路径被压到 1.0 → 位置依赖变暗 -7%~-22%（个别池边点反而偏亮=截断后相对抬升）。
>    诊断方法值得复用：**分别 dump RT 内容与屏幕像素**，一次 bisect 出"画 RT 错"还是"采样错"。
> 4. 修复：光照 RT 改 **RGBA16F**（`RenderTexture.reset({passInfo: new gfx.RenderPassInfo([RGBA16F colorAttachment], DS)})`，
>    设备能力探测 `getFormatFeatures(RGBA16F)` 不满足则回退 RGBA8 并告警）。
>    **连带引擎修复**：`RenderTexture._initWindow` 原本无条件把 colorAttachment.format 覆写为 swapchainFormat，
>    用户显式传入的 passInfo 格式也会被冲掉 → 改为仅默认路径覆写、显式 passInfo 尊重自带格式
>    （`cocos/asset/assets/render-texture.ts`，引擎仓提交）。RGBA16F additive blending 在 WebGL2 需
>    EXT_color_buffer_float（16F 可混合，32F 才需 EXT_float_blend），主流设备均支持。
> 5. 验证：冻结态（P）headless A/B（`headless-ab-metal.mjs` swiftshader）前向/RT/切回前向三段
>    24 网格采样点**逐位一致**；双截图全图 diff：仅 0.003% 像素差异>30（全是提示 label 的模式文字本身），
>    其余 ±1（half-float 尾数 vs float32 的末位舍入，不可见）。
> 6. 教训：**亮度类差异先查数值范围/截断，再查分辨率/模糊**——8bit RT 做 HDR 累积介质是结构性错误，
>    分辨率排查走了弯路（先修了尺寸对齐，方向正确但不是主因）。

- 把 `calcLight` 从 sprite pass 搬进"画光进 RT"的 pass（RGBA16F HDR、additive、画布缓冲同尺寸）
- sprite 改采样 RT 合成（屏幕 UV 由 position 算出，SAMPLE_FROM_RT 已有翻转处理）
- 受光层过滤落地：`receiverLayers × DrawBatch2D.visFlags`（机制现成）
- **组件 API 零变化**（架构已预留平移：换的是消费者，不是数据源）
- 可调参数：RT scale、动态光上限（对应质量档 Mid 档起步值）

---

## 第 4 步：Phase 2 阴影（径向 reach 路线，2026-10-13 完成）

> **状态：三小步全部完成并验证。** 计划原定「MeshRenderer + 三角扇」，被**项目模块裁剪**封死
> （测试项目裁掉 3D 单元：项目脚本的 cc 导出面是 x-shim 聚合的 ~25 个 cc-fu 单元，
> `MeshRenderer`/`Mesh`/`utils.MeshUtils` 均不在内——cc.d.ts 类型声明有但运行时 undefined）。
> 转向**径向 reach 纹理**，反而更优：

### 架构：ρ(θ) 统一一切光形状

光形状 = 一张 **128×1 RGBA8 纹理**（texel i = 方向角 θᵢ 上光到达的距离比例 ρ∈[0,1]），
**四边形面片几何永不改变**，fs 里 `t = length(uv*2-1) / ρ(atan(uv))`，atten 公式同前向：
- **点光**：ρ≡1（基类 fillReach 默认实现）→ 与前向 calcLight **逐位一致**（A/B 24/24 点验证）
- **锥光 SpotLight2D**：ρ = 角度掩码（锥内 1、锥外 0、softness 线性过渡）；锥轴 = 节点世界 +X；
  `forwardTableEligible = false`（形状灯不进前向冻结表，避免画成圆）
- **raycast 阴影**：ρ = 命中距离/radius，与图案 **min 合成**（锥光×阴影天然相交）
- **软阴影**：ρ 行角度域环形盒滤波（wrap 索引顺带修复 ±π 接缝）≈ 半影，`shadowSoftness` 参数
- 全程 2D batcher 原生管线（Sprite quad），**零模块依赖、零新增渲染路径**

### 组件与场景（demo 合集，每功能一 scene）

- `LightOccluder2D`：多边形为空 = 自动取节点 UITransform 矩形（任何 Sprite 挂上即成墙）；
  raycast 为 manager 内置纯 TS 线段求交（Box2DLights CPU 基线模式，无物理模块依赖）；
  编辑体验升级路线：从 PolygonCollider2D 派生 points（用内置 collider 编辑器）
- `Light2D` 基类新增 `castShadow` 开关；manager 每帧收集遮挡体世界边段（帧内缓存共享）
- 场景：`assets/scenes/spot-light.scene`（三锥光：跟随指针/旋转扫描/闪烁）与
  `assets/scenes/shadow.scene`（三投影点光 + 墙/箱/柱遮挡体 + softness=0.3 半影）
- **验证**：锥光三锥成形、动画正常；阴影场景柱子投出影楔、光池被遮挡体直线切边、半影可见
  （视觉确认）；无影路径 parity 逐位一致（遮挡代码零影响）
- **踩坑**：①手写场景组件 `__type__` 必须用 **uuid 压缩类 id**（编译 chunk 里
  `_RF.push({}, "<id>", "<类名>"` 提取；裸类名会被"Can not find class"静默移除组件）
  ②`http://localhost:7456/?scene=<uuid>` 可 headless 直测任意场景
  ③preview 的"当前场景"跟随编辑器打开的场景——headless 脚本要显式传 uuid，否则测错场景
  ④raycast 线段求交的 u 参数符号（`u = (ox·dy−oy·dx)/denom`，多写负号导致所有交点被拒——
  用具体数值 O=(0,0),D=(1,0),x=5 竖线段推导验证）

---

## 暂缓项（有理由地放着）

| 项 | 理由 |
|---|---|
| 移动端性能基线 | 等 RT 落地后一起测才有意义（RT 才是性能敏感形态） |
| JSB 双端同步 | 组件层 TS 先行，API 稳定后再镜像 native（Phase 1 明确 custom-only + web 先行） |
| 锥光 / 阴影 / 法线 | 分别在 RT 之后：锥光=RT 形状、阴影=Phase 2、法线=Phase 3 |

---

## 文档索引

- `2d-lighting-research.md` —— 架构选型与分层设计（为什么这么做）
- `2d-lighting-engine-issues.md` —— Phase 0 发现的引擎问题与 API 陷阱（证据链）
- 本文 —— 执行计划与状态（做到哪、接下来做什么）

---

## Phase 3 · 法线映射（2026-10-14 完成，前向路径）

**范围**：前向 `sprite-lit.effect` 加 normalMap + 逐灯 N·L（wrap diffuse）；RT 路径法线
需要"方向编码光照图"（RGB=Σcolor·dir、A=Σ亮度），留待后续。

- `sprite-lit.effect`：`normalMap` 材质属性（sampler）+ `USE_NORMAL_MAP` define；
  fs 里 `n = normalize(tex.rg*2-1)`，calcLight 里 `diff = clamp(dot(n, toLight/d)*0.5+0.5)`
  （wrap：背光坡保持一半能量，2D 水面观感）；define 关闭时 diff≡1（不改变无 define 路径）
- 法线贴图：PIL 程序生成（整数周期波保证可平铺——本次直接 1280×720 整幅 + 配对
  water-diffuse，波峰亮化与高度场对齐）
- `NormalDemo.ts`：运行时 `new Material + initialize({defines:{USE_NORMAL_MAP:true}}) +
  setProperty('normalMap')`（避免手写 .mt）；暖光横扫 + 冷光环绕
- `normal.scene`：全幅水面 + 双灯 + 序列化 PointLight2D/Light2DGizmo
- **验证**：headless 停灯于世界原点，过灯心水平亮度剖面去趋势残差 ±13%（7 次符号翻转）
  = 波纹调制确认；`USE_NORMAL_MAP` define 与 normalMap binding 双确认

## 序列化与 gizmo（2026-10-14）

- **纯 accessor @property 不序列化**（computed，不进 `__values__`）：可序列化数据必须挂
  `_` 前缀 backing 字段（`@property({visible:false}) private _radius`），accessor 另挂
  @property 供检查器（引擎自身同款模式，如 cc.Camera `_orthoHeight`）
- 场景灯光组件已序列化（shadow/spot/normal 三场景），demo 的 ensure* 幂等跳过——编辑器
  里可见可调，gizmo 才有数据可画
- **Light2DGizmo**：3.8 无扩展 gizmo 注册 API（`cce/public/gizmos` 为编辑器私有，
  app.asar 全文无注册入口）→ `executeInEditMode + playOnFocus + Graphics` 路线：
  点光=半径圈+十字、锥光=楔面+光轴、遮挡体=轮廓描边；画在 `DontSave|HideInHierarchy`
  子节点（不写场景文件、不与 Sprite 冲突）；预览/构建自灭（EDITOR 判断）
- 半径圈按世界半径/节点世界缩放绘制（灯半径是世界单位）

## 环境事故记录（2026-10-14，重要）

编辑器重启后 **自定义引擎回退 builtin**（asset-db preload 失败→静默 fallback 并把
`~/.CocosCreator/profiles/v2/packages/engine.json` 的 builtin 写回 true）：

1. **根因链**：编辑器 3.8.8 的 compile-custom-engine 重编 v4 引擎缓存时，import-map
   不含 **裸 `pal/*` 别名**（生成 `q-bundled:///fs/pal/x` 键而非 `pal/x` 键；
   builtin 引擎的官方 CI 构建有裸键）→ asset-db worker 里 SystemJS 解析
   `q-bundled:///fs/cocos/gfx/webgl2/webgl2-device.js` 的 `pal/system-info` 裸依赖
   失败（Error#8）→ preload 报错 → 引擎回退 builtin。全清 bin/.cache 重建同样复现。
   **修法（待办）**：v4 引擎构建侧补齐裸别名，或匹配 editor 的编译器版本。
2. **builtin 引擎上的连带**（plugin 已适配）：
   - RenderTexture 显式 passInfo 被 `_initWindow` 覆写回 swapchain 格式（引擎侧修复
     670d982abb 只在 v4 生效）→ 光照 RT 回退 RGBA8（1.0 截断、灯池中心约 -22%）
   - packer 对项目脚本输出 **CJS-in-System 坏块**（`exports is not defined`，模块图全崩）
     → `fix-preview-chunks.mjs`（项目根）重写这些 chunk（deps 解析+xhr require stub+
     exports harvest），**编辑器每次重启后需重跑**
   - 2D 动态图集 `DynamicAtlasTexture.drawTexture→texSubImage2D` 在新 Chromium 下
     Overload resolution failed（builtin 老代码，非致命噪音）
   - reach 纹理改用 `reset+uploadData`（copyBuffers 路径，避开 ImageAsset-_data 的
     texSubImage2D TexImageSource 重载陷阱），两种引擎通用
3. **自定义引擎恢复后**：HDR/位级 parity 应回到 10-13 状态（RGBA16F、e2e 浮点对拍）；
   builtin 上的 e2e RT 读回返回全零（读到 resize 后被重建的 framebuffer 旧句柄），
   以屏幕渲染+剖面分析代验。


---

## Phase 2.5 · 桌面性能基线（2026-10-16，Metal / M 系 Mac）

方法：`headless-perf.mjs`（项目根，headless Chrome + `--use-angle=metal`）。
帧耗时 = AFTER_DRAW 时间戳差（120 帧，vsync 60 封顶）；CPU 阶段耗时 = 包装
`_syncLightShapes`（四边形同步+reach 填充+上传+uniform）与 `_applyOcclusion`
（512 向 raycast，为前者子集）的 performance.now 累计。场景：shadow.scene，
40 地砖 + N 灯 + M 墙（每墙 4 段）。

**帧耗时：全部配置 16.67ms（60fps vsync 封顶），p95 ≤ 18.6ms** —— 含 16 灯
raycast 阴影 + 8 遮挡体 + 全分辨率 RT，桌面 GPU 无压力（GPU 成本被 vsync 封顶
掩盖，未超帧即有富余；如需 GPU 余量刻度需关 vsync 或加大像素负载）。

**CPU 阶段成本（每帧，ms）—— 唯一随规模增长的成本是 raycast：**

| 配置 | sync 总计 | 其中 raycast | 备注 |
|---|---|---|---|
| 前向 4/8/16L | 0.044 / 0.071 / 0.094 | 0 | 冻结灯表打包，~6µs/灯 |
| RT 无影 4/8/16L（s1.0→0.25） | 0.031–0.102 | 0 | 与前向同级，RT 分辨率无关 |
| RT+影 4L/1墙 | 0.129 | 0.091 | |
| RT+影 8L/1墙 | 0.326 | 0.248 | ≈31µs/灯 |
| RT+影 16L/1墙 | 0.612 | 0.523 | 线性外推 |
| RT+影 8L/2墙 / 8墙 | 0.431 / 0.633 | 0.366 / 0.588 | 随段数线性 |
| RT+影 8L/1墙（s1.0 / 0.25） | 0.318 / 0.331 | 0.259 / 0.263 | **CPU 成本与 RT 分辨率无关** |
| 锥光 8L/1墙 | 0.336 | 0.247 | 锥光 raycast ≈ 点光 |

**结论**：①raycast ≈ 33µs/灯/4 段，16 灯×8 墙 ≈ 2ms/帧（桌面可忽略，移动端
预算内）；外推 16 灯×32 墙（128 段）≈ 8ms/帧——届时才需要 reach 缓存/静态灯
增量化（staticLight 标记已预留）。②RT 分辨率只影响 GPU 侧，桌面全分辨率无感。
③swiftshader 软渲染地板 ~25ms 会淹没一切差异，基线测量务必用 `--use-angle=metal`。

真机（iOS/Android/低端 Win）由用户按同表跑 `?scene=` + 同脚本对照。

---

## 2026-10-19 更新：DirectionalLight2D 完成纪要

**架构定稿（取代原 MRT 方案）**：单附件光照 RT，RGB=颜色累积（环境光 clear +
点/锥光 falloff + 方向光含染色影），A=方向光 vis。接收端以 directionalLight2D
uniform（rgb=色·强度, w=方向角）+ lightMap.a 重建法线可调制的太阳贡献
（`rgb += dir.rgb·a·(wrap−1)`，无 normal map 时恒等）。MRT 撤销原因见
issues 文档勘误。

**高度图阴影管线**：R(lx)=该列"光到达的最远 ly"（无遮挡=+∞ 截帧顶；有遮挡=
遮挡体上游面近边 MIN）；2048 列 R+G 16-bit 编码；NEAREST 采样；横向平滑
min-clamp（包络不变量 R_filtered ≤ R_envelope）；ly 向过渡 edge=softness×96。

**质量链验证方法（可复用）**：headless(metal) + RT A 通道扫描线 crossover 对拍
物理理论（upstream 射线求交）；合成斜坡注入实验隔离渲染链（实测链路精确到
亚像素）；视觉模型审图。世界→UV 映射必须含相机偏移（Canvas 布局相机在画布
中心）。

**量化地板结论**：影边互差 ~0.2°/≤0.5°（对光角）——2048 列 × 像素网格双重量化
的架构极限，非 bug；像素级精确需换解析阴影体/逐像素 raymarch 架构（未启用）。

**e2e**：spot/shadow/normal 回归通过。demo 新增键盘调光（←/→ ±1°, ↑/↓ ±0.1°）
+ 实时角度显示（DOM 键盘事件——引擎 input 新导入在坏 chunk 时序下会 undefined）。
