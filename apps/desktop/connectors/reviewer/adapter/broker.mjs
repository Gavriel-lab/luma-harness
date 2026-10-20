// broker v1 HTTP 客户端。所有请求带 schemaVersion=1 与 requestId；凭据只走 Authorization 头。

import { randomUUID } from "node:crypto";
import { normalizeBridgeError, networkError } from "./errors.mjs";

export class BrokerClient {
  constructor({ bridgeUrl, token, fetchImpl = fetch }) {
    this.bridgeUrl = bridgeUrl;
    this.token = token;
    this.fetch = fetchImpl;
  }

  async #call(route, body, timeoutMs = 20000) {
    const requestId = randomUUID();
    try {
      const resp = await this.fetch(`${this.bridgeUrl}${route}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.token}`,
        },
        body: body === undefined ? undefined : JSON.stringify({ schemaVersion: 1, requestId, ...body }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await resp.text();
      let json;
      try { json = JSON.parse(text); } catch { return normalizeBridgeError(null, resp.status); }
      if (!resp.ok || json.ok === false) return normalizeBridgeError(json, resp.status);
      return { ok: true, ...json };
    } catch (e) {
      return { ok: false, ...networkError(e?.cause?.message || e.message) };
    }
  }

  session() {
    return this.#call("/v1/bridge/session");
  }

  claim({ capabilities = {} } = {}) {
    return this.#call("/v1/bridge/claim", { capabilities });
  }

  context({ jobId, attemptId, knownContextVersion }) {
    return this.#call("/v1/bridge/context", { jobId, attemptId, ...(knownContextVersion ? { knownContextVersion } : {}) });
  }

  event({ jobId, attemptId, seq, type, summary, checkpoint }) {
    return this.#call("/v1/bridge/events", { jobId, attemptId, seq, type, summary, ...(checkpoint ? { checkpoint } : {}) });
  }

  heartbeat({ jobId, attemptId }) {
    return this.#call("/v1/bridge/heartbeat", { jobId, attemptId }, 10000);
  }

  report({ jobId, attemptId, reportId, outcome, summary, artifacts = [], checks = [], checkpoint, unknowns = [] }) {
    return this.#call("/v1/bridge/report", {
      jobId, attemptId, reportId, outcome, summary, artifacts, checks, checkpoint, unknowns,
    }, 30000);
  }
}
