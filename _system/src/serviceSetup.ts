import {MINIMAX_FLASH_MODEL,type TranslationServiceKind} from '../shared/model-providers';

export interface ServiceSetup {
 label:string;
 summary:string;
 badge?:string;
 account?:string;
 docs?:string;
 steps:string[];
}

export const assistantSetups={
 minimax:{label:'MiniMax',badge:'推荐 · 已有国内账号',summary:'内置常用模型与国内 API 地址。',account:'https://platform.minimax.cn/console/keys',docs:'https://platform.minimax.cn/docs/guides/quickstart-preparation',steps:['登录 MiniMax 开放平台。按量账户在「接口密钥」创建 Key；M Plan 用户在「订阅管理」复制订阅 Key。','粘贴对应的 Key。有国际站账户时，使用同站 Key 和 https://api.minimax.io/v1；模型须在你的套餐中可用。']},
 deepseek:{label:'DeepSeek',summary:'预填 DeepSeek 官方 API 与 deepseek-flash。',account:'https://platform.deepseek.com/api_keys',docs:'https://api-docs.deepseek.com/',steps:['注册或登录 DeepSeek 开放平台，在「API Keys」新建密钥。','粘贴 Key，保留预填的官方地址；使用前在开放平台查看 API 余额。']},
 zhipu:{label:'智谱 · GLM',summary:'预填智谱开放平台 API 与 GLM-4.7-Flash。',account:'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',docs:'https://docs.bigmodel.cn/cn/guide/start/quick-start',steps:['注册或登录智谱开放平台，在个人中心创建模型标准 API Key。','粘贴 Key。若使用 Coding Plan，请同时换成该套餐的 Key 和官方专属端点。']},
 compatible:{label:'自定义 Chat Completions',summary:'接入你已有的兼容模型服务。',steps:['在供应商的开发者平台申请 API Key，复制 Chat Completions 的 Base URL 和模型 ID。','填入地址和 Key，保存后读取模型列表或手动添加模型。上下文窗口和工具调用能力按供应商文档设置。']},
 local:{label:'本地 Ollama',badge:'不需要云端密钥',summary:'连接已运行的本机 Ollama 与本地模型。',docs:'https://docs.ollama.com/api/openai-compatibility',steps:['按 Ollama 官方文档安装并启动服务，下载并运行本地模型。','使用预填的本机地址，无需填 Key；保存后点「读取模型」。']},
} satisfies Record<string,ServiceSetup>;
export type AssistantPreset=keyof typeof assistantSetups;
export const recommendedAssistantPresets=['minimax','deepseek','zhipu'] as const;
export const recommendedTranslationPresets=['zhipu-translate','minimax-translate'] as const;

export const translationSetups:Record<TranslationServiceKind,ServiceSetup>={
 niutrans:{label:'小牛翻译',summary:'专用文本翻译，需单独配置 API Key。',account:'https://niutrans.com',docs:'https://niutrans.com/documents/contents/trans_text',steps:['在小牛翻译云平台注册或登录，进入控制台，找到文本翻译 API 的 API Key。','粘贴 API Key，保留预填地址。实际额度以账户为准。']},
 deepl:{label:'DeepL',summary:'专用文本翻译，可选发送阅读上下文。',account:'https://www.deepl.com/your-account/keys',docs:'https://developers.deepl.com/docs/getting-started/auth',steps:['注册并开通 DeepL API 方案，在账户的「API Keys」页面创建或复制 Key。网页翻译订阅不等同于 API。','粘贴 API Key。Free 方案用预填地址；Pro 方案改为 https://api.deepl.com/v2。']},
 'baidu-translate':{label:'百度翻译',summary:'接入百度翻译开放平台的通用文本翻译。',account:'https://fanyi-api.baidu.com/product/11',docs:'https://fanyi-api.baidu.com/product/113',steps:['登录百度翻译开放平台，按页面要求认证，开通「通用文本翻译 API」。','从翻译控制台复制 APP ID 和密钥，分别填入对应字段。不要填百度智能云 OCR 凭据。']},
 'microsoft-translator':{label:'Microsoft 翻译',summary:'适合已有 Azure 订阅的用户。',account:'https://portal.azure.com/',docs:'https://learn.microsoft.com/azure/ai-services/translator/how-to/create-translator-resource',steps:['登录 Azure，在订阅内创建 Translator 资源，核对所选定价层。','在资源的「密钥和终结点」复制订阅密钥与区域；区域资源要填写 Region。']},
 'qwen-mt':{label:'通义千问 · Qwen-MT',summary:'百炼的专用翻译模型，可选择 Flash、Plus 或 Lite。',account:'https://bailian.console.aliyun.com/',docs:'https://help.aliyun.com/zh/model-studio/machine-translation',steps:['登录阿里云百炼，开通模型服务，创建业务空间所用的 API Key。','填写同地域、同业务空间的兼容模式 Base URL 和 Key；地址末尾不要加 /chat/completions。']},
 'siliconflow-translate':{label:'硅基流动 · 混元翻译',summary:'通过个人 Key 使用预填的 Hunyuan-MT 翻译模型。',account:'https://cloud.siliconflow.cn/account/ak',docs:'https://api-docs.siliconflow.cn/docs/userguide/quickstart',steps:['登录硅基流动，按提示完成认证，在「API 密钥」新建 Key。','粘贴同站点的 Key，确认模型广场中所选翻译模型对账户可用。']},
 'zhipu-translate':{label:'智谱 · GLM 翻译',summary:'沿用现有的 GLM-4-Flash-250414。',account:assistantSetups.zhipu.account,docs:'https://docs.bigmodel.cn/cn/guide/models/free/glm-4-flash-250414',steps:['注册或登录智谱开放平台，在 API Key 管理中创建密钥；已有翻译连接无需重新配置。','新接入时，将 Key 填入翻译 API，保留预填地址和模型。此连接不用于助手对话。']},
 'minimax-translate':{label:'MiniMax · 翻译',summary:`沿用现有的 ${MINIMAX_FLASH_MODEL}，单独配置翻译连接。`,account:assistantSetups.minimax.account,docs:'https://platform.minimax.cn/docs/api-reference/text-openai-api',steps:['可登录已有 MiniMax 开放平台账号。按量账户可为翻译创建单独的接口 Key；使用 M Plan 时在「订阅管理」核对可用模型和对应 Key。','将 Key 填在此处，平台不会从助手读取。国内与国际站的 Key 应与各自的 API 地址匹配。','保存并测试后，如出现「替换旧 MiniMax 来源」，点击即可保留原顺序。']},
};

export const ocrSetups={
 'unlimited-ocr':{label:'百度智能云 · Unlimited-OCR',badge:'推荐 · 文档版面解析',summary:'识别 PDF 的文字、表格和版面；不翻译。',account:'https://console.bce.baidu.com/ai-engine/ocr/overview/index?type=6',docs:'https://ai.baidu.com/ai-doc/OCR/fmr1p39gb',steps:['注册或登录百度智能云，按控制台提示认证并在文字识别服务中开通「文档解析（Unlimited-OCR）」。','复制有「AI 开放能力」权限的 IAM API Key；也可填对应应用的 API Key:Secret Key（英文冒号分隔）。'],keyLabel:'百度智能云 OCR 密钥',placeholder:'IAM API Key 或 API Key:Secret Key'},
 'aistudio-vl':{label:'PaddleOCR · AI Studio',badge:'备选 · 独立令牌',summary:'用星河社区的 PaddleOCR 托管 API 解析版面。',account:'https://aistudio.baidu.com/account/accessToken',docs:'https://ai.baidu.com/ai-doc/AISTUDIO/fml7mozw5',steps:['注册或登录飞桨星河社区，进入「账户设置 → 访问令牌」。','复制 Access Token。不要填百度翻译 APP ID 或智能云 OCR 密钥。'],keyLabel:'AI Studio Access Token',placeholder:'粘贴 PaddleOCR 的 Access Token'},
} satisfies Record<string,ServiceSetup&{keyLabel:string;placeholder:string}>;
export type OcrEngineId=keyof typeof ocrSetups;
export function isOcrEngineId(value:unknown):value is OcrEngineId{
 return typeof value==='string'&&Object.hasOwn(ocrSetups,value);
}
