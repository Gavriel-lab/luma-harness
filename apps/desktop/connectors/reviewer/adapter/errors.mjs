// bridge v1 错误码 ↔ 适配器内部处理策略。
// 未知错误一律归为 unknown，不把所有错误猜作无额度（共享约定要求）。

export const BRIDGE_ERROR_CODES = [
  "unauthenticated",
  "forbidden",
  "stale_attempt",
  "context_stale",
  "permission_required",
  "quota_exhausted",
  "network_error",
  "executor_unavailable",
  "unsupported_schema",
  "unknown",
];

export function normalizeBridgeError(body, httpStatus) {
  if (body && body.ok === false && body.code && BRIDGE_ERROR_CODES.includes(body.code)) {
    return { code: body.code, message: body.message ?? "", retryable: body.retryable === true, httpStatus };
  }
  if (body && body.ok === false) {
    return { code: "unknown", message: body.message ?? "bridge returned ok:false without known code", retryable: false, httpStatus };
  }
  return { code: "unknown", message: `unexpected bridge response (http ${httpStatus})`, retryable: false, httpStatus };
}

export function networkError(message) {
  return { code: "network_error", message, retryable: true, httpStatus: 0 };
}

// 对适配器行为的意义：
// - stale_attempt / cancelled 场景：放弃当前执行，不再上报 progress（旧 attempt 不改变当前任务）
// - context_stale：重新拉取 context 后重续（checkpoint 保留）
// - unauthenticated / forbidden：停止轮询，报告 blocked，等待人工
// - network_error / retryable：指数退避重试
// - executor_unavailable / quota_exhausted：上报 blocked，保留租约心跳直至超时
export function shouldAbortAttempt(err) {
  return err.code === "stale_attempt" || err.code === "unauthenticated" || err.code === "forbidden";
}

export function shouldReportBlocked(err) {
  return err.code === "permission_required" || err.code === "executor_unavailable" || err.code === "quota_exhausted";
}
