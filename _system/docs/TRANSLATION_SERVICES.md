# Bob 调研与 EchoPaper 翻译服务接入

核查日期：2026-10-23。下列额度是公开规则快照，不是本机账户余额；最终以服务商控制台、地区和账户资格为准。

## 借鉴的产品逻辑

[App Store 的 Bob](https://apps.apple.com/cn/app/id1630034110) 支持多翻译服务对照。[Bob 官方服务说明](https://bobtranslate.com/guide/advance/service.html) 将内置服务、用户自行申请密钥的服务、JavaScript 插件分开。EchoPaper 借鉴“独立服务配置 → 启用来源 → 排序对照”的流程，保留现有 Ctrl 划词、拖动与固定浮窗、结果折叠、复制、重试和多列布局。

Bob 内置服务可能有专属合作额度，不能转给 EchoPaper。这里使用用户自行申请的 API Key；没有复制 Bob 的代码，也不执行 `.bobplugin`。其他 OpenAI 兼容服务继续通过原有通用配置接入；不同协议可通过本机适配器扩展。

## 本次接入与额度

| 服务 | 公开免费规则 | 配置要求与边界 | 官方依据 |
| --- | --- | --- | --- |
| 硅基流动 | `tencent/Hunyuan-MT-7B` 当前价格为免费 | 个人 API Key、平台权限和限流；其他模型不一定免费 | [价格页](https://siliconflow.cn/pricing)、[调用指南](https://api-docs.siliconflow.cn/docs/userguide/quickstart) |
| 智谱 | `glm-4-flash-250414` 明确为免费 API | 智谱 API Key；受并发和速率限制；预设另提供官方免费模型目录中的 `glm-4.7-flash`，切换前可核查其规则 | [免费模型文档](https://docs.bigmodel.cn/cn/guide/models/free/glm-4-flash-250414)、[GLM-4.7-Flash](https://docs.bigmodel.cn/cn/guide/models/free/glm-4.7-flash) |
| 小牛翻译 | 注册后每日 100 积分，约 20 万字符 | 自行申请 API Key；实际到账、积分消耗以账户为准 | [官网](https://niutrans.com)、[官方接口示例](https://github.com/NiuTrans/MCP-TextTranslation) |
| 百度通用翻译 | 标准版每月 5 万字符；个人认证高级版每月 100 万 | APP ID + Secret Key；标准版 QPS=1，额度外可能计费 | [服务版本](https://fanyi-api.baidu.com/access/0/1)、[接入说明](https://fanyi-api.baidu.com/doc/13) |
| DeepL | API Free 每月 50 万字符 | 需 API Free 账户，地区/资格限制以官网为准；网页订阅与 API 分开 | [API 计划说明](https://support.deepl.com/hc/en-us/articles/360021200939-DeepL-API-plans) |
| Microsoft Translator | F0 免费层每月 200 万字符 | 创建 Azure Translator 资源，明确选 F0；区域资源需要 Region，global 资源可留空 | [官方定价](https://azure.microsoft.com/en-us/pricing/details/translator/)、[认证说明](https://learn.microsoft.com/azure/ai-services/translator/text-translation/reference/authentication) |
| Qwen-MT | 北京地域价格表列每模型 100 万 tokens，通常 90 天有效 | 百炼对应地域的 API Key 和业务空间地址；属于试用额度，非每日/月刷新；不等同于 Token / Coding Plan | [定价与有效期](https://help.aliyun.com/en/model-studio/model-pricing)、[专用翻译 API](https://help.aliyun.com/zh/model-studio/machine-translation) |

**未沿用腾讯旧 TMT 的“每月 500 万免费”推荐**：[2026-09-21 更新的快速入门](https://cloud.tencent.com/document/product/551/104415) 提醒旧服务不再支持新用户，自 2026-10-01 起停止发放新的免费资源包；旧定价页与 Bob 汇总仍可能保留历史数字。硅基流动托管的 Hunyuan-MT-7B 是另一条服务渠道，不能混同。

建议先申请硅基流动或智谱密钥，再考虑小牛的日额度；这是基于公开计费规则和接入便利性的选择，未对翻译质量做排名或效果认证。

## 使用流程

1. 打开 AI 助手或翻译浮窗的齿轮，进入“模型与 API”。
2. 在“模型与翻译服务”中点“浏览翻译服务”，选择服务卡片。也可通过左侧下拉框添加多个账户。
3. 填写自己的密钥；百度额外填 APP ID，Microsoft 按资源填 Region。Qwen-MT 从百炼控制台复制对应地域、业务空间的兼容模式 Base URL。
4. 保存服务后测试连接。测试只发送一句英文样例，消耗相应服务的少量用量。
5. 点击“加入翻译来源”，或在“翻译来源”中添加/选择引擎。勾选、排序，选择纵向或并排布局并保存。
6. 按住真实 Ctrl（Mac 上为 ⌃）拖选 PDF 或源码中的文字。普通拖选不调用接口；未固定的临时浮窗点击外部关闭。

保存服务不会自动启用新的翻译来源，也不会测试或发送稿件。加入来源后，下次翻译会发送当前选区；打开已有选区的翻译设置并保存来源时，浮窗可能立即按新来源翻译。不要启用不准备使用的来源。

## 接口与安全边界

- 新建的翻译服务是独立配置：密钥保存在 macOS 钥匙串，公开 JSON、备份、页面存储不含密钥；更换服务地址后需要重新配置该地址的凭据。
- DeepL 使用专用认证；Microsoft 使用订阅密钥/Region；百度在后端执行 MD5 签名；小牛在 HTTPS POST 表单中提交密钥。
- Qwen-MT 使用 `translation_options`、单条 user 消息；Hunyuan-MT 使用官方翻译提示模板、无 system 消息；智谱用单轮翻译提示。均不附带稿件、聊天历史或推理强度，不设置输出 token 上限，仍受服务本身限制。
- 原有 MiniMax 与自定义 OpenAI 兼容来源保持原来的流式翻译路径。专用翻译 API 返回整段结果；一个来源失败不会隐藏其他来源，失败结果不会缓存。不自动改用其他付费服务。
- 每次最多 6000 字符。百度按保守长度分段并限制调用频率，小牛长文本分段；代理端点需兼容所选服务的协议。没有自动购买、充值或查询真实余额。
- 源码选区用占位符保护常见公式、命令、引用键；服务破坏保护标记时拒绝显示损坏的结果，提示改选 PDF 或使用通用模型。复杂 TeX 结构不承诺全语法支持；翻译仅供阅读，绝不自动回写正文。

## 扩展与本地 Codex

公开预设在 `shared/translation-services.ts`，注册字段验证在 `server/model-providers.ts`，专用请求/认证适配器在 `server/translation-services.ts`。前端 `src/translationAdapters.ts` 将专用服务与旧模型来源统一为有序结果卡片。新增协议需要服务端适配器；不能仅将任意非兼容 API 地址填入 OpenAI 服务。

程序接口见 [LOCAL_API.md](LOCAL_API.md)。可读取服务目录、公开配置、带 revision 保存配置，以及指定 sourceId 翻译，不需要 Codex 读取钥匙串里的密钥。

## 验证范围

见 [验收记录](../qa/Bob翻译服务接入验收.md)。自动化和浏览器使用隔离工作区、注入的凭据存储及模拟上游，未向真实新服务发送稿件，也未宣称七家服务的账户连通性都已通过。真实调用需要相应账户密钥；可在保存后点“测试连接”验证。
