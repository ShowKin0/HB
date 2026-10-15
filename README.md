# HB — 面向手机浏览器的通用 2D 互动叙事引擎

一个**内容无关**的引擎：内容负责声明"要发生什么"，引擎提供可调用的交互、
演出、音频和存档能力。现在仓库里跑的是一份**占位内容**，只用来证明整条链路是通的。

引擎不预设剧情、画风、时长或结局形式，也**不要求**所有游戏都用物品栏、
角色寻路和小游戏 —— 这些是按项目声明加载的能力。

- **玩法**：点击地面让角色走过去、点物件触发剧情、长按、拖放、轻解谜、小游戏插曲
- **技术栈**：Vite 8 + React 19 + TypeScript · [ink](https://www.inklestudios.com/ink/)（剧情）· Canvas 2D（角色与场景）· Howler（音频）· Zod（仅构建期校验）
- **部署**：Docker 多阶段构建 + nginx 静态托管

---

## 三个底座

引擎的可靠性建立在这三件事上。它们都不依赖具体剧情或画风，所以先做。

### 1. 输入仲裁（`src/engine/input/router.ts`）

指针事件**不直接执行交互**。先过手势状态机，归约成"一次手势的一个结果"：

```text
idle → pressed → tap / holding / dragging → idle
                  ↘ cancelled ↗
```

- `pointerdown` 只记录并给按压反馈，**不执行任何交互**
- 移动超过 10 CSS px 才升级成拖动，同时撤销点击候选
- 长按由**游戏循环**推进（不是 `setTimeout`），暂停时自然不误触发
- 长按一旦触发，这次手势就归属长按了，不会再降级成拖动
- `pointercancel` / 捕获丢失 / 切后台 / 转屏 / 弹面板 / 切场景 → 一律取消，**不产生成功结果**

阈值一律用 **CSS 像素**。按场景比例算的话，同一段手指移动在不同手机上会得到
不同结果 —— 手机上手感会飘。

**输入归属**是分层的，高优先级在场时低优先级收不到输入：

```text
面板 / 小游戏  >  对话与选项  >  场景交互
```

所以"点一下推进对话"不会顺带把背后的场景热点也点了。

⚠️ **指针捕获只在画布上开始的手势里启用。** 在 UI 元素上捕获会把后续的鼠标事件
也重定向到捕获目标，子元素的 `onClick` 就永远不触发 —— 表现是"选项按钮点不动、
物品栏选不中"，而且完全不报错。这个坑踩过一次。

### 2. 可取消的运行时任务（`src/engine/task.ts`）

所有异步动作（等待、加载素材、小游戏）都拿一个 `TaskContext`：

```ts
interface TaskContext {
  signal: AbortSignal
  sessionId: number
  sceneId: string | null
}
```

- 重开 / 读档会 `SessionScope.restart()`：**中止所有在飞任务并换一个会话号**
- 写入引擎状态之前必须过 `scope.isCurrent(ctx)` —— 光看 `signal.aborted` 不够，
  会话重启后 signal 是新的，旧任务却还记着旧会话号
- 取消是 `TaskCancelled` 异常，**不是故障**：指令层让它冒泡，`drainStory` 静静收手
- 切场景是**准备后提交**：所有 `await` 都在替换状态之前完成，不存在"runtime 是新的、
  资源还是旧的"这种半截窗口

**暂停用原因集合**（`hidden` / `panel` / `orientation` / `minigame`），
只有全部解除才恢复 —— 否则"关掉设置面板"会错误地恢复一个仍在后台的游戏。

### 3. 按声明加载的能力（`content/project.json`）

```json
{
  "schemaVersion": 1,
  "startScene": "start",
  "capabilities": ["story.ink", "interaction.tap", "interaction.hold", "audio"],
  "saveCompatibility": "1",
  "mobile": { "orientation": "auto", "sceneFit": "contain", "maxDpr": 2 },
  "minigame": { "skipAfter": 3 }
}
```

- 未声明的能力不加载。内容里用到了却没声明 → **`content:check` 报 error 挡住构建**
  （`interaction.*` / `minigame` / `story.ink`），其余给 warning
- 依赖自动展开：声明 `interaction.hold` 会带上 `interaction.tap`
- `saveCompatibility` 与内容指纹**分开**：换一张图会改变指纹，但那不该判定剧情存档不兼容

---

## 手机横屏优先

这个引擎**以手机横屏为主要形态**：横屏是默认与设计基准，竖屏只做兼容。

以 iPhone 14 横屏（844 × 346 CSS px，Safari 工具栏展开时的常见状态）为准：

```text
┌──────────────────────────────┬──────────────┐
│  HUD                         │              │
│                              │   对话面板    │
│   场景区（letterbox）          │   台词居中    │
│                              │   选项靠下    │
└──────────────────────────────┴──────────────┘
        591 × 346                     253 × 346
```

为什么是右侧面板，而不是底部对话框：

| 方案 | 场景占屏 | 角色会被盖住吗 |
|---|---|---|
| 竖屏底部对话框（原方案） | **27%** | 否（场景让开 168px） |
| 横屏底部浮层（走过的弯路） | 35% | **会** —— 浮层盖住角色能走到的最后 49px |
| **横屏右侧面板（现方案）** | **67%** | 否，结构上不可能 |

底部浮层看着省事，但在 346px 高的屏上无解：面板要 105px 才放得下两行字，
场景又不肯让开那么多 —— 中间那段正好是角色能走到的区域。这条被
「角色走到最前排不会被对话框盖住」的 E2E 当场抓住。

几个必须知道的约定：

- **`viewport-fit=cover` 不能删。** 少了它 iOS 会把布局视口缩进安全区，
  `env(safe-area-inset-*)` 一律返回 0 —— 安全区代码看着写了，实际完全失效，
  横屏时刘海会直接压住 HUD。
- **安全区是四条边，不是上下两条。** 横屏刘海在左或右，`--safe-l` / `--safe-r`
  都要用。
- **布局的真相源在 CSS 变量里**（`--scene-inset` / `--scene-right-inset`），
  JS 通过一个尺寸由变量决定的**探针元素**读取解析后的像素。
  不要用 `getComputedStyle().getPropertyValue('--x')` —— 自定义属性返回的是
  **未求值的 `calc(...)` 文本**，`parseFloat` 得到 NaN，右留白会悄悄变成 0。
- **高度用 `dvh`，内边距不要用百分比。** CSS 的百分比内边距按包含块的
  **宽度**解析；横屏下 `30%` 会算出 253px 而不是 104px，把文字顶到面板顶部。

竖屏时会盖一层"请把手机横过来"并**暂停模拟**（`pauseState` 里是 `orientation`），
避免玩家对着被压扁的布局乱点。

---

## 快速开始

```bash
npm install

npm run dev          # 开发服务器，自动先编译剧本
npm run build        # 生产构建（content:check → ink:build → tsc -b → vite build → bundle:check）
npm run preview      # 本地预览构建产物
```

`build` 的最后一步 **`bundle:check`** 是一条硬约束：它扫描产物，一旦发现 Zod 被
打进运行时包就**构建失败**。Zod 只该出现在构建期校验里 —— 这个坑踩过两次
（`App.tsx` 静态引编辑器、`content/project.ts` 同时放 schema 和运行时函数），
每次都是静默多背 24 kB，而且靠人看代码是查不出来的。

开发模式下访问 **`/edit`** 进入场景编辑器。

### 常用校验命令

| 命令 | 作用 |
|---|---|
| `npm run content:check` | **写内容时最常用的**。校验场景 JSON、悬空的 ink 引用、地面四角是否退化、出生点/走位点是否落在阻挡格里、物品是否有显示名、部件图集的部件名与配图、缺失素材 |
| `npm run content:check:strict` | 同上，但缺素材也算失败（上线前验收用） |
| `npm run ink:build` | 编译 `content/story/*.ink` → `*.json` |
| `npm run script:export` | 从剧本导出配音台词表 `content/voice-lines.csv` |
| `npm run vo:check` | 检查配音缺了哪几句（缺失会降级成"只出文字"，不会崩） |
| `npm run bundle:check` | 产物守卫：Zod 不得进运行时包；顺带报告各 chunk 体积 |
| `npm run assets:manifest` | 生成素材清单并估算首包体积 |
| `npm run img:optimize` | 把 `art-src/` 的原图压成 AVIF + WebP 放进 `public/assets/` |
| `npm test` | 单元测试（单应变换、寻路、平滑、精灵表选帧） |
| `npm run test:e2e` | 端到端测试（生产构建产物，WebKit + Chromium 双端） |
| `npm run test:e2e:editor` | 编辑器端到端测试（跑在 dev server 上） |

---

## 目录结构

```
content/
  story/*.ink        剧本（你写）
  scenes/*.json      场景与热点（编辑器导出）
  items.json         物品 id → 显示名
  voice-lines.csv    配音台词表（生成）
public/assets/       素材产物：bg / portrait / ui / photo / fg / rig / audio
art-src/             原图（不进构建上下文，可能几十 MB 一张）
scripts/             内容管线
src/
  schema/            内容契约（Zod）
  engine/            引擎核心：场景运行时、寻路、角色、ink 桥接、演出指令、存档、音频
  render/            画布、单应变换、深度排序、画面效果
  actorRenderers/    角色渲染器：partRig / glide / spriteSheet
  ui/                界面
  editor/            场景编辑器（仅 DEV）
docker/              部署配置
```

文档：

| 文件 | 内容 |
|---|---|
| [README.md](README.md) | 本文件：契约、工作流、部署 |
| [ART-GUIDE.md](ART-GUIDE.md) | **美术素材生产**：怎么定画风、实物怎么进来、要不要 3D 扫描、工具链 |
| [CREDITS.md](CREDITS.md) | 素材来源与许可登记（上线前必填） |

---

## 内容契约

**这是全篇最重要的一节。** 引擎不认识"第几幕""几个谜题"，它只认下面这几份契约。

### 1. 逻辑真相源只有 ink

分支、条件、开关、物品、谜题判定**全部**写在 `.ink` 里，可整体序列化进存档。

但"真相源"不等于"什么都往里塞"。状态分成三类，各归其位：

| 类别 | 放哪 | 例子 |
|---|---|---|
| **剧情状态** | ink | 分支条件、开关、谜题判定、结局 |
| **空间状态** | 引擎 + 存档 | 抽屉开着没有、相框转到哪了、东西挪到哪了 |
| **呈现状态** | React | 对话框、选项、面板开合 |

理由是：物件每帧的位置、拖拽过程、开合进度如果都写成 ink 变量，剧本会被几十个
只用一次的变量淹掉，而且改一个数值就得动剧本。**引擎侧只存呈现与空间状态，
改剧情永远不需要改代码。**

两类状态靠**事件桥**单向同步（见第 7 节）。

### 2. 条件必须写成 ink 函数

```ink
=== function can_take_key() ===
~ return looked_shelf > 0 && has_key == false
```

场景 JSON 里写函数名：

```json
{ "visibleWhen": "can_take_key" }
```

> ⚠️ 必须是 `=== function xxx() ===`。inkjs 的 `EvaluateFunction` **只认函数**，
> 写变量或普通 knot 会在运行时报 "Function doesn't exist"。
> `npm run content:check` 会提前把这类错误挑出来。

### 3. 场景文件

```jsonc
{
  "id": "start",
  "title": "占位房间",

  // walk  —— 有地面，角色可以走过去（房间、走廊）
  // focus —— 固定镜头特写，不做寻路（桌面、手机屏幕、信件、相册）
  // 不写则自动推断：有 ground 且有 actors → walk，否则 focus
  "mode": "walk",

  "bg": "bg/room.avif",          // null 时引擎画渐变占位，不会留白
  "aspect": 1.7777777777777777,

  // 地面标定：地面平面上单位正方形的四角在场景空间的位置
  // 顺序固定：(0,0) 后左 → (1,0) 后右 → (1,1) 前右 → (0,1) 前左
  // 四角构成矩形时自动退化为正交场景，同一套代码覆盖两种情况
  "ground": { "corners": [[0.08,0.55],[0.92,0.55],[1.0,0.98],[0.0,0.98]] },

  // 可行走掩码：'.' 可走，'#' 阻挡。row 0 是最远处
  "walkable": ["................", "....####........"],

  "actors": [{
    "id": "hero", "renderer": "partRig",
    "spawn": [0.5, 0.85],        // 地面平面坐标
    "heightRatio": 0.22,         // 出生点处的身高（占场景高度比例）
    "speed": 0.42                // 每秒走过多少比例的地面
  }],

  "hotspots": [{ …见第 4 节… }],

  "layers": [{ …见第 5 节… }],

  "exits": [{ "id": "ex_door", "shape": {…}, "to": "hall", "when": "is_door_unlocked" }],

  "entry": "start",              // 进入场景时执行的 knot
  "hub": "hub"                   // 交互结束后的返回锚点
}
```

坐标全部归一化到 0–1，换分辨率不需要重摆。

> **focus 场景不能有 `actors` 和 `ground`** —— schema 会直接拒绝。
> 这不是限制，是防止你配了一个永远不生效的走位点。

### 4. 物件与交互（触发器 + 动作）

一个物件可以挂**多条交互**。每条交互分成两层：

```text
触发器：玩家做了什么   →   tap / hold / use / drop
动作  ：引擎要执行什么  →   effects 列表
```

两者正交，所以同一套动作可以被任何触发器复用。新格式直接写 `effects`：

```json
{
  "id": "hs_lamp",
  "shape": { "type": "rect", "x": 0.06, "y": 0.08, "w": 0.1, "h": 0.24 },
  "initialState": "off",
  "interactions": [
    {
      "verb": "inspect",
      "effects": [
        { "type": "object.patch", "target": "@self", "patch": { "state": "on" } },
        { "type": "story.event", "name": "lamp_lit" }
      ]
    }
  ]
}
```

**关键约束：动作里没有 `story.knot` 时，整条交互完全不碰 ink。**
纯物件操作（开抽屉、点灯、切状态）因此可以独立成立 —— 通用引擎不该要求
每条交互都必须跳转 knot，也不该要求有剧情。

可用的动作：

| type | 作用 |
|---|---|
| `object.patch` | 改物件状态 / 可见性 / 局部进度。`target: "@self"` 指这条交互所属的物件 |
| `story.knot` | 跳转 ink knot（**唯一**会碰剧情的动作） |
| `story.event` | 给这次交互的事件起名，写进 `last_event` 并记进存档 |
| `audio.sfx` | 播放音效 |
| `item.award` | 把物品放进背包 |
| `item.consume` | 把物品从背包移除 |

⚠️ **"用完取消选中"和"从背包消耗"是分开的两件事。** 用了物品不等于消耗物品：
选中态由引擎在 use/drop 之后自动清掉，而是否真的从背包里消失只由
`item.consume` 决定。

旧字段（`action` / `setState` / `setVisible` / `emit` / `sfx`）仍然可用，
会被适配成等价的动作列表 —— **适配只做一次**，之后运行时只看 `effects`，
新增动作类型时不用在每个入口再写一遍新旧分支。

> 适配逻辑（`effectsFromLegacy` / `summarizeEffects`）由 Zod 路径与
> `normalizeScene` 路径**共用**。各写一份的话，`tests/normalize.test.ts`
> 的一致性断言立刻会报漂移 —— 这条测试确实抓到过一次。

### 4.1 动词与触发方式

| verb | 触发方式 |
|---|---|
| `inspect` | 点击 |
| `use` | 手上拿着匹配 `item` 的物品时点击 |
| `drag` | 把物品拖上去（`accepts` 列出接受的物品） |
| `hold` | 长按（默认 500ms，由手势状态机判定） |
| `sequence` | 已预留，引擎尚未实现 —— 写了会**明确报错**，不会静默失效 |


### 4.2 完整物件字段

一个物件可以挂**多条交互**，按动词 + 条件筛选，命中哪条走哪条：

```jsonc
{
  "id": "photo_frame",
  "shape": { "type": "rect", "x": 0.3, "y": 0.3, "w": 0.16, "h": 0.24 },
  "label": "相框",
  "cursor": "look",
  "visibleWhen": null,              // ink 函数名，false 时连点都点不到
  "approach": [0.4, 0.6],           // 触发前角色站的位置（仅 walk 模式）

  // ── 外观（可选）。不写 image 就是纯命中区，外观由背景图承担 ──
  "image": "photo/frame_closed.avif",
  "visualStates": {                 // 视觉状态 → 图。抽屉开/关、相框亮/暗
    "closed": "photo/frame_closed.avif",
    "opened": "photo/frame_opened.avif"
  },
  "initialState": "closed",
  "position": [0.38, 0.54],         // 绘制锚点；null 用命中区中心
  "anchor": [0.5, 1.0],             // 锚点在图内的相对位置
  "height": 0.3,                    // 图高占场景高度的比例
  "scale": 1, "rotation": 0,
  "v": 0.5,                         // 深度，和角色/图层一起排序
  "shadow": true,                   // 画一圈落影
  "anim": { "type": "float", "amplitude": 0.006, "speed": 0.4, "phase": 0 },

  "interactions": [
    { "verb": "inspect", "when": "can_inspect_frame", "action": "inspect_frame",
      "setState": "opened", "emit": "frame_opened" },
    { "verb": "use", "item": "item_cloth", "action": "clean_frame", "sfx": "sfx/wipe.ogg" },
    { "verb": "drag", "accepts": ["item_photo"], "action": "place_photo" }
  ]
}
```

**动词**：

| verb | 触发方式 | 用到的字段 |
|---|---|---|
| `inspect` | 普通点击 | `action` |
| `use` | 选中物品后点它 | `item`、`action` |
| `drag` | 把物品拖到它上面 | `accepts`、`action` |
| `hold` | 长按 | **引擎尚未实现**，`content:check` 会报错 |
| `sequence` | 按顺序点多个目标 | **引擎尚未实现** |

`hold` / `sequence` 的数据模型已经预留，但引擎还没做 —— 写上去会**明确报错**，
而不是静默失效。

**每条交互都能带的效果**：

| 字段 | 作用 |
|---|---|
| `when` | ink 函数名，条件不成立时这条交互不可用 |
| `setState` | 切到某个视觉状态（对应 `visualStates` 的键） |
| `setVisible` | 显示 / 隐藏该物件 |
| `emit` | 事件名，见第 7 节。不写则由 `物件id_动词` 推导 |
| `sfx` | 触发时播放的音效 |

**旧字段仍可用**：`onClick` / `acceptsItem` / `onUse` 会被自动合成成等价的
`interactions`，旧场景不用改就能跑。但**两者不能并存** —— 同时写时旧字段会被
完全忽略，`content:check` 会把这个当成错误报出来。

### 5. 图层（纯视觉，不参与交互）

```jsonc
{
  "id": "drawer",
  "image": "fg/drawer_closed.avif",
  "visualStates": { "open": "fg/drawer_open.avif" },
  "initialState": null,
  "position": [0.62, 0.7],     // null 表示整帧铺满（旧式前景层）
  "anchor": [0.5, 0.5],
  "height": 0.2,
  "scale": 1, "rotation": 0,
  "v": 0.85,                   // 与角色一起排序：走到桌子后面只靠这个数
  "shadow": false,
  "anim": { "type": "sway", "amplitude": 0.005, "speed": 0.7, "phase": 0 },
  "visibleWhen": "is_drawer_visible"
}
```

物件的**空间状态由剧情驱动**：交互里的 `setState` / `setVisible` 改的是运行时状态，
它进存档、不进 ink。

### 6. 演出指令（剧本 ↔ 引擎的唯一接口）

```ink
书架的格子里躺着一把钥匙。 # vo: line_003 # speaker: 旁白
# sfx: sfx/rustle.ogg
# actor: hero walkTo(0.3, 0.7)
```

内置指令：`bg` `bgm` `sfx` `vo` `portrait` `speaker` `fx` `wait` `scene` `flag` `award` `unlock` `actor`。

**新增演出效果不需要改引擎**：

```ts
registerDirective('fx', (value, args, ctx) => { /* … */ })
```

标签可以单独占一行 —— 此时不显示对话框，只执行指令。

### 7. 事件桥：场景状态怎么让剧情知道

数据流是**单向**的，顺序是刻意的：

```
点击 / 拖放
  → Interaction Resolver    解析成一条明确的交互意图
  → 场景状态变更              setState / setVisible 立刻生效
  → 发事件                   记进存档 + 写进 ink 的 last_event
  → ink 推进                 跳转到该交互的 action knot
  → 演出                     指令与 UI 响应
```

**先改状态、再发事件、最后推进剧情** —— 这样剧情读到的永远是交互之后的世界。
反过来做的话，台词会说"抽屉开了"而抽屉还关着。

事件有两条出口：

1. **存档**：`engine.events` 记录每个事件发生过几次，剧情可以用
   `engine.getFlag` 之外的路径判断"这件事发生过"（跨场景持久）。
2. **ink**：事件名会写进 `last_event` 变量。剧本里声明一次：

```ink
VAR last_event = ""

=== focus_frame ===
# speaker: 旁白
相框里的照片有些褪色了。
{ last_event == "frame_opened": 你把它打开了一点。| }
-> DONE
```

事件名默认是 `物件id_动词`（如 `hs_shelf_inspect`），交互里写了 `emit` 就用它。

### 8. 选项

直接写 ink 的选项语法就行：

```ink
=== demo_choice ===
# speaker: 旁白
这里放一个选择。
* [选左边]
    你选了左边。
    -> DONE
* [选右边]
    你选了右边。
    -> DONE
```

两个必须知道的行为：

- **旁白会先显示，玩家点一下之后选项才出现。** 这是有意的：先把话说完，再让人选。
  所以一段"旁白 + 选项"的 knot，玩家会先看到旁白、再看到按钮。
- **选项出现时不会回 `hub`。** 引擎只在剧情**真的演完**（没有选项、没有排队跳转）
  时才回锚点。跳走会把刚发出去的选项抹掉 —— 这个坑踩过一次，
  表现是"选项根本不出现，剧情却被拽回锚点"。

选完之后剧情立刻继续，不需要再点一下对话框。

### 9. 交互 knot 不用写返回

点完一个物件、那个 knot 演完后，引擎会自动回到场景 JSON 里的 `hub`。
你只管把这一段写完，用 `-> DONE` 收尾即可。

同理，`entry` 的旁白会正常显示在屏幕上**等玩家推进**，不需要你额外处理。

### 10. `# scene:` 与文字同一行时的顺序

```ink
你推开门，走廊里的空气凉了下来。 # vo: line_012 # scene: hall
```

引擎会**先显示这句话，等玩家点掉之后再切场景** ——
否则同一行上的文字会被整句吞掉。所以出口（`exits[].to`）指向一个 knot
而不是场景 id，就能在切换前补一句旁白，这是推荐写法。

### 11. 配音靠显式 id

```ink
你拿起钥匙，它在手里凉凉的。 # vo: line_004
```

录音放到 `public/assets/audio/vo/line_004.m4a`。

> **不要**用行号或文本哈希当 id：你改一个字、插一行，已经录好的音频就全部对不上号了。

---

## 内容生产工作流

### 写剧情

1. 改 `content/story/*.ink`
2. `npm run ink:build`
3. `npm run content:check` —— 抓悬空 knot、写错的条件、缺的素材
4. 在 `/edit` 里摆场景，导出 JSON 覆盖 `content/scenes/`

### 出图

```bash
# 1. 原图放进 art-src/，按类别分子目录
#    art-src/bg/room.png
#    art-src/portrait/her.png
npm run img:optimize     # → public/assets/bg/room.avif + room.webp
npm run assets:manifest  # 看首包预算有没有超
```

各类别的最大边长在 `scripts/img-optimize.ts` 里配（bg 1920 / portrait 1200 / photo 1600…）。

**一致性是 AI 出图最大的坑**：同一角色的所有差分必须在同一工作流会话里一次生成完，
否则风格必漂。建议先用 IP-Adapter + 2–3 张参考图固定形象。

#### 先定画风，再动手

引擎默认的样子是程序化绘制的扁平几何体。**在这个状态下，实物素材无论做得多精确，
放进去都会像"一张照片贴在简笔画旁边"。** 所以第一步是选方向：

| 方向 | 实物怎么进来 | 代价 |
|---|---|---|
| **照片拼贴 / 回忆相册**（推荐先考虑） | 照片直接用，套拍立得框 + 统一色调 | 几乎为零 |
| 扁平插画 | 照片 → AI 风格化 / 矢量化 | 风格统一最难 |
| 3D 卡通渲染 | 扫描 → Blender toon shader → 渲成 2D | 要学 Blender |

对生日礼物来说，"照片直接用"往往情感强度更高，而且**整个 3D 扫描问题直接消失**。

#### 实物怎么进来（三条路线）

1. **照片 → AI 风格化**：GPT 类模型**定风格锚**，ComfyUI + IP-Adapter + ControlNet
   **批量锁风格**。关键分工是"用它定风格，别用它做批量"——它没法固定 seed，
   做 10 张风格会散，还会悄悄改动物体形状。
2. **3D 扫描 → 卡通渲染**：Polycam / KIRI / RealityScan 扫描，Blender toon shader
   渲成转台帧。**只在物件需要转起来时才值得**，且扫描只省了建模、没省风格化。
3. **照片 → 矢量描摹**：Inkscape 图像描摹 → 删到 6–8 个色 → 换调色板。
   对"不会画画 + 想要扁平风格"性价比常常最高。

> **完整版见 [ART-GUIDE.md](ART-GUIDE.md)** —— 风格决策、AI 工具的能力边界、
> 装什么软件、完整工作流、物件怎么"动起来"（四档方案）、以及常见坑。

### 录音

```bash
npm run script:export    # 导出台词表，按 line_id 命名录音文件
# 录音 → public/assets/audio/vo/<line_id>.m4a
npm run vo:check         # 查缺
npm run vo:check -- --strict   # 上线前：缺一句就失败
```

后期链建议：Audacity 轻度降噪 → 高通 80Hz → 压缩 3:1 → 响度归一 **-16 LUFS** → 单声道 44.1kHz。

**一句一文件**，方便重录与字幕同步。尽量一次录完所有台词再统一后期，避免批次音色不一致。

### 字体子集化（必做）

中文字体全字库 3–8MB，直接进首包会毁掉加载体验。先子集化再放 `public/fonts/`：

```bash
pip install fonttools brotli
pyftsubset LXGWWenKai-Regular.ttf \
  --text-file=content/voice-lines.csv \
  --flavor=woff2 --output-file=public/fonts/lxgw-wenkai-subset.woff2
```

然后在 `src/styles.css` 里 `@font-face` 引用它。

---

## 角色

引擎不知道角色长什么样，只认 `ActorRenderer` 接口。场景里写 `"renderer": "partRig"` 即可切换。

| renderer | 素材要求 | 说明 |
|---|---|---|
| `partRig` | **无**，或一套部件图 | 默认。一套部件支持任意方向、任意速度，**永不滑步** |
| `glide` | 一张立绘 | 伪行走：滑行 + 起伏 + 倾斜。素材缺失时自动退到 partRig |
| `spriteSheet` | 精灵表 + 图集 | 你已有逐帧素材时用。**注意**：帧序列无法严格不滑步 |

想接入 Rive / Spine 或完全自定义，实现 `ActorRenderer` 再 `registerActorRenderer()` 一行即可。

### 换成你自己的部件图

默认的 `partRig` 是程序化绘制的简笔小人。要换成你自己的画风，
**不用写代码** —— 按固定部件名出图，配一份图集即可：

```jsonc
// public/assets/rig/hero.json
{
  "parts": {
    "head":   { "image": "rig/head.png",   "pivot": [0.5, 0.5], "offset": [0, 0], "height": 0.22 },
    "torso":  { "image": "rig/torso.png",  "pivot": [0.5, 1.0], "offset": [0, 0], "height": 0.32 },
    "leg_upper_l": { "image": "rig/thigh.png", "pivot": [0.5, 0.0], "offset": [0, 0], "height": 0.26 }
  }
}
```

```jsonc
// content/scenes/start.json 里
"actors": [{ "id": "hero", "renderer": "partRig", "parts": "rig/hero.json", … }]
```

- `pivot` 是"关节在这张图内的位置"（0..1）。四肢用 `[0.5, 0]` 或 `[0.5, 1]`，
  头用 `[0.5, 0.5]`
- `height` 是部件在**身高比例**下的高度，和骨架尺寸同一套单位
- **缺哪个部件就哪个部件回落程序化绘制**，所以可以逐个替换、不用一次做完
- 部件名清单见 `src/schema/rig.ts` 的 `PART_NAMES`；写错名字 `content:check`
  会在构建期报错（运行期只会静默回落，很难发现）

### 为什么 partRig 不滑步

```
phase += 2π · 走过距离 / 步幅
```

相位由**位移**驱动，不是由时间驱动。走得快腿摆得快，走得慢自然变慢 ——
这是逐帧精灵表做不到的。E2E 里有一条测试专门守着这个性质：
角色停下后相位必须完全冻结。

---

## 场景编辑器（`/edit`）

手写归一化坐标不可持续，所以编辑器是必要工程。它能做：

- 拖四个角点标定地面，实时预览投影网格
- 画笔涂可行走 / 阻挡
- 拖框创建热点，填条件、走位点、可接受物品
- 拖身高标尺标定角色大小
- 列出缺失素材
- 导出通过 Zod 校验的完整场景 JSON

导出的 JSON 覆盖 `content/scenes/<id>.json` 即可。

---

## 测试

```bash
npm test                  # 172 项单测：单应变换、A*、路径平滑、精灵表选帧、部件图集、音频竞态、
                          #   交互解析、存档迁移、场景规范化、手势状态机、任务取消、项目清单
npm run test:e2e          # 118 项端到端（iPhone 14 横屏 + 竖屏引导 + 桌面，生产构建）
npm run test:e2e:editor   # 8 项开发期检查（编辑器 + StrictMode 泄漏）
```

端到端测试跑的是**生产构建产物**，覆盖：启动无报错、点哪走哪、到位收敛、
相位不滑步、姿态平滑进出、转身、障碍吸附、物件触发、条件驱动、
完整链路（查看→拿钥匙→用钥匙开门→出口切场景）、小游戏容器、
布局（角色不被对话框盖住、台词不被裁）、性能、存档续玩。

**横屏适配**另有 20 项专测：竖屏引导与暂停、场景不伸到面板底下、场景占屏比、
四边安全区（用 CSS 变量模拟刘海）、面板留白、HUD 不压刘海。

**交互层**另有 23 项专测：walk / focus 两种模式、物件状态切换与跨场景保持、
同名角色不串位、物件隐藏后点不到、事件桥写入 `last_event`、拖放开门、
拖到不接受的目标上不触发、悬停光标随物件变化、拖拽高亮跟随指针、
指针离开取消拖拽、内容版本对不上时给提示、存档场景已删时退回起始场景、
选项渲染成真正的按钮并点得动、选项显示时不误触场景交互。

另有一份截图测试把画面存到 `screenshots/` 供人工确认 ——
对话框掉进 flex 流被顶到左上角那类布局事故，只有截图能抓到。

`npm run test:e2e:editor` 跑在 **dev server** 上，覆盖编辑器本身，
外加一类只在开发期存在的问题：React StrictMode 会 mount → cleanup → mount，
而 `start()` 里有多个 await，只要漏掉一次销毁就会有两个引擎实例同时绘制同一块画布。
`Game.liveInstances` 就是为这个自检加的。

### 性能

`tests/e2e/game.spec.ts` 里有一条微基准，实测 `update + render` 的 JS 侧耗时：

```
[perf] update+render 平均 0.02 ms/帧
```

60fps 的预算是 16.7ms，也就是约 **750 倍余量**。所以引擎里那些每帧的小对象分配
（绘制项数组、闭包）完全没有优化的必要 —— 数字说话，不做投机优化。

需要说明的是：这个数字量的是 **JS 侧命令提交**，不含 GPU 栅格化。
但从绘制命令的量级看（1 次全屏 blit + 十几次 stroke），栅格化不可能成为瓶颈。

### 构建产物

```
react   68.3 kB gzip   react + react-dom + scheduler
ink     31.3 kB gzip   inkjs
app     33.2 kB gzip   你的代码
audio    9.6 kB gzip   howler
css      2.4 kB gzip
──────────────────────
总计   144.6 kB gzip
```

依赖被拆成独立 chunk（见 `vite.config.ts` 的 `manualChunks`）。好处是**你改剧情
重建时，react/ink/audio 的哈希不变** —— 回访的玩家只重新下载 33 kB 的 app chunk，
而不是整个 145 kB。

有两条纪律守住了这个体积：

1. **`npm run build` 先跑 `content:check`。** 内容是构建期校验的常量，
   所以运行时不需要再背 26 kB 的 Zod 去做同一件事。
   代价是默认值填充必须自己来 —— 见 `scene.rules.ts` 的 `normalizeScene`，
   以及 `tests/normalize.test.ts` 里那条"规范化结果必须与 Zod 解析结果深相等"的测试。
2. **编辑器必须用动态 `import()`。** 静态 import 时，即使渲染被 `import.meta.env.DEV`
   挡住，打包器也只摇得掉编辑器自身的代码，摇不掉它的依赖链
   （Editor → scene.ts → zod）。这个坑真的踩过：生产首包白背 26 kB，
   而所有"编辑器代码在不在包里"的字符串检查都查不出来，因为编辑器代码确实被摇掉了。

---

## 界面布局：底部预留区

场景只在**对话框之上**的区域里 letterbox，所以角色走到房间最前排也不会被
对话框盖住 —— 而这个游戏的看点就是看角色走动。

预留高度由 CSS 变量 `--dialogue-band` 决定（`src/styles.css`），
引擎读的是它的 `min-height`：

- 定小了会把台词裁掉，定大了会白白压扁场景。当前值按"最常见的三行长句"取的
- 长台词允许对话框向上生长、略微压住场景，但**绝不裁字、也不让玩家滚动读台词**
- 竖屏手机上场景本来受宽度限制，预留这块几乎不损失画面

要调就改 `--dialogue-band`，`tests/e2e/game.spec.ts` 的"布局"两条测试会守住底线。

---

## 部署

```bash
docker compose up -d --build
# 映射到 724 端口，访问 http://<你的IP>:724
# 想换端口：HB_PORT=8080 docker compose up -d --build
```

> ⚠️ 724 是特权端口（< 1024）。dockerd 以 root 运行时能正常绑定；
> rootless Docker 需要换到 1024 以上，或给 dockerd 加 `CAP_NET_BIND_SERVICE`。

> ⚠️ 云服务器的**安全组 / 防火墙**默认只放行 22 和 80，记得手动放行 724 的
> TCP 入站，否则容器起来了外面也连不上。

需要 HTTPS：

```bash
docker compose --profile tls up -d
# 先改 docker/Caddyfile 里的域名与邮箱
```

### ⚠️ 国内服务器的真实约束

**未备案域名访问 80/443 会被阻断。** 三个选择：

1. **IP + 非标端口**（当前方案，`:724`）—— 能玩，但没有 HTTPS，
   Service Worker / 离线能力失效
2. **已备案域名 + Caddy 自动证书** —— 体验最好
3. 香港 / 境外 VPS —— 免备案

### 缓存策略

`docker/nginx.conf` 里分三档：

- `/_bundle/` 构建产物带内容哈希 → 永久缓存
- `/assets/` 你自己的素材没有哈希 → 每次校验（ETag 304，几乎不耗流量）
- `/` 入口 HTML → 不缓存，否则发新版玩家还在跑旧的

构建产物因此被放到 `_bundle/`（见 `vite.config.ts`）—— 默认的 `assets/`
会和 `public/assets/` 撞在同一个目录里，而两者的缓存策略必须相反。

---

## 小游戏

引擎提供**容器**：挂载、生命周期、统一的失败/跳过策略、结果回收。
玩法本身由你写。

```ink
# minigame: tapSequence(3)
```

结束后结果写回 ink 变量 `minigame_success` / `minigame_skipped`，剧本据此分支：

```ink
{ minigame_skipped: 你跳过了。| { minigame_success: 你记住了顺序。| 差了一点。} }
```

写一个新小游戏：实现 `MiniGame` 接口（`src/minigames/types.ts`）+ `registerMiniGame()` 一行。
现成的参考实现是 `src/minigames/tapSequence.ts`（记住并复现亮灯顺序）。

**硬约束**：失败满 3 次后引擎会给出"跳过"入口，跳过不影响结局 —— 生日礼物不能卡关。

---

## 已知边界

- **首包预算 3MB**：目前 JS/CSS 约 0.2MB（gzip 160KB），素材加进来后要盯住
  `npm run assets:manifest` 的输出
- **后端默认不做**：纯静态 + localStorage 存档。要做云存档或结局卡，再加 Hono + SQLite
- 场景 `layers` 目前按"整帧透明 PNG"处理；需要局部定位的家具再扩展
- `spriteSheet` 渲染器对逐帧素材**无法保证不滑步**（帧序列天然做不到），
  对滑步敏感就继续用默认的 `partRig`

---

## 许可与素材登记

上线前把每一份素材的来源与许可填进 [CREDITS.md](CREDITS.md)。
代码依赖全部为 MIT；字体建议思源宋体或霞鹜文楷（均为 SIL OFL）。
