# 酒馆角色扮演与情绪羁绊插件

入口：管理后台「插件 → 酒馆角色扮演」（对应 [TavernPanel.vue](../frontend/src/components/TavernPanel.vue)），或直接在已授权群聊 / 私聊发送 `/` 或 `#` 前缀指令（如 `/酒馆 帮助`）。

插件默认关闭。开启后，机器人优先采用酒馆角色卡、内嵌世界书（Lorebook）、五维情绪状态与阈值触发规则构建对话提示词，按角色卡独立隔离会话记忆，并支持分群 / 私聊专属角色绑定、群内羁绊排行榜、投喂互动、双人小剧场及分角色定时问候。

---

## 一、启用条件与模型前提

酒馆对话与指令的生效前提如下：

1. **总开关与白名单**：后台「运行概览」已启用机器人，`allowedGroups`（群聊）或私聊白名单 `allowedPrivateUsers` 已放行目标会话。
2. **酒馆模式激活**：在「插件 → 酒馆角色扮演」启用「酒馆功能模式」（`tavern.enabled = true`），或在人设配置中将 `personaMode` 设为 `tavern`。
3. **模型与参数来源**：角色对话、`/投喂`、`/剧场` 与酒馆定时问候均复用「模型与回复」当前激活的模型配置（API Key、主模型、温度、最大输出 Token 等）。关闭 AI 回复能力的群不会触发角色对话。
4. **图形输出依赖**：`/情绪` 档案卡片（820×520 PNG）、`/酒馆 帮助`（1080×2440 PNG）与 `/酒馆 文档`（PDF）依赖服务端 Chromium；若宿主机缺少 Chromium，`/情绪` 仍发送完整文字指标摘要，`/酒馆 帮助` 与 `/酒馆 文档` 会返回降级提示。

---

## 二、角色卡规范、宏替换与世界书

### 1. 支持格式与字段上限

角色导入与编辑由 [src/tavern/card-parser.mjs](../src/tavern/card-parser.mjs) 处理：

| 格式 | 解析方式 | 说明与限制 |
| --- | --- | --- |
| **PNG 角色卡** | 读取 PNG `tEXt` / `iTXt` 中的 `chara` 数据块（Base64 编码的 UTF-8 JSON，亦兼容直接 JSON 文本） | 仅识别 `chara` 关键字（不读取未转化的纯 `ccv3` 块）；上传成功时原 PNG 直接保存为角色头像 `data/tavern/avatars/<id>.png` |
| **JSON 角色卡** | 支持 TavernAI V1 扁平结构及 SillyTavern V2（`spec: "chara_card_v2"` + `data` 字段） | 后台单次上传请求上限 `15 MiB`，单卡编辑 `PUT` 请求上限 `2 MiB` |

规范化字段截断上限：`name` 120 字符；核心文本域（`description`、`personality`、`scenario`、`first_mes`、`mes_example`、`system_prompt`、`post_history_instructions`）各 16,000 字符；`creator_notes` 8,000 字符；`alternate_greetings` 最多 20 条（每条 4,000 字符）；`tags` 最多 50 个；内嵌世界书 `character_book.entries` 最多 200 条（单条正文 8,000 字符、主/次关键词各 50 个）。

### 2. 宏替换与 Prompt 组装机制

[src/tavern/prompt-assembler.mjs](../src/tavern/prompt-assembler.mjs) 在开场白输出、每轮对话及触发提示注入前统一执行不区分大小写的宏替换：

- `{{char}}`、`<BOT>`、`<CHAR>` → 当前角色名称
- `{{user}}`、`<USER>` → 当前发言群友昵称（或私聊用户昵称）
- `{{input}}`、`{{scenario}}`、`{{personality}}`、`{{description}}` → 对应上下文或角色卡字段

System Prompt 总长度上限为 `32,000` 字符，按固定优先级顺序拼接：核心沉浸协议 → 角色 `system_prompt` → 当前五维情绪状态、`[[TAVERN_EMOTION:...]]` 更新协议及命中的触发器 `promptHint` → 世界书前置条目（`before_char`） → 外貌背景 / 性格 / 场景设定 → 世界书后置条目（`after_char`，若不存在且无前置条目则兜底包含其余条目） → 对话示例 `mes_example` → 当前 `/ooc` 临时导演指令。

当历史对话为空且卡片包含 `first_mes` 时，会自动将替换宏后的 `first_mes` 作为首条 `assistant` 消息注入上下文；`post_history_instructions`（最多 `4,000` 字符）作为独立 `system` 消息追加在历史轮次最末尾，用于强化当轮句式与口吻。

### 3. 世界书（Lorebook）激活规则

[src/tavern/lorebook.mjs](../src/tavern/lorebook.mjs) 对卡片内嵌的 `character_book.entries` 进行扫描（取**当前提问 + 最近 6 条历史消息**拼接小写文本）：

1. 仅处理 `enabled !== false` 且正文非空的条目。
2. `constant === true` 为常驻设定，无需关键词即激活。
3. 非常驻条目要求**主关键词**（`keys`，逗号或数组分隔）满足**任意命中（OR）**；若同时填写了**次级关键词**（`secondaryKeys` / `secondary_keys`），则需次级关键词同样**任意命中（AND 联合）**。
4. 命中的条目按 `order`（或 `insertion_order`）升序排列，并按 `position`（`before_char` / `after_char` / `depth`）注入。

---

## 三、多级绑定与会话记忆隔离

### 1. 角色解析优先级

`TavernManager.getActiveCharacter(scope)` 按以下顺序决定当前会话使用的角色卡：

1. **私聊用户专属绑定**（`userBindings[userId]`，仅私聊会话生效）
2. **群聊专属绑定**（`groupBindings[groupId]`，仅群聊会话生效）
3. **全局默认角色**（`defaultCharacterId`）
4. **兜底角色**：若上述绑定缺失或对应角色已被删除，自动回退至角色列表中的第一张卡片。

### 2. 上下文隔离与重置策略

- **按角色隔离记忆**：[src/bot.mjs](../src/bot.mjs) 通过 `resolveTavernContext` 将会话上下文键设为 `tavern:<charId>`。同一群聊切换不同角色后，新角色不会读取旧角色的聊天历史，切回原角色时各自的会话彼此不串线。
- **`/酒馆 切换 <角色名>` 行为**：更新当前群（或私聊用户）的角色绑定，同时重置**发起切换指令成员本人**的会话历史、清空目标角色在当前作用域的好感度与待生效 `/ooc` 指令，随后发送带角色头像（若有）的宏替换后开场白 `first_mes`。
- **`/酒馆 重置` 行为**：清空发起者当前会话、重置当前角色在该作用域的情绪指标（`group` 共享模式下同时清理同群成员个人历史好感记录）与待生效 `/ooc`，并重新发送开场白与头像。

---

## 四、五维情绪羁绊、触发表情包与互动玩法

### 1. 五项情绪指标与关系阶段

每组 `<characterId>:<scopeKey>` 维护五个 `0–100` 整数指标（定义于 [src/tavern/emotions.mjs](../src/tavern/emotions.mjs)）：

| 指标键名 | 中文名称 | 默认初始值 | 语义说明 |
| --- | --- | --- | --- |
| `affection` | 好感度 | `50` | 决定角色与当前会话对象的亲近程度及关系阶段 |
| `joy` | 愉悦度 | `60` | 心境明朗程度，高时轻快，低时偏安静 |
| `trust` | 信任度 | `50` | 角色是否愿意卸下防备、吐露真实想法 |
| `tension` | 紧张度 | `20` | 压迫感或戒备度，偏高时容易警惕疏离 |
| `depression` | 抑郁值 | `15` | 积压的失落、孤单或低落情绪 |

**关系阶段划分**（由 `affection` 决定）：`0–19` 疏离戒备 · `20–39` 礼貌客套 · `40–59` 普通熟人 · `60–79` 亲近信赖 · `80–100` 深度羁绊。

每次日常对话与 `/投喂` 互动时，大模型会在回复末尾输出隐藏标记 `[[TAVERN_EMOTION:{...}]]`，单轮每项数值增减量强制限幅在 **`-10` 至 `+10`** 之间；`PromptAssembler.extractEmotionUpdate` 负责完整剥离该标签后再发送至 QQ（兼容换行与多余空格），同时压入最多 **10 轮历史情绪快照**供 `/撤回` 与 `/重试` 同步回滚。

### 2. 群聊好感度作用域模式

管理员可在后台「酒馆功能模式」旁切换 `emotionScopeMode`：

- **`group`（全群共享，默认）**：全群共用一份情绪状态，键为 `group:<groupId>`。
- **`group-member`（群内个人独立）**：群内每位成员与角色各自独立积累羁绊，键为 `group:<groupId>:user:<userId>`，开启此模式后可使用 `/羁绊榜` 查看群内好感度前 10 名排行。
- **私聊会话**：始终独立按用户计算，键为 `private:<userId>`。

### 3. 情绪阈值触发规则与自定义表情包

管理员可在后台选中角色 →「情绪与关系指标」配置最多 **20 条**触发规则（或一键导入 3 套内置模板：`深度羁绊 · 专属口癖` `affection >= 80`、`隐藏心事 · 剧情彩蛋` `depression >= 60`、`戒备防线 · 疏离反应` `tension >= 65`）：

- **条件匹配**：支持任一指标 `>=` 或 `<=` 阈值（`0–100`），启用规则命中后自动将其 `promptHint`（上限 400 字符，支持宏替换）注入 System Prompt。
- **表情贴纸发送与冷却**：每条规则可上传 1 张表情包，经魔数与像素校验，支持 `PNG`、`JPEG`、`GIF`、`WebP`，单文件上限 `4 MiB`（接口 JSON Base64 请求上限 `6 MiB`），最大像素 `4000 万`。命中带有表情包的规则且距离上次发送达到设定冷却轮数（`1–20` 轮，默认 `3`）时，机器人将在回复正文后附带发送该图片。
- **文件清理**：替换或移除触发器贴纸、删除规则或删除角色卡时，对应存放在 `data/tavern/stickers/` 的孤儿贴纸文件会自动清理。

### 4. `/情绪`、`/羁绊榜`、`/投喂` 与 `/剧场`

- **`/情绪`（`/档案`、`/emotion`、`/酒馆 状态`）**：使用 `CardRenderer`（[src/fun/card-templates.mjs](../src/fun/card-templates.mjs)）生成 `820×520` 深色五维雷达档案卡 PNG，并附带完整 ASCII 进度条与心境原因摘要。
- **`/羁绊榜`（`/好感榜`、`/酒馆 leaderboard`）**：在 `group-member` 模式下展示本群好感度前 10 名；在 `group` 共享模式下展示当前全群共享数值并提示管理员如何开启个人榜；在私聊中返回当前私聊好感度。
- **`/投喂 <礼物名>`**：读取礼物名（最多 60 字符），调用 `PromptAssembler.assembleFeedMessages` 生成符合人设的反应与情绪变动（未连模型或失败时优雅降级为本地温柔回复），同步更新好感并触发符合条件的表情包。
- **`/剧场 [<角色A> <角色B>] [主题]`**：要求角色库至少有 **2 张**角色卡；未指定两名不同角色时自动选取当前活跃角色与列表下一位角色、默认主题「偶遇在深夜食堂」（主题最多 80 字符），生成 4–6 回合、450 字以内的跨角色小剧场对话。

---

## 五、定时主动问候与娱乐插件联动

- **分角色定时主动问候**：开启定时主动群聊后，[src/scheduled-chat.mjs](../src/scheduled-chat.mjs) 若检测到酒馆已启用，会按每个授权群当前绑定的角色分组批处理，通过 `PromptAssembler.assembleProactiveGreeting` 生成符合当前角色性格、身份细节与当前心境的北京时间问候（每条 ≤ 180 字符，不超过 `maxReplyLength`，且不改动对话情绪数值）。
- **跑团骰娘吐槽联动**：当酒馆开启且娱乐插件启用 `diceTavernComment` 时，群友在群内掷骰（如 `.r` / `.ra` / `.rh`）会由当前绑定角色附带生成一句 ≤ 30 字的人设短评。

---

## 六、完整聊天指令速查表

> 所有指令**必须以 `/` 或 `#` 开头**（[src/tavern/commands.mjs](../src/tavern/commands.mjs) `parseTavernCommand`），纯文本不拦截；且含非当前机器人的 `@` 或图片等富媒体消息不会被当作指令截获。
> **停用态隔离**：当酒馆模式关闭时，只有 `/酒馆`、`/tavern`、`/char`、`/角色` 类显式指令会回复「酒馆角色扮演模式当前未启用」提示；`/undo`、`/retry`、`/ooc`、`/情绪`、`/投喂` 等独立快捷命令保持静默放行，不干扰正常聊天或其它插件。

| 主指令 | 常用别名 | 作用与行为说明 |
| --- | --- | --- |
| `/酒馆 帮助` | `/酒馆`、`/tavern`、`/char help` | 发送 1080×2440 离线渲染的酒馆帮助长图海报 |
| `/酒馆 文档` | `/酒馆 doc`、`/tavern doc`、`/char doc` | 生成并上传《酒馆角色扮演使用说明.pdf》 |
| `/酒馆 列表` | `/char`、`/char list`、`/角色 列表` | 列出所有角色卡及当前激活标记与 8 位 ID 前缀 |
| `/酒馆 信息` | `/char info`、`/角色 信息` | 展示当前角色头像、简介、性格与情景 |
| `/酒馆 切换 <名称或ID前缀>` | `/char switch`、`/角色 切换` | 切换当前群 / 私聊绑定角色，重置发起者记忆并发送开场白 |
| `/酒馆 重置` | `/char reset`、`/角色 重置` | 清空当前记忆、情绪与待生效 `/ooc`，重发开场白 |
| `/酒馆 撤回` | `/undo`、`/撤回` | 撤回上一轮机器人的回复记录并回滚 1 轮情绪快照 |
| `/酒馆 重试` | `/retry`、`/重试` | 回滚上一轮对话与情绪并自动将原提问重新入队生成 |
| `/ooc <导演指令>` | `/酒馆 ooc <指令>` | 设置下轮场外指导（最多 500 字符，持久化保存，下轮回复后自动消费清除） |
| `/ooc 清除` | `/ooc clear`、`/ooc off`、`/ooc 关闭`、`/酒馆 ooc` | 取消当前待生效的场外导演指令；单独发送 `/ooc` 可查看当前指令与用法 |
| `/情绪` | `/档案`、`/emotion`、`/酒馆 状态`、`/char status` | 发送五维情绪雷达卡片图与关系阶段文字摘要 |
| `/羁绊榜` | `/好感榜`、`/酒馆 羁绊榜`、`/酒馆 leaderboard`、`/酒馆 rank` | 查看群内成员好感度 Top 10（需后台开启个人独立模式） |
| `/投喂 <礼物>` | `/feed <礼物>`、`/酒馆 投喂` | 向角色赠送物品，触发专属反馈、好感变化与表情包 |
| `/剧场 [<角色A> <角色B>] [主题]` | `/小剧场`、`/theater`、`/酒馆 剧场` | 让两张角色卡围绕指定主题进行 4–6 回合对戏 |

---

## 七、REST API 与数据存储说明

### 1. 管理接口（均需管理员 Cookie 鉴权；写操作校验同源 / `X-Admin-Request`）

| 方法与路径 | 用途 |
| --- | --- |
| `GET` / `PUT /api/tavern/config` | 读取或更新 `enabled`、`defaultCharacterId`、`emotionScopeMode`、`groupBindings`、`userBindings`、`characterParams` |
| `GET /api/tavern/characters` | 列出已导入角色卡摘要 |
| `POST /api/tavern/characters/upload` | 导入 PNG（base64 或二进制）或 JSON 角色卡，上限 15 MiB |
| `GET` / `PUT` / `DELETE /api/tavern/characters/:id` | 读取、规范化保存或删除指定角色卡（同时级联清理绑定、头像、情绪与贴纸） |
| `GET /api/tavern/characters/:id/avatar` | 获取角色 PNG 头像 |
| `GET /api/tavern/characters/:id/emotions` | 查询角色指标定义、默认状态、活跃会话情绪、触发规则与预设模板 |
| `POST /api/tavern/characters/:id/emotions/reset` | 重置指定 `scopeKey` 或该角色全部会话情绪 |
| `PUT /api/tavern/characters/:id/triggers` | 整体保存角色情绪触发规则（最多 20 条，自动回收未使用贴纸） |
| `POST` / `DELETE /api/tavern/characters/:id/triggers/:ruleId/sticker` | 上传（≤ 4 MiB）或移除指定规则关联的表情包 |
| `GET /api/tavern/stickers/:filename` | 在后台预览已上传的情绪触发贴纸 |

### 2. 数据目录与可靠性保障

所有运行时数据均落在 `DATA_DIR/tavern/`（默认 `data/tavern/`，目录权限 `0700`，严禁纳入 Git）：

```text
data/tavern/
├── config.json              # 总开关、好感模式、默认/分群/私聊绑定、触发规则与 pendingOocNotes
├── emotions.json            # 五维情绪活跃值及最多 10 轮历史回滚快照
├── characters/<id>.json     # 规范化后的角色卡正文与内嵌世界书
├── avatars/<id>.png         # PNG 卡提取的原图头像
└── stickers/<id>-<rule>.*   # 情绪触发器绑定的自定义表情包图片
```

- **损坏隔离与防篡改**：`config.json` 与 `emotions.json` 均使用原子写入；若手动修改 JSON 导致格式损坏，启动时通过 `quarantineCorruptFile` 自动备份为 `.corrupt.<timestamp>` 并记录警告日志后恢复默认值，防止服务崩溃。
- **符号链接与路径校验**：角色卡、配置、情绪及贴纸路径全部拒绝符号链接，角色 ID 与规则 ID 严格限制为 `[a-zA-Z0-9_-]{1,64}`，群号与 QQ 号要求 5–20 位纯数字。
- **备份提示**：迁移或重装前请完整备份 `data/`（或使用 `npm run backup` 加密备份）；若仅保留角色卡本身，可通过后台或接口重新上传 PNG/JSON 恢复。
