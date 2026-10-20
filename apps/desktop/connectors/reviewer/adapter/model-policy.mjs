// R1 模型选择规则（使用者 2026-10-07）：默认 GLM-5.3-Flash；
// 仅当 Flash 明确额度耗尽且同账号 GLM-5.3 可用时，每回合最多自动切换一次。
// 网络故障、模型未注册、缺少模型选择、鉴权失败、普通限流、原因不明——一律不得冒充额度不足。

// 只认明确指向额度/余额耗尽的错误码；RATE/LIMIT/NETWORK/AUTH/UNREGISTERED/TIMEOUT 不匹配
export const QUOTA_PATTERN = /(QUOTA|EXHAUST|INSUFFICIENT|BALANCE|CREDIT)/i;
// 显式排除项（防止未来错误码同时含两 类词时误切）
export const NON_QUOTA_PATTERN = /(RATE.?LIMIT|NETWORK|AUTH|UNREGISTER|NOT.?FOUND|TIMEOUT|CONFIGURATION)/i;

export function isQuotaExhausted(terminal) {
  if (!terminal || terminal.status !== "failed") return false;
  const code = String(terminal.errorCode ?? "");
  if (!code) return false;
  return QUOTA_PATTERN.test(code) && !NON_QUOTA_PATTERN.test(code);
}

// modelChain: [{providerId, modelId}, ...]（运行时注册表实际 ID，不凭展示名猜）
// modelUsed: 当前回合实际使用的模型；fallbackUsed: 本回合是否已切换过
export function decideModelSwitch({ terminal, modelUsed, fallbackUsed = false, modelChain = [] }) {
  if (fallbackUsed) return null; // 每回合最多一次自动切换
  if (!isQuotaExhausted(terminal)) return null;
  const idx = modelChain.findIndex((m) => m.modelId === modelUsed?.modelId && (!modelUsed.providerId || m.providerId === modelUsed.providerId));
  if (idx === -1) return null;
  const next = modelChain[idx + 1];
  if (!next) return null; // 套餐内可用模型已到头：停止并报告，不来回循环
  return { next, reason: `quota_exhausted:${terminal.errorCode}`, from: modelChain[idx] };
}
