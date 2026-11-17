# 研究对照（只读小视图）

每篇论文独立使用 `notes/research-map.json`，查看不创建、不同步、不修改研究依据或主稿。论文写作栏“研究对照”打开；课题从已关联论文中显式选择。无论文课题继续使用文字依据。

数据由研究助手基于原文显式生成，经现有 file API 带读取 hash 保存；新文件 expectedHash:null；409重读比较。不得以关键词、embedding或引用直接推断创新。此视图不含编辑器、自动查新、创新评分或科学完成判定。

schemaVersion=1，projectId必须匹配当前论文。完整校验类型见 shared/research-map.ts，JSON最高512KB。字段：title、asOf、sourceNoteSha256（绑定本论文 notes/research-basis.md 的当前hash）、scope、ours、papers、edges、evidence。sourceNote兼容旧输入，但依据核对固定读取本论文 notes/research-basis.md，不沿任意外部路径读取。

ours：id、short、question、approach、status、proposedDifference、falsifier。
papers：id、short、title、accomplishment、boundary、proposedDifference、comparisonStatus；可选year、role、url、anchor、relation、input。
edges：source、target（必须是论文或ours的id）、kind（问题承接/评估继承/机制重合/待证差异/反例/邻接支撑）、assertion、anchor、assessment；可选evidence（来源）、checkedAt（核对日期）、status。缺失核对日期/状态明确标为未记录/未单独核验，不把asOf推定为核对日期。
evidence：id、title、status、detail、scope、source；保留unknown、负结果和失败对照。

所有判断为研究者定位，非论文之间真实引用边或因果边。读取依据失败或hash不一致提示重核，保持原判断。视图为打开时快照；依据改动后需关闭并重新打开核对，不自动生成新结论。

链接仅支持无凭据HTTP(S)，或本论文 notes/、literature/、manuscript/ 内的md/json/pdf/txt/tex/bib/csv文件；相对路径含..、编码路径、HTML/SVG等只显示文字。原文在新页打开，原对象/选择/视图保留。输入HTML只作React文本渲染。

默认关系显示与本研究相关的前8条，选择局部论文查看其关系；方案对照提供完整文字替代、检索和横向滚动。没有力导图、额外依赖或图数据库。
