/// AI Provider 预设：知名厂商的 base URL / 协议 / 代表模型，点选即预填。
/// 数据来自 models.dev（opencode 的 provider 数据源），模型名随官方演进，
/// 预填的只是常见旗舰，用户可自由增删
export interface ProviderPreset {
  label: string;
  protocol: "openai" | "anthropic";
  baseUrl: string;
  models: string[];
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    label: "DeepSeek",
    protocol: "openai",
    baseUrl: "https://api.deepseek.com",
    models: ["deepseek-v4-flash", "deepseek-flash"],
  },
  {
    label: "z.ai（API 按量）",
    protocol: "openai",
    baseUrl: "https://api.z.ai/api/paas/v4",
    models: ["glm-4.5", "glm-5.3-flash"],
  },
  {
    label: "z.ai（Coding Plan）",
    protocol: "openai",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    models: ["glm-5.3-flash", "glm-4.7"],
  },
  {
    label: "Kimi（Moonshot）",
    protocol: "openai",
    baseUrl: "https://api.moonshot.cn/v1",
    models: ["kimi-k2.7-code", "kimi-k2.6"],
  },
  {
    label: "MiniMax",
    protocol: "anthropic",
    baseUrl: "https://api.minimax.cn/anthropic/v1",
    models: ["MiniMax-M3", "MiniMax-M2.1"],
  },
  {
    label: "阿里云百炼",
    protocol: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen-flash", "qwen3.5-flash"],
  },
  {
    label: "阿里云百炼（Coding Plan）",
    protocol: "openai",
    baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
    models: ["qwen3-coder-next", "qwen3.5-plus"],
  },
  {
    label: "腾讯云 TokenHub",
    protocol: "openai",
    baseUrl: "https://tokenhub.tencentmaas.com/v1",
    models: ["hy3", "hy3-preview"],
  },
  {
    label: "小米 MiMo（Token Plan）",
    protocol: "openai",
    baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
    models: ["mimo-v2.6-pro", "mimo-v2.5"],
  },
  {
    label: "SiliconFlow 硅基流动",
    protocol: "openai",
    baseUrl: "https://api.siliconflow.cn/v1",
    models: ["Qwen/Qwen3.5-27B"],
  },
];
