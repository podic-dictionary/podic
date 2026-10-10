/// AI Provider 预设：国内外主流厂商的 base URL / 协议 / 旗舰模型，点选即预填。
/// 端点来自 models.dev（opencode 的数据源）并逐家实测（假 key 得 401/400 = 路径正确）；
/// 模型名按 models.dev 发布日期取最新文本旗舰，随官方演进，可自由增删
export interface ProviderPreset {
  label: string;
  protocol: "openai" | "anthropic";
  baseUrl: string;
  models: string[];
  /** 搜索用别名（拼音/常用叫法） */
  alias?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  // ---- 国外 ----
  {
    label: "OpenAI",
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-6.1-sol", "gpt-6-sol"],
  },
  {
    label: "Anthropic Claude",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    models: ["claude-sonnet-5-5", "claude-haiku-5-5"],
    alias: "claude 克劳德",
  },
  {
    label: "Google Gemini",
    protocol: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: ["gemini-3.8-flash", "gemini-flash-latest"],
    alias: "gemini 谷歌",
  },
  {
    label: "xAI Grok",
    protocol: "openai",
    baseUrl: "https://api.x.ai/v1",
    models: ["grok-4.7", "grok-4.6"],
    alias: "grok 马斯克",
  },
  {
    label: "Mistral",
    protocol: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    models: ["mistral-large-latest"],
    alias: "mistral 法国",
  },
  {
    label: "Groq",
    protocol: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    models: ["llama-3.3-70b-versatile"],
  },
  {
    label: "OpenRouter",
    protocol: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    models: ["openai/gpt-6.1-sol", "anthropic/claude-sonnet-5-5"],
    alias: "openrouter 聚合",
  },
  {
    label: "Perplexity",
    protocol: "openai",
    baseUrl: "https://api.perplexity.ai",
    models: ["sonar-pro"],
    alias: "perplexity 搜索",
  },
  {
    label: "Together",
    protocol: "openai",
    baseUrl: "https://api.together.xyz/v1",
    models: ["meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8"],
    alias: "together 聚合",
  },
  {
    label: "Fireworks",
    protocol: "openai",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    models: ["accounts/fireworks/models/kimi-k2-instruct"],
    alias: "fireworks 聚合",
  },
  // ---- 国内 ----
  {
    label: "DeepSeek",
    protocol: "openai",
    baseUrl: "https://api.deepseek.com",
    models: ["deepseek-v4-flash", "deepseek-flash"],
    alias: "deepseek 深度求索",
  },
  {
    label: "智谱（bigmodel.cn）",
    protocol: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-5.3-flashx", "glm-5.3-flash"],
    alias: "zhipu 智谱 glm bigmodel",
  },
  {
    label: "智谱 Coding Plan（bigmodel.cn）",
    protocol: "openai",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    models: ["glm-5.3-flash", "glm-5.3-highspeed"],
    alias: "zhipu 智谱 coding",
  },
  {
    label: "z.ai（API 按量）",
    protocol: "openai",
    baseUrl: "https://api.z.ai/api/paas/v4",
    models: ["glm-5.3-flashx", "glm-5.3-flash"],
    alias: "zai 智谱国际 glm",
  },
  {
    label: "z.ai（Coding Plan）",
    protocol: "openai",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    models: ["glm-5.3-flash", "glm-5.3-highspeed"],
    alias: "zai 智谱国际 coding",
  },
  {
    label: "Kimi（Moonshot）",
    protocol: "openai",
    baseUrl: "https://api.moonshot.cn/v1",
    models: ["kimi-k3", "kimi-k2.7-code-highspeed"],
    alias: "kimi moonshot 月之暗面",
  },
  {
    label: "Kimi Coding（kimi.com）",
    protocol: "openai",
    baseUrl: "https://api.kimi.com/coding/v1",
    models: ["kimi-for-coding", "k3-256k"],
    alias: "kimi coding 月之暗面",
  },
  {
    label: "MiniMax",
    protocol: "anthropic",
    baseUrl: "https://api.minimax.cn/anthropic/v1",
    models: ["MiniMax-M3", "MiniMax-M2.7-highspeed"],
    alias: "minimax 海螺",
  },
  {
    label: "阿里云百炼",
    protocol: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen3.8-flash", "qwen3.7-plus"],
    alias: "dashscope qwen 通义 阿里",
  },
  {
    label: "阿里云百炼（Coding Plan）",
    protocol: "openai",
    baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
    models: ["qwen3.7-plus", "qwen3.6-plus"],
    alias: "dashscope qwen 通义 coding",
  },
  {
    label: "腾讯云 TokenHub",
    protocol: "openai",
    baseUrl: "https://tokenhub.tencentmaas.com/v1",
    models: ["hy4-preview", "hy3"],
    alias: "tencent 腾讯 混元 hunyuan",
  },
  {
    label: "腾讯云 Coding Plan",
    protocol: "openai",
    baseUrl: "https://api.lkeap.cloud.tencent.com/coding/v3",
    models: ["tc-code-latest", "hunyuan-turbos"],
    alias: "tencent 腾讯 coding 混元",
  },
  {
    label: "字节火山方舟",
    protocol: "openai",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    models: ["doubao-seed-1-6", "deepseek-v3-1-terminus"],
    alias: "volcengine 火山 豆包 doubao 字节",
  },
  {
    label: "字节火山方舟（Coding Plan）",
    protocol: "openai",
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
    models: ["doubao-seed-code-1-6", "klm-r-11b"],
    alias: "volcengine 火山 豆包 coding 字节",
  },
  {
    label: "小米 MiMo",
    protocol: "openai",
    baseUrl: "https://api.xiaomimimo.com/v1",
    models: ["mimo-v2.6-pro", "mimo-v2.6-flash"],
    alias: "xiaomi mimo 小米",
  },
  {
    label: "小米 MiMo（Token Plan）",
    protocol: "openai",
    baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
    models: ["mimo-v2.6-pro", "mimo-v2.6-flash"],
    alias: "xiaomi mimo 小米 token",
  },
  {
    label: "SiliconFlow 硅基流动",
    protocol: "openai",
    baseUrl: "https://api.siliconflow.cn/v1",
    models: ["zai-org/GLM-5.2", "deepseek-ai/DeepSeek-V4-Pro"],
    alias: "siliconflow 硅基 聚合",
  },
  {
    label: "阶跃星辰 StepFun",
    protocol: "openai",
    baseUrl: "https://api.stepfun.com/v1",
    models: ["step-5-preview", "step-3.7-flash"],
    alias: "stepfun 阶跃",
  },
  {
    label: "讯飞星火 SenseNova",
    protocol: "openai",
    baseUrl: "https://token.sensenova.cn/v1",
    models: ["sensenova-6.8-flash-lite", "deepseek-v4-pro"],
    alias: "讯飞 iflytek sensenova 星火",
  },
  {
    label: "魔搭 ModelScope",
    protocol: "openai",
    baseUrl: "https://api-inference.modelscope.cn/v1",
    models: ["ZhipuAI/GLM-4.6", "Qwen/Qwen3-Coder-30B-A3B-Instruct"],
    alias: "modelscope 魔搭 阿里 免费",
  },
];

/// 预设搜索：label/别名/URL 子串匹配（大小写不敏感）
export const searchPresets = (q: string): ProviderPreset[] => {
  const query = q.trim().toLowerCase();
  if (!query) return PROVIDER_PRESETS;
  return PROVIDER_PRESETS.filter((p) =>
    `${p.label} ${p.alias ?? ""} ${p.baseUrl}`.toLowerCase().includes(query),
  );
};
