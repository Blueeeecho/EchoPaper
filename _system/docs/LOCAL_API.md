# EchoPaper 本地 API 与 Codex 调用约定

EchoPaper 网页、Codex 与命令行使用同一份 `papers/<项目ID>/` 稿件。此接口用于读取项目、带版本保存文本、查询会议来源、设置截止时间以及发起编译。它不另建主稿，不直接编辑 `build/` 或 `submissions/`。

课题、目录连接、资料检索与整理、PPT 工程、生成任务及风格包新增接口见 [ACADEMIC_API.md](ACADEMIC_API.md)。命令入口保持 `node _system/scripts/echopaper.mjs help`，原有论文接口与显式编译约定继续有效。

## 写作台文件与目录

`POST /api/projects/:id/directories {path,expectedHash:null}` 在项目编辑区新建目录；`path` 相对项目根目录，可包含新的子目录。同名文件或目录返回 409，不合并或覆盖。隐藏目录、`build/`、`submissions/` 和项目配置受保护，符号链接不可穿越。新建文本仍使用 `PUT /api/projects/:id/file {path,content,expectedHash:null}`。

写作文件树支持将外部图片、文件拖入具体目录；拖到文件时使用该文件的父目录。选择目录后，新建文件、目录及上传按钮都使用该目标位置。上传沿用 `POST /api/projects/:id/upload?directory=...` multipart；同名文件不覆盖，多文件分别报告成功与失败，成功文件会立即进入文件树。上述操作不触发编译。

## AI 聊天、用量与连续性摘要

### 专用翻译服务（Bob 风格多来源）

`GET /api/translation-services` 返回公开预设、官方额度/申请链接和 `reviewedAt`。它不会创建账户、写入配置或查询真实剩余额度。

`GET /api/ai/providers` 仍返回全部服务、引擎与有序翻译来源。新增 kind：`siliconflow-translate`、`zhipu-translate`、`niutrans`、`baidu-translate`、`deepl`、`microsoft-translator`、`qwen-mt`。沿用 `POST /api/ai/providers/:id`，携带 `{expectedRevision,provider,models,key?}`；百度 provider 需 `appId`，Microsoft 可填 `region`。专用翻译引擎用 `contextWindow:0,reasoning:'none'` 标记“仅翻译”，并非上游窗口为零；它们不会进入 AI 聊天模型列表。传统机器翻译 model 为 `text-translation`，Qwen-MT 用 `qwen-mt-*`，硅基流动/智谱填写其真实模型 ID。`auth:'bearer'` 表示需保存凭据，真实出站认证方式由专用适配器决定。

沿用 `PUT /api/ai/translations {expectedRevision,sources,layout}` 保存来源、启用状态和顺序。配置冲突 409 时读取比较，不覆盖。密钥只在需要新增/更新时提供；读取和翻译无需取出密钥。注册表与备份只保留公开字段。

`POST /api/translation-services/translate`：

```json
{"projectId":"WWW","sourceId":"已有且启用的翻译来源ID","text":"Evidence supports this conclusion.","target":"zh-CN","source":"pdf","sourceLanguage":"en"}
```

`source` 为 `tex|pdf`，`sourceLanguage` 为 `auto|zh-CN|en`（缺省 auto），目标为 `zh-CN|en`，选区最多 6000 字符。返回 `{text,model,provider}`，无流式事件；不改正文、不编译、不附带其他文件。仅允许已配置并启用的专用来源，每服务串行、最多两路专用请求；超时 90 秒，关闭连接取消。上游限流、认证、额度、空结果或不完整结束均返回可读错误。`POST /api/ai/providers/:id/test {modelId}` 对专用服务调用一句翻译样例；无需 GET /models。

完整调研和申请要求见 [TRANSLATION_SERVICES.md](TRANSLATION_SERVICES.md)。

`GET /api/ai/config` 返回公开模型列表、上下文窗口、默认模型和 `autoCompactRatio:0.7`；不返回密钥。`POST /api/ai/chat` 请求体：`{projectId,model,effort?,messages:[{id?,role,content,reasoning_content?}],checkpoint?,contextUsage?,forceCompact?,context?:{path,content}}`。`role` 仅 user/assistant，最后一条必须为 user。建议稳定提供消息 ID；未提供时后台派生。可使用 `shared/ai-context.ts` 的 `chatMessages()` 将保存的消息和明确附件转换为请求材料。

回答不发送 `max_tokens`、`max_completion_tokens`，服务端可能仍有模型自身限制。单次传输最大 64 MB、最多 20000 条消息，不将字符数当作精确 token 数。超时为连续无数据 180 秒，每个流片段刷新计时，不限制持续输出的总时长；AbortController 可停止正常生成和摘要生成。每项目的同一模型服务串行，所有模型服务合计最多两个并发请求。

NDJSON 事件除原有 `delta {text}`、`done {model,usage?,reasoning_content,finishReason}`、`error {error}` 外，新增：

- `context {phase:'compacting',part?,total?}`：摘要进度。
- `compacted {checkpoint}`：新摘要已完整生成，调用方应保存此状态，同时保留全部原始消息；此事件后正常回答仍可能失败。
- `context {phase:'generating',estimatedTokens,contextWindow}`：有效输入准备完成，随后输出回答。

`checkpoint` 为 `{id,summary,throughMessageId,sourceFingerprint,messageCount,createdAt,model,beforeTokens,afterTokens,round}`。再次发送时仍提供原始消息和 checkpoint；后台核对已覆盖前缀的内容指纹和边界 ID，只在匹配时使用摘要替代前缀。历史变化导致失配时回到完整历史，按需重新压缩。指纹仅用于本地连续性缓存失效，不能作为认证或防篡改签名。

达到所选模型估算上下文窗口的 70% 时自动压缩；已过长的历史以有界分块增量总结，保留最新输入，通常保留最近约三轮。若单轮材料自身过大、摘要不完整或没有充分缩短，返回可理解的错误，不丢弃原始消息、不伪造成功；模型明确返回上下文超限时，在可压缩的前提下重试一次。`forceCompact:true` 可用于显式压缩验收或本机调用，同样不会删除原始记录，也会产生模型调用。

`GET/PUT /api/projects/:id/chats` 沿用 `expectedHash` 冲突保护，兼容旧 version 1 格式；会话增加可选 `contextState` 与 `contextUsage:{throughMessageId,fingerprint,checkpointId,model,tokens}`，后者是接口实际用量基准。后台仅保存允许字段。存储文件最大 128 MB，每条消息内容/思考最多 1600 万字符；浏览器存储空间不足时仍会尝试保存至本机文件并提示。完整导出包含原始消息与最新摘要。网页 `contextMeter()` 对有效历史、草稿及勾选附件估算，只有模型/摘要/前缀均匹配时才复用实际 usage。

对话历史分为“对话 / 已归档 / 回收站”。`PATCH /api/projects/:id/chats/:conversationId` 接收 `{action:"archive"|"delete"|"restore",expectedHash}`，返回完整 `{data,hash}`。先读取当前聊天 hash，409 时比较后再操作，不自动重试。删除为可恢复的移入回收站，归档和删除都保留原消息、输入草稿、会话 ID、任务上下文和操作审计；恢复后可继续原对话。文件修改不随对话状态撤销。没有活动对话时自动创建独立空白对话。

会话可选 `lifecycle:{state:"active"|"archived"|"deleted",revision,updatedAt}`，无此字段的旧会话视为 active。已有对话的生命周期只通过上述 PATCH 更新，revision 由服务端递增，与草稿的 updatedAt 独立；批量 PUT 保留磁盘上的生命周期及未包含的历史，旧窗口无法复活或抹除已删除记录。新导入的归档/删除记录（包括并发草稿恢复副本）保持隐藏，由服务端初始化 revision 和时间，不采用客户端提供的版本。正在执行、排队、停止中或等待决定的对话须先结束/停止，才能归档或删除。归档/回收站中的会话拒绝新接单、恢复任务和批准写入，显式撤销已应用修改仍可用。状态操作与接单共用项目锁，并受备份维护屏障约束。完整导出和备份包含归档与回收站。

CLI：`chat list <项目ID>` 读取对话及 hash；`chat archive|delete|restore <项目ID> <对话ID> --expected-hash <SHA256>` 修改状态。`/api/health.capabilities.chatLifecycle` 为 true 表示后台支持这些接口。

设计参考 [Codex 的开源上下文压缩与替换历史实现](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs)，在 Chat Completions 兼容接口上实现本工作台的摘要接续；未调用 OpenAI 压缩接口。MiniMax 参数依据 [官方 OpenAI 兼容接口文档](https://platform.minimax.cn/docs/api-reference/text-openai-api)。

## 模型服务配置 API

配置版本为 1，`GET /api/ai/providers` 返回 `{version,revision,providers,models,translations,translationLayout}`，只含公开参数和 `configured` 布尔状态，不返回密钥。`GET /api/ai/config` 的 `models` 为已启用模型，`PUT /api/ai/config {defaultModel}` 只切换聊天默认模型，不改变翻译来源。

| 接口 | 请求与用途 |
|---|---|
| `POST /api/ai/providers/:id` | `{expectedRevision,provider,models,key?}` 新建或替换一个服务及其模型；留空 key 字段保留已有凭据，不传空字符串。|
| `POST /api/ai/providers/:id/models` | 读取已保存服务的标准 `/models`；无此端点则手动添加。|
| `POST /api/ai/providers/:id/test` | `{modelId}` 仅发简短测试，可能计费；不会创建本地聊天。|
| `PUT /api/ai/translations` | `{expectedRevision,sources,layout:'stack'|'columns'}` 保存完整来源数组、顺序和布局。|

`provider`：`{id,label,kind:'minimax'|'openai-compatible',baseUrl,plan,auth:'bearer'|'none',enabled,includeUsage,passReasoning}`。baseUrl 使用 HTTPS，只有 localhost / 127.0.0.1 / ::1 允许 HTTP；不含密钥、用户信息、查询参数、片段。也可填写完整 `/chat/completions`，保存时规范为 base URL。套餐端点（如 `/coding/v1`）保留；plan 只是备注，不改变供应商的授权或计费。`includeUsage` 发送流式用量参数，`passReasoning` 允许历史 reasoning_content，按供应商实际能力设置。

`models`：每项 `{id,providerId,model,label,contextWindow,reasoning:'none'|'standard'|'extended',enabled}`。`id` 是稳定本地编号；`model` 是发送给上游的 model ID。相同上游模型可属于不同服务；请求 `/api/ai/chat` 必须传本地 id。上下文必须明确填写，范围 1000–10000000，单位 tokens；未公布则让作者确认，不自动猜测。none 不发送 reasoning_effort，standard 为 low/medium/high，extended 增加 xhigh/max。切换模型后会按支持范围调整。

`sources` 每项 `{id,label,modelId,enabled,color:'#RRGGBB'}`；数组顺序就是显示顺序。禁用服务或模型后来源会明确提示未配置/未启用，不静默切换模型。尚被来源引用的模型不能删除，应先修改或移除来源。各模型和来源 ID 在对应数组内唯一。

写入配置需携带刚读到的 revision；409 时保留自己的修改，重新读取后比较。密钥仅通过本机 POST 请求传给后台写入 macOS 钥匙串，不在 CLI 命令行参数、JSON 文件或日志中存放。凭据按工作区、服务 ID、规范化 API 地址隔离；更换地址不继承旧密钥。完整备份只包含规范化后的非密钥模型配置，恢复后仍需在新机器配置凭据。可直接读取配置文件，但建议经本机 API 修改以获得冲突保护和 SSE 刷新。

## 命令行入口

在本工作区执行：

```sh
node _system/scripts/echopaper.mjs help
npm --prefix _system run cli -- status
```

机器读取 JSON 时，使用 `node` 入口，或关闭 npm 的命令横幅：

```sh
npm --silent --prefix _system run cli -- projects
```

CLI 从 `_system/runtime/instance.json` 发现端口，必要时探测 4173–4203。每次均通过 `/api/health` 核实工作区路径，不能只依赖端口号。它仅连接 `127.0.0.1`，不会连接远程服务器，也不会自动启动后台。

可显式使用 `--workspace /完整工作区路径 --port 4173`；指定端口仍要核实工作区身份。`--timeout` 是单次请求超时毫秒数。运行 CLI 的用户须有该工作区的本机文件权限。

## 会议时间线

`GET /api/workspace/conference-timeline` 返回 `{revision,conferences}`；`PUT` 同一地址携带 `{expectedRevision,conferences}`，成功后 revision 加一，409 时保留本地编辑并重新读取比较。会议记录包含 `id,title,year,color,enabled,paperIds,milestones`，可选 `conferenceId,roundId,roundLabel,officialUrl,sourceStatus,sourceUrls,warning,fetchedAt`；节点包含 `id,label,at`，可选 `date,note,sourceUrl`。`at` 未知时为 `""`，已知时须为含明确时区的 ISO 时间，服务端保存为 UTC；官网仅公布日期时使用 `date:"YYYY-MM-DD"`，不补造具体时刻。官网与来源只接受 HTTP(S) 地址；颜色使用 `#rrggbb`。数据存于 `workspace/catalog`，随工作区完整备份保留，不修改论文投稿状态或触发编译。

`POST /api/workspace/conference-timeline/resolve` 接收 `{conferenceId,roundId?,refresh?}`，会议须来自既有 CCFDDL 年份记录，多轮会议须明确轮次。自动读取会议官网及同源 CFP/重要日期页，返回来源链接、已公布的评审节点和 `sourceStatus:ready|partial|unavailable`。忽略官网已划除的旧日期，保留当前正文公布的修改日期；第一阶段拒稿通知不当作最终决定。未找到的日期保持缺失并说明，不从其他年份或投稿截止日期推算。每次最多读取四页，结果在内存缓存 15 分钟，`refresh:true` 可立即重新读取；不调用模型。读取限制排除本机、私有地址与跨域跳转。

## ZIP 工程导入与管理状态

接口只连接本机，不需要外部模型或云端服务。按顺序执行：

1. `POST /api/project-imports/zip`，`multipart/form-data` 的 `file` 为 ZIP。返回 `201` 和 `{token, filename, candidates:[{path,documentClass}], suggestedMain?, fileCount, totalBytes, ignored}`；此时只暂存，不创建文章、不编译。`suggestedMain` 缺省时请明确选择候选文件，不要猜测。
2. `POST /api/project-imports/:token/create`，JSON `{id,title,main}`。`main` 使用候选项原样路径（不加 `manuscript/`）。成功返回 `201` Project，目标入口为 `manuscript/<main>`。源码逐文件核对 SHA-256，原 ZIP 与清单备份至 `archive/zip-<id>-随机编号/`，再发布项目。已存在 ID 返回 `409`，暂存 token 可更换 ID 重试；同一 token 已成功创建后，使用同一 ID 重试返回原项目，不会重复导入。
3. 用户取消时 `DELETE /api/project-imports/:token` 清理暂存，返回 `{ok:true}`；不删除已导入文章。暂存 30 分钟失效，重启后须重新上传。最多 10 个待处理上传、同时处理 2 个 ZIP。

ZIP 压缩文件最大 50 MB、单文件最大 50 MB、解压总量最大 250 MB、最多 10000 条；接受 Stored/Deflate，拒绝加密、路径越界、符号链接及大小写/Unicode 路径冲突。隐藏文件与缓存不导入稿件，原包备份完整保留。主文件不会自动改写，`autoCompile` 初始为 `false`。

`GET /api/projects` 返回派生字段 `lastEditedAt`（项目配置、manuscript/notes/reviews 文件的最近修改时间），供管理页排序；并返回可选布尔字段 `archived`、`trashed`。`PATCH /api/projects/:id` 使用 `{archived:true|false, trashed:true|false, expectedUpdatedAt}` 归档/回收/恢复；沿用配置版本冲突保护，`409` 时重新读取、比较后再操作。两项状态均不删除或移动文件；Codex 仍可通过显式项目 ID 访问。界面默认全部列表排除归档和回收站项目，回收站按 `trashed` 筛选。

## 文章与配置版本

```sh
node _system/scripts/echopaper.mjs status
node _system/scripts/echopaper.mjs projects
node _system/scripts/echopaper.mjs project WWW
node _system/scripts/echopaper.mjs deadline get WWW
```

| HTTP 接口 | 返回与用途 |
|---|---|
| `GET /api/health` | `ok, workspaceRoot, pid`，用于确认实例身份 |
| `GET /api/projects` | `{projects: Project[]}` |
| `GET /api/projects/:id` | 单篇 `Project`，包含配置版本 `updatedAt` |
| `PATCH /api/projects/:id` | 配置变更；传 `expectedUpdatedAt`，版本不符返回 409 |

CLI 设置和清除截止时间时，先读取当前项目，再携带该项目 `updatedAt` 提交。若之前已经审阅了某一版本，使用 `--expected-updated-at` 指定自己的基线。409 不会自动覆盖或重试，应重新读取并比较配置。

## 文件读取与安全写入

```sh
node _system/scripts/echopaper.mjs file read WWW manuscript/main.tex
```

返回 `{path, content, hash}`。先读当前内容并保存 `hash`，将增量修改写入临时 UTF-8 文件，再提交：

```sh
node _system/scripts/echopaper.mjs file write WWW manuscript/main.tex \
  --input /tmp/echopaper-edit.tex --expected-hash <刚才读取的SHA256>
```

新文件显式使用 `--expected-hash null`。已有文件使用 `null` 会被拒绝，不会覆盖现存内容。文本输入上限 3 MB，不接受 NUL 或无效 UTF-8。

| HTTP 接口 | 请求/响应 |
|---|---|
| `GET /api/projects/:id/file?path=<编码的相对路径>` | `{path,content,hash}` |
| `PUT /api/projects/:id/file` | `{path,content,expectedHash}` → 新文档及新 `hash` |

文件路径相对于文章目录，例如 `manuscript/tex/0_Abstract.tex`，不能是绝对路径或包含 `..`。项目 ID 与目标 ID 不同：项目例如 `WWW`，目标例如该项目 `targets[].id` 中的 `main`。

网页和 Codex 同时修改时，如果磁盘版本已经变化，服务返回 `409` 与 `current`。请保留自己的修改，比较新磁盘内容，再决定如何合并；不要用获取新 hash 后立即重送整篇旧稿的方式绕过冲突。

也可直接用本地编辑器增量改稿，网页会通过文件监听得知变化；带 hash 的 HTTP 写入更适合需要避免竞争覆盖的自动化。

## 会议来源与截止时间

```sh
node _system/scripts/echopaper.mjs conferences WWW
node _system/scripts/echopaper.mjs conferences WWW --refresh
```

`GET /api/conferences?q=WWW&refresh=1` 返回匹配年份与各轮次；搜索不会自动选择最近一年、第一轮或最早截止。响应中有 `sourceUrl,datasetUrl,fetchedAt,stale,warning`。缓存通常保留 6 小时；网络失败时可能提供带 `stale/warning` 的旧缓存。

先审阅查询结果中的会议 ID、年份和轮次，再读取标准选择对象：

```sh
node _system/scripts/echopaper.mjs conferences selection <会议ID> <轮次ID> \
  > /tmp/conference-selection.json
node _system/scripts/echopaper.mjs deadline set WWW \
  --selection /tmp/conference-selection.json --expected-updated-at <项目updatedAt>
```

`GET /api/conferences/selection?conferenceId=...&roundId=...` 返回 `{selection,stale,fetchedAt,warning?}`。CLI 接受整个响应或单独的 `selection`：

```json
{
  "venue": "会议名称与年份",
  "deadlineAt": "带秒数的UTC ISO时间",
  "deadlineTimezone": "IANA时区名称",
  "deadlineSource": {
    "sourceUrl": "https://ccfddl.top/",
    "conferenceId": "已查询到的会议ID",
    "year": 2027,
    "roundId": "已查询到的轮次ID",
    "fetchedAt": "来源获取时的UTC ISO时间",
    "officialUrl": "会议官网地址，可选",
    "notes": "来源边界、原始时间与解释，可选"
  }
}
```

以上只是字段结构说明，不是可直接保存的具体截止时间。实际值应从接口取得或根据已核实的来源填写。TBD/未知时间不能采用为精确截止时间。

- `deadlineAt` 是 UTC 绝对时间，`deadlineTimezone` 是会议时间的展示/解释时区，不能使用运行电脑的时区代替。
- AoE 对应 `Etc/GMT+12`，即 UTC−12；IANA 的 `Etc/GMT` 正负号与常见 UTC 写法相反。
- 保留源数据中的秒数；接口不将日期转换为“本机当天结束”。若源数据缺时间/时区，响应备注会记录解释与未核实边界。
- `fetchedAt` 表示数据获取时间，不表示已经独立核实会议官网。`officialUrl` 也只是来源链接，应核对对应 track、年份、轮次和官网要求。
- CCFDDL 是聚合来源。缓存刷新成功不等于截止要求获得官方确认，Codex 不应自行推断未知会议要求。

清除截止时间及其来源：

```sh
node _system/scripts/echopaper.mjs deadline clear WWW \
  --expected-updated-at <项目updatedAt>
```

此操作保留项目 `venue`，清除精确时间、时区、来源与兼容旧日期字段。直接 PATCH 使用 `{deadlineAt:"",deadlineTimezone:"",deadlineSource:null,expectedUpdatedAt:"..."}`。

## 编译与结果状态

```sh
node _system/scripts/echopaper.mjs compile WWW main
node _system/scripts/echopaper.mjs compile WWW main --wait
```

`POST /api/projects/:id/builds` 请求 `{targetId}`，返回构建记录。它只编译磁盘中已保存的文件；编译任务会冻结源码并记录 `sourceHash`，不改写正文，因此没有文件覆盖操作。`--wait` 轮询 `GET /api/builds/:buildId` 到终态，默认最多 960 秒；可用 `--wait-timeout` 调整。等待超时不会取消后台构建。

只有 `status:succeeded` 且有 `pdf` 才能视为生成 PDF。读取 `stale`：即使构建成功，随后源码变化也可能使 PDF 过期。失败时网页保留上一次成功 PDF，不能把它视为最新源码结果。PDF 生成、投稿包可独立编译、符合会议投稿要求是三个不同结论。

### 构建诊断

`GET /api/projects/:id/builds` 返回 `{builds}`（按创建时间倒序），`GET /api/builds/:buildId` 返回单次记录。每个 `Build.diagnostics[]` 包含：

- `severity`: `error | warning | info`。生成 PDF 的未解析引用属于警告；错误与终止原因、取消、网络失败结合 `Build.status/reason/log` 判断。
- `category`: `compile | reference | placeholder`，区分编译、引用和作者待补内容。
- `message`: 保留问题说明；可定位时附 `file`（项目相对路径）、`line`（从 1 开始）、`page`（PDF 页码，从 1 开始）。未知位置省略，不推测。

诊断结合最终 TeX 日志与本次冻结源码的活动依赖图；注释、未启用分支、未引入文件及宏的复杂展开采取保守策略。历史记录可从已校验的冻结快照惰性补全诊断，保持原构建状态及源码不变。引擎中止汇总不重复计算已有具体错误；引用汇总保留为信息记录。界面按正式提交标准另行评级：缺失引用、无效插入、缺失文件和待补内容标为红色严重问题，普通排版警告保留黄色。复用 `shared/diagnostic-policy.ts` 的 `submissionSeverity`，不会改写引擎原始 `severity` 或 `Build.status`。界面去重分组逻辑可复用 `src/buildIssueSummary.ts` 的 `issueGroups/issueCounts`，不要直接用数组总长度当作错误数。

`page` 仅对应该 `buildId` 的 PDF，作为构建记录保留。问题列表点击使用 `file/line` 打开源码，不使用 `page` 跳 PDF。若最新编译失败而展示旧 PDF，不应使用新错误的页码定位旧版本。`stale` 为真时，行号也可能已变化；Codex 修复前应重新读取当前文件并携带内容哈希保存。全文日志可由 `GET /api/builds/:id/artifacts/compile.log` 下载。所有诊断、问号着色与修复线索均在本机完成，无需模型 API。

## SSE 与错误处理

`GET /api/events` 是 SSE。常见事件包括 `file.changed`、`project.changed`、`build.updated`、`annotation.changed`。客户端重连后应重新读取自己正在查看的文件/项目/构建状态，而不是假定期间没有发生修改。

```sh
curl -N http://127.0.0.1:4173/api/events
```

CLI 成功输出 JSON；帮助输出文本。错误输出到 stderr，退出非零；用法错误为退出码 2，其余错误为 1。409 使用 `code:ECONFLICT`，编译失败/取消使用 `code:EBUILD`，离线为 `EOFFLINE`。错误 JSON 可带 `status` 与 `details`，例如冲突中的当前文档。

接口仅监听本机，验证 Host/Origin，拒绝跨项目目录穿越及符号链接。这里不是提供给公网或多人登录的服务。API 密钥仅在 macOS 钥匙串中；CLI、项目配置、选择 JSON、提交包和日志都不应保存密钥。此 CLI 没有读取、显示或导出密钥的命令。

## 编译触发策略

文件 PUT、Codex 外部修改、重命名、上传和后台自动保存只同步内容，不触发构建；旧 `autoCompile` 设置不再启用实时编译。网页主动保存当前目标源码会显式调用构建接口；CLI 写文件后如需 PDF，请再调用 `compile`。主动生成投稿包仍包含独立编译验证。

会议列表支持 `rank=all|A|B|C&upcoming=1&sort=deadline&offset=0&limit=200`，返回未截止轮次与分页信息；排序按同一实际截止时刻，界面统一显示北京时间。精确 `selection` 查询保留历史兼容，不自动替用户选择会议。

## 本地双向词语定位

定位不依赖外部 AI API。`GET /api/builds/:id/sync/forward?path=...&line=...` 返回同一来源行附近的排版区域（最多 128 个）；`GET /api/builds/:id/sync/inverse?page=...&x=...&y=...` 返回源码路径、行和可选列号，另有可选 `alternatives`（最多 8 个附近来源候选，字段为 path/line/column）。坐标为页面左上角起算的 0–1 比例。

网页利用双击处的词及前后文，在这些局部候选中匹配并高亮真实词范围；歧义不以整行高亮代替。来源均限于注册工程，生成参考文献或空白位置无可靠记录时返回明确错误。浏览器与本机服务之间的 HTTP API 只是本地进程通信，不会把定位文本发送给模型。

`GET /api/builds/:id/sync/word?word=...&before=...&after=...` 用于 ACM 摘要等已读入、但排版记录归属调用处的内容。仅扫描该次成功构建的冻结源码中、经 manifest 与 SyncTeX 输入共同确认的 `.tex` 文件；不扫描未参与编译的文章或读取模型密钥。返回 `{path,line,column,stale,warning?}`，行列均从 1 起算，列按 UTF-16 字符计数。`word` 最长 120 字符，前后文各最长 240 字符；至少四个相邻上下文词匹配，且最佳候选领先次优，才返回结果。无可靠或唯一候选返回 404，参数无效返回 400，超出扫描大小限制返回 413。建议对查询参数使用 `URLSearchParams` 编码。

摘要正向跳转在浏览器本地核对 PDF 文字元数据，确认唯一上下文后才渲染对应页并以真实文字范围高亮；不会用段落大框代替词语。此补充定位受宏展开、重复文本及当前源码和冻结版本差异的限制，有歧义时保留原阅读位置。

## 选区翻译

网页读取 `GET /api/ai/providers` 的 `translations`，按数组顺序展示全部启用来源；每个来源使用独立 `sourceId` 调用 `POST /api/ai/translate`，由服务端解析其模型。旧纯函数 `src/selectionTranslation.ts` 的 `selectionTranslationRequest(projectId, model, text, target, source, sourceLanguage?)` 仅保留兼容，不作为当前翻译调用入口：`model` 为本地模型编号，`target` 为 `zh-CN` 或 `en`，`source` 为 `tex` 或 `pdf`，`sourceLanguage` 为 `auto`（默认）、`zh-CN` 或 `en`。仅发送选区与翻译要求，不包含文件或聊天历史，网页限 6000 字符。关闭浮窗使用 AbortController，仅完整译文进入页面内缓存；单来源重试不改变其他卡片。
翻译入口为物理 Control（Mac ⌃）+ 拖选源码/PDF，或选中后点击顶栏翻译；Command/Meta 和普通拖选不请求 API。Ctrl 选字打开的临时浮窗在未固定时，按下外部指针即关闭并取消请求；顶栏手动打开或固定的窗口保持显示。窗口内控件和模型设置门户属于同一操作流程，不触发外部关闭。浮窗的坐标、尺寸与固定状态保存在本机浏览器 `echopaper:translation-window:v1`，不保存原文或译文，不改项目配置或稿件。普通点击、拖选不执行源码/PDF 导航；对应位置导航只由双击触发，PDF 内引用链接仍按正常链接操作。


### 多服务翻译扩展接口

`src/translationAdapters.ts` 导出 `TranslationAdapter`、`configuredTranslationAdapters`、`loadTranslationAdapters` 和 `runTranslationAdapters`。适配器提供稳定 `id`、显示名 `label`、`model`、`color`、配置指纹 `cacheVersion`、并发分组 `queueKey` 与 `translate(context, signal, onText)`。`context` 为 `projectId/text/target/source/sourceLanguage?`；加载器从服务端注册表读取启用来源，不含密钥。

同一限流组以 rateLimitGroup（未设置时为 provider ID）为 queueKey 串行，跨服务最多两路并发。各来源独立 loading/done/error/stopped，失败不覆盖其他结果。缓存键包含模型、配置指纹、来源编号与翻译上下文；调整顺序和布局不重新调用。`SelectionTranslation` 仍可注入 adapters 用于独立 UI 验收。模型配置变化通过 SSE `ai.config.changed` 推送，网页按 revision 去重。

## 独立助手配置与任务接口（v2）

设置分为 AI 助手、划词翻译、连接与模型。共享连接只表示可复用端点和钥匙串凭据，两种用途的模型绑定、参数和启用状态独立。`GET /api/ai/providers` 返回 v2 公共注册表（无密钥）、`revision`、`assistantFingerprint` 与 `translationFingerprint`；旧 v1 配置在内存中迁移，读取不改盘。`GET /api/ai/config` 返回助手白名单、角色、限制和 `defaultModel`（未选择时为 null）。`PUT /api/ai/config` 保存默认模型须同时提供 `expectedRevision`，不再接受无条件覆盖。角色/白名单/运行设置通过 `PUT /api/ai/assistant` 提交 `{expectedRevision,assistant}`。

助手面板采用一个主助手持续对话入口。每条消息由同一次模型调用决定直接回答或使用原生工具；需要独立专业工作时自主委派已启用的角色，用户不必选择模式或角色。问候、能力说明和一般问答可在一次模型回复后结束，不调用工具、不创建项目检查笔记；仅在回答需要项目材料时按需读取。工具、子角色、差异、编译和撤销作为对话内可展开的操作记录。修复/润色/整理快捷入口也进入同一对话。

前端统一使用项目 `agent-runs` 接口；原 `POST /api/ai/chat` 保留旧客户端兼容。会话由 `(projectId, conversationId)` 标识，每条用户请求单独生成 `runId`，`requestId` 用于幂等。前端发送 `{conversationId,expectedLastRunId,input,targetId}`，首轮的 `expectedLastRunId` 为 null，后续是本会话最后一个已接单运行编号。服务端从 SQLite 会话账本派生历史，客户端不再重传整段 history 或提前调用 compact。同一会话的接单和 head 更新在同一事务内完成；过期 head 返回 409，原输入保留，不自动重试覆盖。

首次使用旧会话时，只从同 ID 已保存聊天或其既有运行导入历史；附带文件随原消息保留，不导入其他会话。取消或失败的半成品答复不成为后续模型历史，用户问题仍保留。新对话有独立的历史、草稿、附件、范围和摘要；项目文件仍是共享工作区。内部压缩按会话所属运行进行，工具调用与工具结果完整配对，真实用量计入同一运行记录，完整原始记录保留。已完成回合的压缩投影按所属会话和 throughRunId 持久化；后续回合及服务重启后复用，新的系统指令仍按当前任务配置装配。`context.projection.saved` 事件仅含投影身份和条数，不暴露摘要文字。

旧 `POST /api/ai/compact` 与不带 `conversationId` 的显式 history 接口仍保留兼容。压缩接口接收 `{projectId,model,messages,checkpoint?}`，返回 `{checkpoint,compactionId}`；后续旧版请求携带该单次票据，真实压缩调用、token 和起始时间计入运行记录。票据绑定项目、模型、配置版本。

统一翻译入口为 `POST /api/ai/translate`，输入 `{projectId,sourceId,text,target,source,sourceLanguage?}`，仅按启用翻译来源解析模型。响应为 NDJSON：`delta` 含增量文本片段，`done` 表示完整结束，`error` 表示本来源失败。没有完整 done 的结果不可入缓存；关闭翻译窗口只取消它自己的请求。专用引擎的旧 `/api/translation-services/translate` JSON 接口保留兼容。助手用途修改只更新公共 revision，不改变翻译指纹或中断在途翻译。

请求须使用 `Content-Type: application/json`。选区长度由前后端共用的 `shared/translation-limits.ts` 按 Unicode 码点计算；单次选区上限仍为本地策略的 6000 字符，不代表所有模型或供应商的能力限制。只有实际超限才返回长度错误，并含 `actualCharacters/maxCharacters`。请求格式、空原文、选区来源及目标/原文语种分别返回对应错误；格式错误不会显示成“6000 字符以内”。原生 fetch 调用必须显式传 JSON 请求头，不能仅依赖供 `api()` 包装使用的 `json()` 方法和正文。

助手附件：`POST /api/projects/:id/agent-attachments` 使用 multipart 字段 `file` 上传，返回 `{id,name,mimeType,size,kind,createdAt}`；`GET /api/projects/:id/agent-attachments/:attachmentId/raw` 获取原件。文件保存在该论文 `.workbench/attachments/`，不进入正文或触发编译，随完整工作区备份保存。支持 PNG/JPEG/WEBP/GIF、PDF、UTF-8 文字及代码、DOCX/PPTX/XLSX；每文件至多 25 MB、图片至多 10 MB、每条请求至多 20 个。暂不支持旧 Office 二进制、压缩包和加密文档；扫描 PDF 无文字时提示上传页面图片。

`POST /api/projects/:id/agent-runs` 可带 `attachments:["附件ID"]`；任务记录返回附件元数据。文字、PDF 和 Office 提取文字作为实际模型材料，明确不包含页面图像和版式。图片在模型网关发送时转换为原生 `image_url` 内容块；内部历史、检查点、模型档案仅保存附件引用，不保存 Base64。上下文估算独立计入图片预算，继续使用 70% 自动压缩规则。所选服务拒绝图片时明确提示切换视觉模型，不声称已经读取图片。聊天消息 `attachments` 和会话 `pendingAttachments` 保存相同元数据，分别用于历史和未发送草稿，编辑器原有 `attachment:{path,content}` 仍独立保留。

任务入口：

```sh
node _system/scripts/echopaper.mjs ai config
node _system/scripts/echopaper.mjs task list WWW
node _system/scripts/echopaper.mjs task start WWW --input /tmp/task.json --wait
node _system/scripts/echopaper.mjs task get WWW <任务ID>
node _system/scripts/echopaper.mjs task cancel WWW <任务ID>
node _system/scripts/echopaper.mjs task resume WWW <任务ID>
node _system/scripts/echopaper.mjs task undo WWW <任务ID>
```

`task.json` 至少包含 `{ "input": "本轮请求", "targetId": "main" }`。可加 `requestId`（CLI 缺省生成一次 UUID）、`conversationId`、`expectedLastRunId`、`modelId`、`effort`、`roleId`、`buildId`、`diagnostic`、`scope`。CLI 续聊也使用会话 ID 和最后一次接单编号，无须重传历史。兼容调用可用 `history`、`compactionId`；无会话 ID 的显式 history 最多 100 条、合计 20 万字符，仅接收 `{role:"user"|"assistant",content}`；有会话 ID 时，非空外部 history 必须与服务端所属历史一致，否则 409。历史不能扩大本轮权限。`roleId` 仅兼容快捷入口的专业职责提示，主助手自主判断是否委派并统一写入。限定文件用 `scope.paths`；限定选区用 `scope.selection:{path,from,to,documentText,selectedText}`，索引按 UTF-16 字符，必须与全文基线一致。只读检查用 `scope.readOnly:true`；明确要求不编译可用 `scope.skipCompile:true`。选区、诊断和构建编号只是附带材料，其存在不表示用户要求改文件。笔记修改不会触发编译，实际正文和资源修改才进入自动编译验证，且仍受主助手本轮工具权限限制；本次指令明确禁止编译时以该限制为准。模型必须属于助手白名单，不能在缺少默认模型时偷偷采用首个模型。不支持工具的模型仍可直接对话，并明确不能实际操作。

| HTTP 接口 | 行为 |
|---|---|
| `GET /api/projects/:id/agent-runs` | 返回 `{runs}`，任务与聊天分开持久化 |
| `POST /api/projects/:id/agent-runs` | 创建任务，立即返回任务；相同 requestId/相同输入幂等，不重复执行 |
| `GET /api/projects/:id/agent-runs/:runId` | 返回 `{run,events,tools}`，含变更集、角色、用量与验证记录 |
| `GET /api/projects/:id/agent-runs/:runId/events?after=序号` | SSE 每条为 RunEvent，带递增 id，可用 Last-Event-ID 补读 |
| `POST .../:runId/cancel` | 停止自身模型、子角色和自身构建；保留已提交修改 |
| `POST .../:runId/resume` | 核对日志和文件基线后恢复，不盲目重放结果不明的工具 |
| `POST .../:runId/decisions` | `{decisionId,approve:boolean}`，只确认当前具体删除清单 |
| `POST .../:runId/undo` | `{changesetId?}`，省略时逆序撤销任务已应用的修改 |

`reply` 是主助手的自然回复，`summary` 是实际操作记录，零工具回复的 `summary` 为空；旧记录可回退读取 `summary`。`completed` 还须查看 `outcome:resolved|partial`。`verifiedBuildId/verifiedSourceHash/currentSourceVerified` 区分任务版本与当前主稿。编译成功和投稿合规是不同结论。失败、取消或运行中断时修改仍可审阅撤销；有后续人工修改时使用三方比较，重叠处报冲突，不整库回退。

模型事件含 `invocationId` 与 `purpose:turn|child|compaction`；`model.completed.phase` 区分 `commentary`（本次响应含工具调用）与 `answer`。只有主回合回答进入自然回复投影，子角色和内部压缩不会冒充主助手回复；内部摘要不发送文本 delta。`context.manifest` 记录按来源分组的上下文指纹与大小，便于核查哪些材料进入了模型。自动操作审计保存在 `.workbench/agent-reports/`，不再因只读工具向 `notes/` 写入对话报告。旧 `notes/agent-runs/` 原件保留，和聊天状态一样不纳入项目读取工具；作者主动交办的检查结论仍可通过正常 ChangeSet 写进 `notes/`。

自动构建验证只绑定实际源码/资源修改；单独请求编译时由模型发出原生 `compile` 工具。输入文字提到“编译”或“build”、附带旧构建/诊断线索本身不会触发后台构建。

默认每项目一个修改任务、三个子角色并行、一层委派；不限制模型调用次数、工具迭代步数或累计 token，用量仅用于记录。旧配置的 `modelCalls/tokens/maxSteps/repairRounds` 在读取时归一化为 0，不再执行这些阈值。保留可编辑的运行时长（默认 60 分钟）、子角色并发（默认 3），以及手动停止；不按编译次数截停任务，相同问题无进展时保留检查结果。模型实际上下文窗口仍用于自动压缩历史，不是额度预算。完整角色和运行设置在助手设置中编辑，任务固定启动时的非密钥配置。仅原生 function tool_calls 经完整解析与结构校验后可执行，不把模型普通文本当命令。工具范围限定论文材料；官方类/样式、系统、其他项目、构建及投稿快照不可写，不提供任意 shell 或任意 HTTP 工具。

网页通过 `/api/projects/:id/editor-sessions` 登记编辑器缓冲区；收到 `editor.barrier` 后短暂冻结相关编辑器、保存缓冲区并确认，`editor.release` 或过期后恢复。不能确认或基线变化时任务暂停写入，保留双方内容。多文件变更先完整预检、写 journal 再提交，启动时补偿中断事务。SQLite/日志保存于论文 `.workbench/` 并进入完整备份；备份维护屏障阻止活动任务写入。

编辑会话使用每个页面独立的随机 ID。`pagehide` 即时 keepalive `DELETE .../editor-sessions/:sessionId`，正文为 `{path,dirty,bufferVersion}`；clean 注销立即退出等待集合，已关闭 ID 的迟到注册不能复活。dirty 记录保留，较旧状态不能把它降级为 clean。路径、dirty 和内容版本变化均提升协议 bufferVersion；BFCache 恢复重新同步，clean 文档使用新 ID。两个窗口必须分别确认，期间出现新窗口或 dirty 变化会撤销既有提交许可。

真实模型 QA 需明确授权后使用：`node --import tsx _system/scripts/qa-agents-real.ts --confirm-real`。它只复用现有 MiniMax 连接，在系统临时目录创建独立论文并清理，凭据仅在后端内存中传给供应商，不输出到报告。
