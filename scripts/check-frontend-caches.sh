#!/usr/bin/env bash
# 防回归：组件外的服务端设置缓存必须走 src/lib/settingCache.ts（版本守卫+保存广播）。
# 手写「let xCache + xLoading ??= getSettings()」有两个坑：
#   1) 在途加载晚于保存返回，旧值覆盖刚保存的新值
#   2) 无变更通知，展示缓存值的 UI 永远陈旧且无从发现
# 均曾真实发生（慢速倍率「设置改 0.5 长按仍 0.75」）。TTL 自愈型缓存（modelsCache）豁免。
set -euo pipefail
cd "$(dirname "$0")/.."
# 两种已知形态：`x ??= getSettings(` 与 `x = getSettings().then`（直接赋值建缓存）。
# 残留盲区（await 赋值、间接包装等）靠评审与 AGENTS.md 约定兜底，本脚本拦大头
bad=$(grep -rn --include='*.ts' --include='*.tsx' -E '(\?\?=\s*getSettings\(|=\s*getSettings\(\)\s*\.\s*then)' src/ \
  | grep -v 'src/lib/settingCache.ts' || true)
if [ -n "$bad" ]; then
  echo "✗ 发现手写一次性设置缓存，请改用 src/lib/settingCache.ts 的 makeSettingCache："
  echo "$bad"
  exit 1
fi
