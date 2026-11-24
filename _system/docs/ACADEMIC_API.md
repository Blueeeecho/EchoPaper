# EchoPaper 学术工作区与演示文稿 API

## 文献自动处理与本地缓存

- `GET /api/workspace/bilingual/processing?ids=<逗号分隔的资源ID>` 返回设置修订号、队列汇总和逐篇缓存状态。`complete` 表示当前原文版本及所选翻译范围已保存。
- `PUT /api/workspace/bilingual/processing` 接受 `expectedRevision`、`enabled`、`translateAppendix`、`engineId`、`translationSourceId`。OCR 默认使用 AI Studio PaddleOCR，翻译来源为 `null` 时跟随设置中的首个已启用来源，也可保存具体来源 ID。GET 返回 `choices` 中的可选引擎与翻译来源，包含模型名称及凭据配置状态。所选配置用于新文献和待完成任务，处理时优先读取已有缓存。附录默认关闭，开启后补齐已有版面缓存的附录译文。
- `POST /api/workspace/bilingual/processing` 接受 `{resourceIds: string[]}`，用于已有文献补齐与失败重试。每段译文完成后原子保存，暂停或重启可复用已有进度。
- OCR 与翻译初始均为2路，按连续成功逐步增加，OCR 上限4路、翻译上限6路。在途文献数随当前并发动态变化。`parallelism` 返回有效并发和活动槽位。遇到限流或服务繁忙时对应阶段并发减半，最低1路；冷却两分钟后按成功反馈逐步回升。正常阶段每30秒且至少4次成功后增加1路；失败重试复用已保存的版面和译文。
- `workspace/reading-layout/<资源ID>.json` 保存原始 OCR 版面与图表数据，`.translations.json` 保存按来源、模型、语种和原文指纹索引的译文。`.analysis.json` 保存原文版本、解析与翻译来源、分区、页码、坐标、合并来源 ID 和译文键，供后续分析关联。图像保存在版面文件中，分析文件通过块 ID 和坐标关联。
- 原文版本改变后，旧版缓存保留在 `workspace/reading-layout/history/<资源ID>/`。队列与设置保存在 `_processing.json`。后台 OCR 按原文版本和引擎记录各分块的上游任务号，续跑先查询已接单任务。接单状态未知时停止自动提交，可核对供应商任务后在阅读页手动解析。队列损坏时后台停用该队列并保留原文件与已完成缓存。以上文件随工作区完整备份保存。
- OCR 和译文保存后同步更新 `workspace/reading-search/<资源ID>.json` 文字索引，保留原文、已有中文译文及页码。旧缓存启动后自动补建。资料检索复用本地索引，原文版本变化后排除旧缓存内容。

开源依赖与复用边界见 [ACADEMIC_REUSE.md](ACADEMIC_REUSE.md)。

网页和 CLI 共用本机服务及同一份工作区数据。本文补充课题、资料目录、文件整理和 PPT 工程接口；原有论文、编译、聊天和模型配置接口见 [LOCAL_API.md](LOCAL_API.md)。

## CLI 入口与写入约定

```sh
node _system/scripts/echopaper.mjs workspace overview
node _system/scripts/echopaper.mjs topics list
node _system/scripts/echopaper.mjs presentations list
node _system/scripts/echopaper.mjs styles list
```

CLI 只连接 `127.0.0.1`，从 `_system/runtime/instance.json` 发现端口，必要时探测 4173–4203；每次先以 `/api/health.workspaceRoot` 核对工作区身份。`--workspace`、`--port`、`--timeout`、`--wait-timeout` 沿用原命令规则，显式指定端口也不能绕过身份检查。命令不读取或输出模型密钥，不自动启动服务。

写入数据放在 `--input <UTF-8 JSON 文件>` 中，顶层必须是对象，输入上限 12 MB。新接口中的标签、课题和目录权限编辑使用 `expectedRevision`；PPT 内容、材料和生成请求使用 `expectedHash`。文件移动和回收同时使用资源的 `expectedRevision` 与 `expectedHash`；新建文件明确使用 `expectedHash:null`。`expectedHash` 可以放在 JSON 中，也可以用 `--expected-hash <SHA256>` 补充；新建文件可用 `--expected-hash null`。两处同时提供时必须一致。PPT hash 不接受 `null`。

先读取、比较和修改，再提交相应基线。发生 `409` 时不会自动读取新版本重试，也不会用旧内容覆盖新内容。命令成功输出 stdout JSON；错误输出 stderr JSON。参数错误退出码为 2，其余失败为 1。`ECONFLICT` 含 HTTP 状态和服务端详情；无效 JSON/UTF-8 或缺少写入基线在连接前以 `EINPUT` 拒绝。

## 数据位置与类型

| 类型 | 关键字段与位置 |
|---|---|
| `ResearchTopic` | `id,title,description,paperIds,presentationIds,resourceIds,archived,revision,createdAt,updatedAt` |
| `SourceRoot` | `id,label,path,permission,status,error?,scannedFiles,indexedAt?,revision,createdAt`；权限为 `read/write`，状态为 `scanning/ready/offline/error` |
| `Resource` | `id,rootId,path,name,title?,kind,size,modifiedAt,tags,missing,revision,hash?,snippet?`；`kind` 为 `file/directory`，path 相对于已连接来源 |
| `ResourcePage` | `resources,total,roots,indexing`，资源分页与扫描状态 |
| `FileOperation` | `id,kind,status,source?,destination?,recovery?,resourceId?,createdAt,error?,undoable`；状态为 `applied/undone/failed/interrupted`，recovery 记录撤销新建文件后保留副本的来源与相对路径 |
| `WorkspaceOverview` | `topics,roots,resources,operations,externalOriginalsIncludedInBackup:false`；总览优先列可用文件，按 modifiedAt 倒序最多取 200 个资源，以及最近 50 次操作，完整检索使用分页接口 |
| `PresentationFile` | `{document:PresentationDocument,hash}`；hash 对应当前 `presentation.json` 原始字节 |
| `PresentationSummary` | `id,title,language,styleId,styleVersion,slideCount,updatedAt,latestJob?,topicId?,paperId?` |
| `PresentationJob` | `id,presentationId,kind,status,phase,createdAt,finishedAt?,documentHash?,sourceHash,styleHash,error?,checks,downloadUrl?,previewUrls?,usage?` |
| `StylePack` | `id,version,name,description,templateHash,chineseFont,englishFont,navigation,width,height,layouts,previewUrl?,logoUrl?` |

课题、目录连接、标签、关联及整理日志保存在 `workspace/catalog.sqlite`；原生 SQLite 不可用且没有已有 SQLite 文件时使用 `workspace/catalog.json`。资料原件保留在用户明确连接的目录，不因连接或扫描自动迁入工作区。目录断开时保留索引；外部移动尚未确认时标记原位置缺失，保留 ID 和关联。

每个 PPT 工程只有一个当前文档：`workspace/presentations/<ID>/presentation.json`。`assets/` 保存显式选择或上传的 PDF/图片等材料快照；`jobs/` 保存持久任务；`build/<任务ID>/` 保存冻结输入、风格副本、清单和产物，不直接编辑。样式包位于 `shared/presentation-styles/<样式ID>/<版本>/`。论文当前主稿仍位于 `papers/<ID>/`，入口由其 `project.json.targets` 指定。

完整 TypeScript 结构见 [workspace-types.ts](../shared/workspace-types.ts) 与 [presentation-types.ts](../shared/presentation-types.ts)。

## 课题与来源目录

### 研究流程与进度记录

研究主流程分为问题与选题、方案与实验、结果与证据、论文写作。资料库、进度日志与汇报演示贯穿全程。课题与论文独立创建，通过既有关联列表连接，不复制或移动主稿。

`ResearchTopic` 新增可选字段 `stage:ideation|experiments|results|writing`、`experimentPlan:string`、`resultSummary:string`、`progressEntries:ResearchProgress[]`。旧课题不推断阶段，页面显示“尚未标注阶段”。实验与结果字段各最多 100000 字符，由作者填写；这不是远程实验执行服务，也不会自动推断实验完成或生成数值结果。

沿用 `PATCH /api/workspace/topics/:id {expectedRevision,stage?,experimentPlan?,resultSummary?}` 修改阶段与记录，未提供字段保留原值。保存前读取当前课题的 `revision`；409 时保留输入并比较，不能自动重试覆盖。

### 独立 Markdown 研究记录

`section` 为 `ideation`、`experiments` 或 `results`，分别用于课题笔记、方案与实验、结果与证据。`GET /api/workspace/topics/:id/notes/:section` 返回 `{notes:ResearchNoteSummary[]}`，`GET` 同一路径加 `/:noteId` 返回 `{id,name,filename,path,updatedAt,legacy,content,hash}`。`path` 相对工作区根目录。

`POST /api/workspace/topics/:id/notes/:section {expectedHash:null,requestId,day?}` 返回 `201` 和记录文档。日期采用 `YYYY-MM-DD`，缺省按上海时区取当天，文件名如 `26_11_13.md`，同日顺延 `_02.md`。每次创建使用独立的稳定 `requestId`，超时重试沿用该编号，后台持久日志复用已有记录。新文件内容为空，位于 `workspace/research-notes/<课题ID>/课题笔记/`、`方案与实验/` 或 `结果与证据/`，自动索引并关联课题，随完整工作区备份保存。

`PUT /api/workspace/topics/:id/notes/:section/:noteId {expectedHash,content}` 保存 UTF-8 Markdown，单篇最多 2 MB，返回更新后的记录文档。外部修改或旧 hash 返回 `409` 并携带 `current`，保留双方内容供比较。记录列表同步本地新增与修改，缺失文件保留资料库身份并标记缺失。归档课题须先恢复后编辑。

`DELETE /api/workspace/topics/:id/notes/:section/:noteId {expectedHash,requestId}` 将记录移至回收站，返回 `{deletion:ResearchNoteTrashEntry}`。删除使用内容 hash 校验，重试沿用同一 `requestId`。网页先保存当前输入，再确认删除。已回收的文件从笔记与资料库列表隐藏，原资源 ID 和课题关联保留供恢复。

`GET /api/workspace/topics/:id/notes/:section/trash` 返回 `{entries:ResearchNoteTrashEntry[]}`，包含删除状态、原笔记 ID、hash 和可恢复标志。同一路径加 `/:operationId` 返回 `{content,hash,filename}`，可下载回收副本。`POST /api/workspace/topics/:id/notes/:section/trash/:operationId/restore {expectedHash}` 恢复原记录并返回记录文档，保留原资源身份，重复请求返回当前记录。原路径已被占用或原有字段已有新内容时返回 `409`，可下载副本后合并。三个研究分区及既有“原有记录”均支持回收和恢复，归档课题须先恢复课题后操作。

`ideation` 是独立课题 Markdown 笔记。其 `name` 使用正文中首个一级 Markdown 标题，无标题时使用日期文件名；`filename`、`path` 保留物理定位。列表按最近修改排序。该分区没有虚拟 `overview` 记录，笔记可在选定文献之前创建。

既有 `experimentPlan`、`resultSummary` 非空时分别显示为 `noteId:"overview"`、名称“原有记录”、`legacy:true` 的记录，`filename` 和 `path` 为 `null`。通过同一 PUT 接口按内容 hash 保存，只更新对应课题字段，沿用原字段的 100000 字符上限。完整类型见 [research-notes.ts](../shared/research-notes.ts)。

`PATCH /api/workspace/topics/:id/progress/:entryId {expectedRevision,content,nextStep?}` 以追加方式更正最新有效记录，返回 200 和完整课题。新记录带服务端生成的 ID、创建时间和 `amendsId`；原记录仅新增 `supersededBy`，原文、下一步、ID 和时间保留。可继续更正最新版本形成链；过期 revision 或重复更正旧版本返回 409，不写入；不存在返回 404，空/超长字段返回 400，累计 5000 条返回 413。保存失败回滚内存改动，沿用目录原子保存及串行锁。旧数据无需迁移。更正不代表新增已完成实验。

`POST /api/workspace/topics/:id/progress {expectedRevision,content,nextStep?}` 追加进度日志，返回 201 和更新后的完整课题。`content` 为非空字符串，最多 10000 字符；`nextStep` 可留空，最多 2000 字符。服务器生成日志 `id`、`createdAt`，递增课题 `revision` 并更新 `updatedAt`；每课题最多 5000 条日志。既有日志不通过课题 PATCH 覆盖。记录随原有工作区目录索引保存和备份，网页路径 `#/experiments?topic=...`、`#/results?topic=...`、`#/progress?topic=...` 保留课题上下文。

| HTTP 接口 | 请求/响应 | CLI |
|---|---|---|
| `GET /api/workspace/overview` | `WorkspaceOverview` | `workspace overview` |
| `GET /api/workspace/topics` | `{topics:ResearchTopic[]}` | `topics list` |
| `POST /api/workspace/topics` | `{title,description?,paperIds?,presentationIds?,resourceIds?,archived?}` → `201 ResearchTopic` | `topics create --input topic.json` |
| `PATCH /api/workspace/topics/:id` | 可修改字段与 `expectedRevision` → 新 `ResearchTopic` | `topics update <ID> --input topic-edit.json` |
| `GET /api/workspace/roots` | `{roots:SourceRoot[]}` | `roots list` |
| `POST /api/workspace/roots` | `{path,label?,permission?:"read"|"write"}` → `201 SourceRoot`，后台扫描 | `roots connect --input root.json` |
| `PATCH /api/workspace/roots/:id` | `{label?,permission?,expectedRevision}` → 新 `SourceRoot` | `roots update <ID> --input root-edit.json` |
| `POST /api/workspace/roots/:id/scan` | `{}` → `202 SourceRoot`，异步重新扫描 | `roots scan <ID>` |

主题关联只接受存在的论文、PPT 或资料 ID。创建主题不创建论文或 PPT；修改关联需要显式提交对应数组。

来源 path 必须是实际、独立的绝对目录；默认权限为 `read`。连接后仅建立索引和监听，`write` 才允许显式整理操作。重复或重叠来源返回 `409`。符号链接、受工作台管理的 `papers/_system/shared/workspace/build/submissions/backups/archive` 子树及包含这些子树的宽泛父目录被拒绝，不能通过连接上级目录扩大写入权限。扫描跳过隐藏项与符号链接。`offline` 表示来源不可用，不代表原件被删除；查看 `error` 与扫描状态后再处理。

连接示例 `root.json`：

```json
{"path":"/absolute/path/to/originals","label":"原始资料","permission":"read"}
```

授权整理时，先用 `roots list` 读取当前版本，再提交：

```json
{"permission":"write","expectedRevision":3}
```

## 资料检索、标签与重新关联

| HTTP 接口 | 请求/响应 | CLI |
|---|---|---|
| `GET /api/workspace/resources` | 查询 `rootId?,q?,path?,topicId?,offset?,limit?` → `ResourcePage` | `resources search [搜索词]` |
| `GET /api/workspace/resources/:id` | 当前 `Resource`，可用项返回内容 hash | `resources get <ID>` |
| `PATCH /api/workspace/resources/:id` | `{tags?:string[],title?:string|null,expectedRevision}` → 新 `Resource` | `resources tag <ID> --input tags.json` |
| `POST /api/workspace/resources/:id/relink` | `{rootId,path,expectedRevision}` → 保留原 ID 的新 `Resource` | `resources relink <ID> --input relink.json` |
| `GET /api/workspace/resources/:id/text` | 支持的文本/PDF → `{content,hash}`；受大小与页数限制 | 直接调用 HTTP |
| `GET /api/workspace/resources/:id/raw` | 文件流；PDF、允许的图片及纯文本可预览，其余下载 | 直接调用 HTTP |
| `POST /api/workspace/resources/:id/reveal` | 在本机 Finder 显示已校验资源 | 网页/直接调用 HTTP |

上传、arXiv 下载及目录扫描会从 PDF 元数据与首页标题提取真实论文标题，使用本地解析。提取不足时显示“论文标题待核对”，可在资料详情补全标题。

`title` 保存文献的显示标题，沿用资源 revision 冲突保护。列表、阅读器和阅读笔记优先显示该标题；`name` 与 `path` 保留原始文件名及位置，阅读和翻译缓存继续按资源 ID 复用。扫描保留已确认的标题，`title:null` 或空字符串清除标题。仅修改标签时保留已有标题。

`deduplicate=true` 按 PDF 内容哈希合并列表展示，计数与分页均使用去重结果。资料库各视图及课题文献列表统一使用该参数，包含“全部文件”。显式 API 查询仍可读取完整原件索引。论文按真实标题排序后分页，重点文献优先；界面序号按当前筛选结果连续生成，跨页接续，旧文件名中的编号不用于列表序号。相同 PDF 的 OCR 与译文按内容哈希复用，后台同一内容一次只处理一份。

`q` 检索显示标题、文件名、路径、标签、已提取文本、OCR 原文及已缓存的中文译文。大小写忽略，空格分隔的多个关键词须全部命中同一份资料。搜索响应中的资源可带 `searchMatch {source:metadata|text|ocr|translation,snippet,page?,terms}`，`page` 从 1 开始；课题文献列表和资料库展示命中片段。中文匹配范围随本地译文保存进度更新。

HTTP `path` 缺省时不限定父目录，`path=""` 列来源顶层，其他值精确指定父目录；`offset` 默认 0，`limit` 默认 200，范围 1–1000。CLI 搜索采用默认分页，复杂筛选使用 HTTP。HTML/SVG 等主动内容不以内联网页形式执行；原始响应携带禁嗅探及沙箱限制。

重新关联只适用于原位置缺失的资源，必须显式选择已注册来源中的现存路径，不移动文件。若完整扫描已为新位置建立索引，仅在原资源和新文件内容 hash 一致、新记录没有独立标签、主题/PPT 引用或整理操作历史时合并临时身份；原 ID、标签和关联保留。内容不同或已有独立用途时返回 `409`，不会偷换资源身份。

## 文件整理与撤销

| HTTP 接口 | 请求/响应 | CLI |
|---|---|---|
| `GET /api/workspace/operations` | `{operations:FileOperation[]}`，最新优先 | `organize list` |
| `POST /api/workspace/operations` | `FileOperationInput` → `201 FileOperation` | `organize apply --input operation.json` |
| `POST /api/workspace/operations/:id/undo` | `{}` → 新 `FileOperation` | `organize undo <操作ID>` |
| `GET /api/workspace/operations/:id/recovery` | 仅成功撤销的 create-file 操作：验证副本路径、内容 hash 与文件身份，以原文件名附件下载 | 网页“下载恢复副本”/直接调用 HTTP |

`FileOperationInput`：

```ts
{
  kind: 'mkdir' | 'create-file' | 'move' | 'trash';
  rootId: string;
  path?: string;                 // mkdir/create-file 的显式来源内相对路径
  content?: string;              // create-file 必填 UTF-8 文本，可为 ""
  resourceId?: string;           // move/trash 的现存资源
  destinationRootId?: string;    // move 缺省使用同一来源
  destinationPath?: string;      // move 的显式目标相对路径
  expectedRevision?: number;     // move/trash 必填
  expectedHash?: string | null;  // create-file 必须 null；move/trash 必填字符串，目录使用树 hash
}
```

示例（hash 使用 `resources get` 返回值）：

```json
{"kind":"move","rootId":"ROOT_ID","resourceId":"RESOURCE_ID","destinationPath":"reading/paper.pdf","expectedRevision":4,"expectedHash":"读取时的64位SHA256"}
```

路径不能包含绝对路径、`..`、符号链接或直接访问隐藏回收区。目标必须不存在；复制以独占方式创建并校验，再删除原位置，适用于同一或不同文件系统。目录移动同步保留后代资源 ID、标签和主题引用。`trash` 将内容保留在该外部来源的 `.echopaper-trash/<操作ID>/`，不执行永久删除。

新建文件示例（仍通过 `organize apply --input new-file.json`）：

```json
{"kind":"create-file","rootId":"ROOT_ID","path":"notes/new.md","content":"作者笔记\n","expectedHash":null}
```

父目录必须已存在。content 可为空，最多 3 MB，拒绝无效 Unicode 或 NUL；新建使用 `wx` 等价的独占打开，即使校验后出现同名文件也不会覆盖。操作返回 `resourceId`，可立即用资源接口读取正常 Resource；后续扫描保留同一 ID。撤销新建文件会先验证内容、资源版本和原文件身份，再将原内容复制校验至 `.echopaper-trash/<操作ID>/created-file`，返回 `recovery:{rootId,path}`，不永久删除资料。通过操作日志的“下载恢复副本”或上述 HTTP 接口可取回原内容，无需访问隐藏目录。下载只接受已完成撤销的对应操作，独占副本身份与内容仍须匹配记录；副本被编辑或替换时返回 409，符号链接和超出对应操作的路径被拒绝。响应为 nosniff 的附件下载，不内联执行内容。若原文件已修改、原位置已被其他文件替换，或回收目标被占用，拒绝撤销且保留现有内容；中断后只在日志与磁盘身份、内容一致时完成元数据恢复。

撤销使用日志记录的操作后版本，检查资源 revision、内容 hash 和原位置空闲状态。内容/标签/路径已变化或恢复位置被占用时拒绝撤销并保留双方内容。撤销新建目录仅在目录仍为空且版本一致时执行；资源作为缺失记录保留，关联不会悬空。异常中断时只在磁盘状态能明确证明复制与移除已完成后补齐元数据；不明确时记录 `interrupted`，保留两处内容供比较，不自动覆盖或重做破坏性步骤。

## PPT 工程、材料与生成

| HTTP 接口 | 请求/响应 | CLI |
|---|---|---|
| `GET /api/presentation-styles` | `{styles:StylePack[]}` | `styles list` |
| `GET /api/presentations` | `{presentations:PresentationSummary[],unavailable?:string[]}`，不可读文稿或任务记录报告工程 ID | `presentations list` |
| `POST /api/presentations` | `{title,language?,notesLanguage?,preserveExamples?,styleId?,styleVersion?,paperId?}` → `201 PresentationFile` | `presentations create --input create.json` |
| `GET /api/presentations/:id` | `PresentationFile` | `presentations get <ID>` |
| `PUT /api/presentations/:id` | `{document:PresentationDocument,expectedHash}` → 新 `PresentationFile` | `presentations save <ID> --input save.json` |
| `POST /api/presentations/:id/sources` | `{expectedHash,name?,text?\|paperId?\|resourceId?}` → 新 `PresentationFile` | `presentations sources <ID> --input source.json` |
| `DELETE /api/presentations/:id/sources/:sourceId` | `{expectedHash}` → 新 `PresentationFile` | `presentations remove-source <ID> <材料ID> --input remove.json` |
| `POST /api/presentations/:id/sources/upload?expectedHash=...` | multipart `file`，最大 50 MB → 新 `PresentationFile` | 网页/直接调用 HTTP |
| `POST /api/presentations/:id/outline` | `{expectedHash,manual?:boolean}` → `PresentationJob` | `presentations outline <ID> --input outline.json [--wait]` |
| `POST /api/presentations/:id/slides/:slideId/regenerate` | `{expectedHash,instruction}` → `PresentationJob` | `presentations rewrite <ID> <页面ID> --input rewrite.json [--wait]` |
| `POST /api/presentations/:id/export` | `{expectedHash,approvedOutlineHash?}` → `PresentationJob` | `presentations export <ID> --input export.json [--wait]` |
| `GET /api/presentations/:id/jobs` | `{jobs:PresentationJob[]}` | `presentations jobs <ID>` |
| `GET /api/presentations/:id/jobs/:jobId` | `PresentationJob` | `presentations job <ID> <任务ID>` |
| `POST /api/presentations/:id/jobs/:jobId/cancel` | `{}` → `PresentationJob` | `presentations cancel <ID> <任务ID>` |
| `GET /api/presentations/:id/jobs/:jobId/download` | 仅成功导出任务提供 PPTX 文件流 | 使用返回的 `downloadUrl` |
| `GET /api/presentations/:id/jobs/:jobId/previews/:page.svg` | 成功导出任务的布局预览 | 使用返回的 `previewUrls` |
| `GET /api/presentations/:id/slides/:slideId/preview.svg?expectedHash=...` | 当前页面布局 SVG，带 hash 时检查版本 | 网页/直接调用 HTTP |
| `GET /api/presentations/:id/assets/:assetId` | 已选择并核对 hash 的材料文件 | 网页/直接调用 HTTP |

不带 `--input` 的 `presentations sources <ID>` 读取当前 `{sources,hash}`；带输入时添加一份材料。CLI 添加材料须在 `text`、`paperId`、`resourceId` 中明确选择一项。添加论文时读取其显式配置的当前目标主稿；添加资源时校验其真实内容并冻结选中材料，不自动收集目录中的其他原件。PDF/图片可形成工程内资产，文本保存在材料记录中。移除材料会检查是否仍被页面引用，存在引用时返回 `409`。

`PresentationDocument` 包含 `schemaVersion:1,id,title,language,notesLanguage,preserveExamples,styleId,styleVersion,presenter,advisor,durationMinutes,targetSlides,sources,slides,createdAt,updatedAt`，可附 `paperId,topicId,approvedOutlineHash`。语言为 `zh/en/zh-en`。未知姓名和导师等字段保持空字符串。保存时传完整 document，保留 ID 和 createdAt；冻结材料通过材料接口管理，不能在正文保存中改写。保存页面增量内容会使旧大纲批准失效。

每页包含 `id,section,layout,title,titleEn,keyMessage,blocks,notes,sourceIds`。备注由 `purpose,speech,transition,questions` 四段组成。section 为封面、目录、研究背景、研究内容、研究结果、未来计划、致谢；layout 为 `cover/contents/explanation/comparison/table/figure/pipeline/case/thanks`。内容块支持文本、表格、图片、步骤、案例和图表。事实、案例和图表引用指向显式选择的 sourceIds；保留英文案例要求使用材料中的原文。

示例 `source.json`：

```json
{"expectedHash":"读取时的64位SHA256","name":"作者材料","text":"已核实的研究背景与结果。"}
```

大纲生成 JSON 可使用 `{"expectedHash":"读取时的64位SHA256","manual":true}` 创建手工编辑起点，不调用模型；普通大纲和单页 rewrite 使用已配置助手服务。CLI 不代替作者审阅事实、结论、英文案例和讲稿。导出需要已有页面，并冻结当前大纲；可携带审阅时的 `approvedOutlineHash`（页面数组 SHA256，或服务接受的当前文档 hash）检查批准基线。

## 任务指纹、等待与验收边界

`expectedHash` 是当前文档 JSON 字节版本；材料 `source.hash` 是冻结文本或资产原始字节的 SHA256；任务 `sourceHash` 是冻结 sources 数组 JSON 的 SHA256；`styleHash` 绑定样式清单与模板，`documentHash` 绑定任务采用的文档基线。每个任务在 build 目录记录冻结 document、manifest、材料指纹及样式版本，来源变化不会静默混入已经开始的任务。

`--wait` 仅适用于演示 outline/export/rewrite，以及原有任务/编译命令。每 750 ms 查询一次，默认总时限 960 秒，可用 `--wait-timeout 1..3600` 调整；单次 HTTP 超时由 `--timeout` 控制。`succeeded` 时返回最终任务 JSON；`failed/cancelled/interrupted` 退出非零，以 `EPRESENTATION.details` 保留 `presentationId,jobId,job`。超时以 `EWAIT.details` 保留任务 ID，不自动取消或重发模型请求；等待期间连接失败也保留任务 ID。之后用 `presentations job` 查询，或显式 cancel。

成功导出表示生成产物及其报告中的检查已通过，不代表完成原生 Office 验收。阅读 `job.checks` 的 `passed/warning/failed/not_run`：结构校验、SVG 布局预览、PowerPoint/WPS 的实际字体替换、公式/图表显示、溢出和备注检查是不同范围。`native_office:not_run` 必须保留其未验收含义，不能仅凭 job 状态宣布全部视觉检查通过。

## 备份边界

完整备份包含 `workspace/` 中的目录索引、课题/标签/关联/整理日志、PPT 工程、显式冻结资产、任务与产物，以及 `shared/` 中的版本化样式包和 `materials/` 中的托管材料原件。恢复未包含 `materials/` 的旧包时，现有托管材料保留。外部来源目录原件及其 `.echopaper-trash` 均不包含在工作区备份内，不能靠恢复工作区备份找回已经在外部永久删除的原件。仅在明确添加为 PPT 材料时创建的工程内快照随工程备份。

备份/恢复期间使用工作区维护屏障，活动编译、AI 或演示任务及目录写入会阻止不一致快照。恢复工作区数据不移动外部原件，不自动重做整理日志；完成后按恢复接口要求重启。密钥仍留在本机凭据管理中，备份只包含允许的非密钥配置。

### 选题参考文献导入与检索

选题页选中课题后支持拖入多个 PDF（逐个上传），原件存放于 `materials/<课题ID>/参考文献/<文件名>.pdf`，目录固定且不随标题改名；这不会创建或替换论文主稿。目录作为只读资料来源自动登记。上传与 arXiv 下载均按 PDF 的 SHA-256 查重，核对现存原件后复用同一个资源 ID。跨课题只追加关联，共用阅读笔记、OCR 与翻译缓存。已有多个相同副本时，先保留本课题已有的资源身份，新课题优先使用已有有效缓存的副本。不同内容的同名文件返回 409。`materials/` 的原件需单独备份（沿用资料来源原件不包含在工作区备份中的约定）。

- `POST /api/workspace/resources/upload?expectedHash=null` 为资料库和课题页共用的 multipart 单 PDF 导入入口，返回 `{topic?,resource,root,reused,alreadyLinked}`。指定 `topicId,expectedRevision` 时关联课题。指定 `rootId,directory?` 时归档到该来源的现有可写目录，课题自身的专用参考文献来源也可通过对应课题导入。未指定来源时归档到当前课题的参考文献目录，无课题时使用 `materials/library/参考文献/`。如果默认目录已在已连接的可写来源内，则复用该来源。所有入口共用内容哈希去重及缓存选择。此统一入口对同名异文使用内容哈希后缀区分文件。页面显示归档位置，批量逐篇保存，未确认及失败项可显式重试。
- `POST /api/workspace/topics/:id/upload?expectedRevision=N`：multipart 单 PDF，最多 50 MB；检查 PDF 文件头；返回 `{topic,resource,reused,alreadyLinked}`。`reused` 表示复用了已有资源，`alreadyLinked` 表示本课题原已关联，此时不递增课题 revision。每次上传使用刚返回的课题 revision，冲突须重新比较。批量上传逐篇显示新增、复用、已收录与失败。版本冲突或请求结果未确认时保留剩余文件，刷新后可显式重试。
- `GET /api/workspace/literature?q=...`：实时 arXiv 元数据检索，最多 8 条，返回 `{papers:[{id,title,summary,authors,published,url}]}`。
- `POST /api/workspace/literature/query {question}`：沿用已配置默认助手和凭据，模型仅输出检索词，不生成论文记录；无模型时可用关键词检索。
- `POST /api/workspace/topics/:id/download {expectedRevision,arxivId}`：只允许标准现代 arXiv ID，固定来源 HTTPS 下载，拒绝跳转、非 PDF 和超过 50 MB 的文件；成功后按上传相同规则保存并关联。网络失败不会显示保存成功。

### 按文献阅读与分析

- `GET /api/workspace/topics/:id/analysis` 返回 `{document,hash}`；不存在时 `hash:null`，空 articles。
- `POST /api/workspace/topics/:id/analysis` 请求 `{resourceId,sourceHash,expectedHash,focus?,model?}`。资源必须属于当前课题；`sourceHash` 取当前资源读取接口返回值；`expectedHash` 取分析 GET 返回值。默认使用助手当前模型，也可指定助手白名单中已启用模型；单次阅读一篇，可逐篇汇总。

同版本已有分析时默认直接复用，不调用模型；明确传 `forceReanalyze:true` 才重新阅读全文并替换该篇分析。关注问题改变不再自动触发重读。

逐页全文按 PDF SHA256 保存在 `workspace/literature-text/<SHA256>.json`，包含提取时间与页码文本；首次分析或提问时建立，之后复用。旧论文无需重新调用模型即可补建全文记录。原文版本变更会建立独立的全文记录，旧分析不会作为新版依据。

`POST /api/workspace/topics/:id/analysis/question` 请求 `{resourceIds,question,expectedHash,model?}`，最多 50 篇。先核对课题关联与分析版本，再以当前原文版本的已有事实及本地关键词检索片段组成有上限的证据材料，一次模型调用汇总回答，不替换 `analysis.json`。返回 `{question,answer,model,sources,analysisHash,createdAt,path}`，问答以新文件保存在 `materials/<课题ID>/文献分析/问答记录/`。引用保留 PDF 页码；检索片段不代表穷尽全文，回答需说明证据不足。409 不自动覆盖重试。停止与维护屏障沿用阅读任务约定。
- 接口按 PDF 页码提取完整文字（最多 150 页、50 MB、100 万字符），超限明确失败，不将截断内容冒充全文；扫描件需先 OCR。沿用现有模型凭据、调度和上下文边界，不修改模型配置。
- 输出保存为 `materials/<课题ID>/文献分析/analysis.json`。每篇包含源文件 hash、模型、分析时间、结构化事实及候选研究方向。事实的 `verified` 只表示引用文字在所标 PDF 页中匹配，不代表该论文主张已通过独立验证；不匹配的引用应在 UI 标为待核对。研究方向通过 factIds 关联推断依据。
- 逐篇分析只替换当前文献的结果，保留其他文献；处理前后核验原文版本及课题关联，409 不自动覆盖。当前课题已有阅读任务时拒绝第二次并行分析。阅读期间备份维护检查将其视为忙碌状态。

`GET /api/workspace/topics/:id/analysis/status` 返回 `{running:false}` 或 `{running:true,resourceId,filename,startedAt,phase}`，phase 为 extracting / reading / saving。文献分析页每 5 秒检查一次状态并加载已完成分析。离开该页停止检查，后台任务继续运行。文献选择列表按文件名自然数字顺序排列。

### 知识关系图

`GET /api/workspace/topics/:id/knowledge-graph` 返回 `{papers}`。每篇包含文献编号、标题、原文 SHA-256、全文来源（`ocr` 或 `pdf`）和关系。接口读取当前课题关联 PDF 的逐段 OCR 文本、已有段落译文，或已有逐页 PDF 文本缓存。相同原文版本只计一篇。处理在本机进行，按显式英文表述提取评测数据、评测模型、指标及对照关系。

每条关系包含具名主体（原文明示时）、类型、目标实体、PDF 页码、原文句子及可用的段落译文。页面显示已入图、已有全文及待处理的文献数量，支持按关系类型和原文／译文检索。单篇与课题概览分别按 12、40 条关系分页。原文链接携带 `sourceHash`，若文件版本已变更则返回 409。自动抽取范围受规则覆盖影响，需要用原文核对关系。

文献分析的事实条目可含 `entity` 规范短名称，与 `value` 的详细说明分离。短的精确原文名称可作为引用。格式失败返回 422，并在 `materials/<课题ID>/文献分析/失败记录/` 保存诊断 JSON，记录模型输出及校验路径。

## 受限科研单请求推理（W6）

能力标记 `GET /api/health.capabilities.researchInference:true`；部署新后台后才生效。
`POST /api/workspace/topics/:id/inference`，课题必须存在且未归档：

```json
{"model":"MiniMax-M3.1-Flash","messages":[{"role":"system","content":"研究协议"},{"role":"user","content":"任务"}],"maxCompletionTokens":2048,"effort":"low","runId":"pilot-001"}
```

model 是当前助手白名单中已启用的注册 ID；本轮只支持 minimax 服务下上游 model 为 MiniMax-M3.1-Flash。保留 ID 到实际 model 的映射证据。凭据必须已配置，不改变默认模型。messages 为 1–24 条纯文本，role 为 system/user/assistant，内容 UTF-8 合计最多 24000 字节；maxCompletionTokens 必填整数 64–8192；effort 必填 low。未知字段、工具、附件及解码控制参数拒绝。请求 JSON 上限 64 KiB。

一次请求只发一次上游，无自动工具、委派、压缩或重试，不注入写作提示。发送 max_completion_tokens、reasoning_effort:low、reasoning_split:true、stream_options.include_usage:true；不发送 temperature/top_p/seed。总超时 180 秒（包括调度等待），客户端断连取消，上游流上限 8 MiB。完成 token 上限包含思考的供应商语义仍需真实调用校准。

响应是 JSON，包含 text、reasoning、finishReason、原 usage 对象或 null、requestModelId、requestModel、responseModel（未报告则 null）、configRevision、topicId、runId、startedAt、endedAt、elapsedMs、parameters、upstreamSent、usageStatus、complete、visibleAnswer、status、error。stop 为 complete:true；空正文标 no_visible_answer。length 为 complete:false/status:truncated（HTTP 200 表示成功记录截断，不代表生成完成），保留空正文、思考和用量。中断、超时、错误、无效/缺失 usage 返回 HTTP 502/status:failed，保留已收集证据；usage 未知绝不补零。失败含 billingStatus:possibly_charged/not_sent；错误只返回固定安全代码。

调用方发送前累计请求次数；upstreamSent 仅表示已尝试调用，不能证明供应商接收。每次保存响应原对象；仅 complete:true 且 visibleAnswer:true、用量有效、模型符合预期后继续正常流程。任何失败、截断、usageStatus:unknown 都应停批核算，不自动重试。该接口不持久化研究日志，也不实现批量 token/费用限额；这些由调用方实现。
