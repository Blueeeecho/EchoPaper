# 首版复用边界

本轮直接使用现有论文服务、模型网关、Tectonic 编译、会话与保存冲突机制，在其上扩展课题、资料索引和演示文稿。没有引入第二套论文主稿或独立翻译凭据。

## 实际采用

| 项目 | 本轮固定版本 | 许可 | 用途 |
|---|---|---|---|
| [pptx-automizer](https://github.com/singerla/pptx-automizer) | 0.9.4 | MIT | 从真实模板复制封面、目录、正文固定区域与资源，保留模板结构 |
| [PptxGenJS](https://github.com/gitbrent/PptxGenJS) | 3.12.0 | MIT | 生成可编辑文字、原生表格、图形、流程与图表，作为 automizer 的生成器 |
| [@napi-rs/canvas](https://github.com/Brooooooklyn/canvas) | 1.0.13 | MIT | 按指定字体测量正文、换行、检查内容边界，解码图片 |
| [JSZip](https://github.com/Stuk/jszip) | 3.10.1 | 选择 MIT 分支 | 校验并整理 OOXML 包关系，保存与检查 PPTX |
| [@xmldom/xmldom](https://github.com/xmldom/xmldom) | 0.9.10 | MIT | XML 字体修正、模板清理和结构检查 |

版本与许可取自当前安装包的 `package.json`，固定于 `package-lock.json`；本表不声称它们是上游最新版本。采用这组已通过集成回归的组合，避免混用不兼容的生成器版本。对应许可证随 npm 依赖保留在各包目录。

HZAU 模板沿用用户已有 `My_Report_ppt_GENERIC_clean_template_v2.pptx`，学校标识、照片与原有版式按用户模板保留。它们不因代码依赖采用 MIT 而自动改变权利归属。

## 设计参考与后续适配

[TagSpaces](https://github.com/tagspaces/tagspaces) 用于参考本地目录、标签和资源关联的组织方式，本轮没有复制其源代码。资料操作采用本工作台自己的授权目录、保护路径、hash、日志和撤销服务。

[Presenton](https://github.com/presenton/presenton) 与 [PPTist](https://github.com/pipipi-pikachu/PPTist) 未接入运行环境。首版通过结构化页面编辑生成 PPTX，完整自由画布留待后续。

[Zotero](https://www.zotero.org/support/dev/client_coding/connector_http_server)、[Citation.js](https://github.com/citation-js/citation-js)、[Open Notebook](https://github.com/lfnovo/open-notebook)、[MLflow](https://github.com/mlflow/mlflow) 与 [JupyterLab](https://github.com/jupyterlab/jupyterlab) 属于后续适配方向，本轮没有启动这些服务，也不在导航中展示未实现入口。文献、调研与实验适配将共用现有课题及资源身份模型。
