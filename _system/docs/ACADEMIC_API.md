# EchoPaper 学术工作区与演示文稿 API

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
| `Resource` | `id,rootId,path,name,kind,size,modifiedAt,tags,missing,revision,hash?,snippet?`；`kind` 为 `file/directory`，path 相对于已连接来源 |
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
| `PATCH /api/workspace/resources/:id` | `{tags:string[],expectedRevision}` → 新 `Resource` | `resources tag <ID> --input tags.json` |
| `POST /api/workspace/resources/:id/relink` | `{rootId,path,expectedRevision}` → 保留原 ID 的新 `Resource` | `resources relink <ID> --input relink.json` |
| `GET /api/workspace/resources/:id/text` | 支持的文本/PDF → `{content,hash}`；受大小与页数限制 | 直接调用 HTTP |
| `GET /api/workspace/resources/:id/raw` | 文件流；PDF、允许的图片及纯文本可预览，其余下载 | 直接调用 HTTP |
| `POST /api/workspace/resources/:id/reveal` | 在本机 Finder 显示已校验资源 | 网页/直接调用 HTTP |

q 检索文件名、路径、标签及已提取文本。HTTP `path` 缺省时不限定父目录，`path=""` 列来源顶层，其他值精确指定父目录；`offset` 默认 0，`limit` 默认 200，范围 1–1000。CLI 搜索采用默认分页，复杂筛选使用 HTTP。HTML/SVG 等主动内容不以内联网页形式执行；原始响应携带禁嗅探及沙箱限制。

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
| `GET /api/presentations` | `{presentations:PresentationSummary[]}` | `presentations list` |
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

完整备份包含 `workspace/` 中的目录索引、课题/标签/关联/整理日志、PPT 工程、显式冻结资产、任务与产物，以及 `shared/` 中的版本化样式包。外部来源目录原件及其 `.echopaper-trash` 均不包含在工作区备份内，不能靠恢复工作区备份找回已经在外部永久删除的原件。仅在明确添加为 PPT 材料时创建的工程内快照随工程备份。

备份/恢复期间使用工作区维护屏障，活动编译、AI 或演示任务及目录写入会阻止不一致快照。恢复工作区数据不移动外部原件，不自动重做整理日志；完成后按恢复接口要求重启。密钥仍留在本机凭据管理中，备份只包含允许的非密钥配置。
