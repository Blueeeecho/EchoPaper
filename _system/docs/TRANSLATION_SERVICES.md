# EchoPaper 服务与 API 接入

打开工作台的「设置与模型」。三类设置分别保存：OCR 只解析版面，翻译 API 只生成译文，AI 助手负责对话和研究任务。即使同一厂商同时用于翻译和助手，也分别配置连接；可复用厂商账号，不自动共用工作台内的密钥。套餐、余额和可用地区以厂商控制台为准。

## 翻译 API

| 推荐连接 | 沿用模型 | 注册与取 Key |
| --- | --- | --- |
| 智谱 · GLM 翻译 | `glm-4-flash-250414` | 注册或登录[智谱开放平台](https://bigmodel.cn/usercenter/proj-mgmt/apikeys)，创建标准 API Key；[模型说明](https://docs.bigmodel.cn/cn/guide/models/free/glm-4-flash-250414)。已有翻译连接直接沿用。 |
| MiniMax · 翻译 | `MiniMax-M3.1-Flash` | 登录 [MiniMax 开放平台](https://platform.minimax.cn/docs/guides/quickstart-preparation)，在接口密钥中创建翻译用 Key；M Plan 用户在订阅管理核对模型权限和订阅 Key。登录站点、Key 和 API 地址须对应。 |

1. 在「翻译 API → 接入 API → 添加翻译 API」选择服务，填写 Key 并保存。「测试连接」只发送固定句子，可能产生少量用量，不发送稿件。
2. 已有 MiniMax 翻译来源曾使用助手连接时，新连接保存并测试后点「替换旧 MiniMax 来源」。工作台保留原来源编号、顺序及启用状态；旧助手绑定不会继续发请求。首次接入则点「加入翻译来源」。
3. 在「启用与排序」管理来源和对照布局。Ctrl（macOS 为 ⌃）+ 拖选文字时，只向已启用的翻译来源发送选区，不发送对话历史或 PDF 文件，不自动回写正文。其他已支持的翻译服务折叠在「其他翻译服务与新连接」，已有专用来源不删除。

同一个来源出错不会改用助手，也不自动切换到其他付费服务。只有 DeepL 支持额外阅读上下文，且须显式开启。源码选区会保护常见 LaTeX 命令、引用和公式；无法还原时拒绝损坏译文，可改选 PDF 文本或另一个翻译来源。

## OCR API

| 现有引擎 | 注册与取凭据 |
| --- | --- |
| 百度智能云 · Unlimited-OCR | 登录[百度智能云 OCR 控制台](https://console.bce.baidu.com/ai-engine/ocr/overview/index?type=6)，按提示认证并开通文档解析。填有「AI 开放能力」权限的 IAM API Key，或应用 `API Key:Secret Key`。[接入文档](https://ai.baidu.com/ai-doc/OCR/fmr1p39gb) |
| PaddleOCR · AI Studio | 登录[飞桨星河社区](https://aistudio.baidu.com/account/accessToken)，在访问令牌页复制 `Access Token`。[任务查询接口](https://ai.baidu.com/ai-doc/AISTUDIO/fml7mozw5) |

在「OCR API」分别选择引擎并保存凭据。测试只查询任务接口验证访问，不提交 PDF，也不代表任意文件都能解析成功。阅读器里单独选择引擎和发起解析；已有自动预处理行为仍由阅读库设置控制。不要在这里填写百度翻译或大模型的密钥。

## AI 助手

常用预设为 [MiniMax](https://platform.minimax.cn/docs/guides/quickstart-preparation)、[DeepSeek](https://platform.deepseek.com/api_keys)、[智谱 GLM](https://docs.bigmodel.cn/cn/guide/start/quick-start)。选已有开发者账户即可，无需三家都注册。自定义 Chat Completions 与本地 Ollama 在「自定义与本地服务」。

在「AI 助手 → 接入 API → 添加助手 API」填写密钥、保存并测试；然后到「助手模型与角色」选择默认模型。这里只列助手连接，翻译和 OCR 不会出现在助手模型列表中。

## 本地接口与验收

凭据写入系统凭据存储，公开配置和备份仅含状态。更换 API 地址后为新地址单独配置。程序调用见 [LOCAL_API.md](LOCAL_API.md)，早期多来源探索见 [历史验收记录](../qa/Bob翻译服务接入验收.md)。自动化可使用隔离工作区、测试凭据和模拟上游验证配置与分流；真实账户的可用权限须在各自的设置页测试。
