// R1 修2：模型启动前的完整绑定核对。
// manifest / session / claim / packet 的 schema、成员、执行器、小屋、实例代次，
// 以及 job/ticket/task/attempt、批准 workspace、contextVersion 必须一致。
// packet 只允许收窄 claim 批准目录，不允许扩大。

import { resolve, sep, isAbsolute } from "node:path";

export function normalizePath(p) {
  if (typeof p !== "string" || !p) return null;
  try {
    const r = resolve(p);
    if (!isAbsolute(r)) return null;
    return r.endsWith(sep) ? r.slice(0, -1) : r;
  } catch {
    return null;
  }
}

// Windows 大小写不敏感；统一小写比较（对 POSIX 仅在极端大小写同名时保守误判，可接受）
function samePath(a, b) {
  const na = normalizePath(a), nb = normalizePath(b);
  if (!na || !nb) return false;
  return na.toLowerCase() === nb.toLowerCase();
}

function pathInside(child, parent) {
  const nc = normalizePath(child), np = normalizePath(parent);
  if (!nc || !np) return false;
  const lc = nc.toLowerCase(), lp = np.toLowerCase();
  return lc === lp || lc.startsWith(lp + sep.toLowerCase());
}

export function verifyBinding({ manifest, session, claim, packet }) {
  const reasons = [];
  const missing = []; // 需主端补齐的字段

  if (!packet || typeof packet !== "object") return { ok: false, reasons: ["packet:missing"], missing: ["packet"] };
  if (packet.schemaVersion !== 1) reasons.push("packet.schemaVersion");
  if (packet.agentId !== manifest.agentId) reasons.push("agentId:manifest-vs-packet");
  if (session?.agentId && packet.agentId !== session.agentId) reasons.push("agentId:session-vs-packet");
  if (session?.executorId && packet.executorId && packet.executorId !== session.executorId) reasons.push("executorId");
  if (manifest.homeId && packet.homeId && packet.homeId !== manifest.homeId) reasons.push("homeId");
  if (manifest.homeId && packet.homeId === undefined) missing.push("packet.homeId");
  if (session?.generation !== undefined && manifest.generation !== undefined && session.generation !== manifest.generation) {
    reasons.push("generation:instance-mismatch");
  }

  const job = packet.job ?? {};
  if (claim) {
    if (job.jobId !== claim.jobId) reasons.push("jobId:claim-vs-packet");
    if (claim.ticketId && job.ticketId && job.ticketId !== claim.ticketId) reasons.push("ticketId");
    if (claim.taskId && job.taskId && job.taskId !== claim.taskId) reasons.push("taskId");
    if (job.attemptId && job.attemptId !== claim.attemptId) reasons.push("attemptId");
    if (typeof job.workspace !== "string" || !job.workspace) {
      missing.push("packet.job.workspace");
    } else if (!pathInside(job.workspace, claim.workspace)) {
      // packet 工作目录必须是 claim 批准目录本身或其子目录（收窄可以，扩大不行）
      reasons.push("workspace:packet-expands-claim");
    }
    if (packet.contextVersion !== undefined && claim.contextVersion !== undefined && packet.contextVersion !== claim.contextVersion) {
      reasons.push("contextVersion:claim-vs-packet");
    }
  }

  const identity = packet.identity ?? {};
  if (!identity.authorizedPersona) missing.push("packet.identity.authorizedPersona");
  if (!Array.isArray(identity.authorizedRelationships)) missing.push("packet.identity.authorizedRelationships");
  if (!job.goal) missing.push("packet.job.goal");

  return { ok: reasons.length === 0 && missing.length === 0, reasons, missing };
}
