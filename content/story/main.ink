// ============================================================================
// 占位剧本 —— 只用来验证引擎链路是否打通，不是正式剧情。
// 你写正式剧情时可以直接替换本文件，引擎不需要任何改动。
//
// 四条必须遵守的契约：
//   1. 条件（hotspot.visibleWhen / exit.when）必须写成 `=== function xxx() ===`。
//      inkjs 的 EvaluateFunction 只认函数，读变量会直接报错。
//   2. 交互 knot 演完后引擎会自动回到场景 JSON 里的 hub，不用自己写返回。
//   3. 标签可以单独占一行。此时不显示对话框，只执行演出指令。
//   4. 配音靠 `# vo: line_042` 显式指定 id，不要用行号或哈希 ——
//      那样你改一个字、插一行，录好的音频就全对不上了。
//      写完后运行 npm run script:export 导出台词表，运行 npm run vo:check 查缺。
// ============================================================================

VAR has_key = false
VAR door_unlocked = false
VAR looked_shelf = 0
// 小游戏结果由引擎写回，剧本只负责据此分支 —— 逻辑真相源仍然只有 ink
VAR minigame_success = false
VAR minigame_skipped = false
// 事件桥写进来的"最近发生了什么"。每次交互引擎都会更新它，于是可以写
//   { last_event == "shelf_searched": ... }
// 让同一段台词按来由分支。不声明也能跑，只是剧本读不到它。
VAR last_event = ""

-> start

// ── 条件函数：必须用 function 声明 ──────────────────────────────────────────
=== function can_take_key() ===
~ return looked_shelf > 0 && has_key == false

=== function is_door_unlocked() ===
~ return door_unlocked

// ── 场景一 ─────────────────────────────────────────────────────────────────
=== start ===
~ has_key = false
~ door_unlocked = false
~ looked_shelf = 0
# bg: none
# bgm: none
# speaker: 旁白
这是一个占位场景，用来验证引擎：点击地面会让角色走过去，点击物件会触发剧情。 # vo: line_001
-> hub

=== hub ===
-> DONE

=== look_room ===
# speaker: 旁白
房间的中央有一张矮桌，墙角立着一个书架。 # vo: line_002
-> DONE

=== look_shelf ===
~ looked_shelf = looked_shelf + 1
# speaker: 旁白
书架的格子里躺着一把钥匙。 # vo: line_003
# sfx: sfx/rustle.ogg
-> DONE

=== take_key ===
~ has_key = true
# speaker: 旁白
你拿起钥匙，它在手里凉凉的。 # vo: line_004
# award: item_key
# sfx: sfx/pickup.ogg
-> DONE

=== look_window ===
# speaker: 旁白
窗外没有风景，只有引擎渲染出来的一片渐变 —— 因为你还没放背景图。 # vo: line_005
-> DONE

=== try_door ===
# speaker: 旁白
门锁着。需要找到钥匙。 # vo: line_006
-> DONE

=== use_key_door ===
~ door_unlocked = true
# speaker: 旁白
钥匙转动了半圈，锁开了。 # vo: line_007
# fx: shake(0.25)
# sfx: sfx/unlock.ogg
-> DONE

// 场景切换演示：出口指向这个 knot 而不是直接指向场景 id，
// 于是切换前还能说一句话。# scene: 与文字在同一行 ——
// 引擎会先把这句话显示出来，等玩家推进后再切场景。
=== go_hall ===
# speaker: 旁白
你推开门，走廊里的空气凉了下来。 # vo: line_012 # scene: hall
-> DONE

// ── 场景二 ─────────────────────────────────────────────────────────────────
=== hall ===
# bg: none
# bgm: none
# speaker: 旁白
这里是第二个占位场景。点地面让角色走动，开调试面板可以看到寻路网格。 # vo: line_008
-> hub

=== look_hall_mark ===
# speaker: 旁白
墙上有一道浅浅的印记，像是有人在这里量过身高。 # vo: line_009
-> DONE

// 长按演示：同一个物件，点一下和按住不放走的是不同分支。
// 触发器由手势状态机判定（默认按住 500ms），内容不需要关心时间。
=== hold_hall_mark ===
# speaker: 旁白
你把手指停在那道印记上，忽然想起小时候也是这样被量着长高的。
-> DONE

// ── 小游戏容器演示 ─────────────────────────────────────────────────────────
// 这一段用来证明容器是通的：剧情在这里挂起，小游戏结束后结果写回 ink，
// 剧本再根据 minigame_success / minigame_skipped 分支。
=== demo_minigame ===
~ minigame_success = false
~ minigame_skipped = false
# speaker: 旁白
来试一下小游戏容器。剧情会在这里挂起，结束后把结果写回 ink。 # vo: line_010
# minigame: tapSequence(3)
{ minigame_skipped: 你跳过了这一关，没关系。| { minigame_success: 你记住了顺序。| 差了一点，不过不影响继续。} } # vo: line_011
-> DONE

// ── focus 模式示例 ─────────────────────────────────────────────────────────
// 固定镜头特写：没有地面、没有角色，只有一堆能点的物件。
// 交互叙事里大量场景其实长这样（桌面、手机屏幕、信件、相册），
// 套用"角色走过去"反而是负担。
//
// 下面这段同时演示事件桥：物件点过之后引擎会把 last_event 写成对应事件名，
// 于是同一段台词可以按"是因为什么来的"分支。
=== go_memory_table ===
# scene: memory_table
-> DONE

=== focus_table ===
# bg: none
# bgm: none
# speaker: 旁白
桌面上摊着几样东西。镜头没有动，你可以慢慢看。 # vo: line_013
-> hub

=== focus_frame ===
# speaker: 旁白
相框里的照片有些褪色了。 # vo: line_014
{ last_event == "frame_opened": 你把它打开了一点。| }
-> DONE

=== focus_music_box ===
# speaker: 旁白
八音盒上了发条，转得很慢。 # vo: line_015
-> DONE

=== focus_letter ===
# speaker: 旁白
信纸折了三折，边角有些起毛。 # vo: line_016
-> DONE

// ── 选项演示 ───────────────────────────────────────────────────────────────
// 用来证明选项这条链路是通的：ink 给出选项 → React 渲染成按钮 → 点击 → 回到 ink。
//
// 这一段在占位剧本里是必要的：没有它，选项相关的代码（ChoiceList、onChoices、
// choose）就完全没有任何内容覆盖，而它是互动叙事最核心的交互之一。
//
// 选项被点掉之后剧情立刻继续，不需要再点一下对话框。
=== demo_choice ===
# speaker: 旁白
这里放一个选择，用来验证选项链路。
* [选左边]
    你选了左边。
    -> DONE
* [选右边]
    你选了右边。
    -> DONE
