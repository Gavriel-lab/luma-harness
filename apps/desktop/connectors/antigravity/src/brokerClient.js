import fs from 'fs';
import { BRIDGE_SCHEMA_VERSION, ERROR_CODES } from './types.js';

export class BrokerClient {
  /**
   * @param {object} options
   * @param {string} [options.manifestPath]
   * @param {string} [options.brokerUrl]
   * @param {string} [options.token]
   * @param {string} options.agentId
   * @param {string} options.executorId
   * @param {boolean} [options.isMockFixture]
   */
  constructor(options) {
    this.agentId = options.agentId;
    this.executorId = options.executorId;
    this.token = options.token || null;
    this.brokerUrl = options.brokerUrl || null;
    this.generation = null;
    this.isMockFixture = options.isMockFixture || false;

    if (options.manifestPath) {
      this._loadManifest(options.manifestPath);
    } else if (this.brokerUrl) {
      this._validateUrl(this.brokerUrl);
    }
  }

  _validateUrl(rawUrl) {
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch (e) {
      throw new Error(`Invalid broker URL: ${rawUrl}`);
    }

    const isLoopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
    if (!isLoopback) {
      throw new Error(`Broker URL must bind to loopback address (127.0.0.1), got: ${parsed.hostname}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Broker URL protocol must be http or https, got: ${parsed.protocol}`);
    }
  }

  _loadManifest(manifestPath) {
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Manifest file not found: ${manifestPath}`);
    }
    const content = fs.readFileSync(manifestPath, 'utf-8');
    let manifest;
    try {
      manifest = JSON.parse(content);
    } catch (e) {
      throw new Error(`Failed to parse manifest JSON in ${manifestPath}: ${e.message}`);
    }

    if (!manifest.schemaVersion || manifest.schemaVersion !== BRIDGE_SCHEMA_VERSION) {
      throw new Error(`Schema version mismatch or missing: manifest=${manifest?.schemaVersion}, expected=${BRIDGE_SCHEMA_VERSION}`);
    }

    // Require instance generation in manifest
    if (manifest.instanceGeneration === undefined && manifest.generation === undefined) {
      throw new Error(`Manifest instance generation missing in ${manifestPath}`);
    }
    this.generation = manifest.instanceGeneration ?? manifest.generation;

    if (!manifest.brokerUrl) {
      throw new Error(`Invalid manifest: brokerUrl missing in ${manifestPath}`);
    }

    this._validateUrl(manifest.brokerUrl);
    this.brokerUrl = manifest.brokerUrl;

    // Load token from tokenFile if specified
    if (manifest.tokenFile) {
      if (fs.existsSync(manifest.tokenFile)) {
        this.token = fs.readFileSync(manifest.tokenFile, 'utf-8').trim();
      } else {
        throw new Error(`Token file specified in manifest not found: ${manifest.tokenFile}`);
      }
    }

    // Reject plaintext tokens in production manifests unless marked as mock fixture!
    if (manifest.token) {
      if (!this.isMockFixture && !manifest.isMockFixture) {
        throw new Error('Plaintext tokens are prohibited in production manifest; credentials must be injected via secure broker registration.');
      }
      this.token = manifest.token;
    }
  }

  /**
   * Set injected credentials from controlled process communication (Gao Rui broker registration)
   * @param {string} token
   */
  setInjectedCredential(token) {
    this.token = token;
  }

  async _request(pathname, method = 'GET', body = null, timeoutMs = 30000) {
    if (!this.brokerUrl) {
      throw new Error('Broker URL is not set');
    }
    const url = new URL(pathname, this.brokerUrl).toString();
    const headers = {
      'Content-Type': 'application/json',
      'X-Agent-Id': this.agentId,
      'X-Executor-Id': this.executorId,
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        redirect: 'error',
      });
    } catch (err) {
      clearTimeout(timer);
      throw {
        ok: false,
        code: ERROR_CODES.NETWORK_ERROR,
        message: `Failed to connect to broker at ${url}: ${err.message}`,
        retryable: true,
      };
    }
    clearTimeout(timer);

    let data;
    try {
      data = await res.json();
    } catch (err) {
      throw {
        ok: false,
        code: ERROR_CODES.UNKNOWN,
        message: `Non-JSON response from broker (${res.status})`,
        retryable: false,
      };
    }

    if (!res.ok || (data && data.ok === false)) {
      const errorObj = {
        ok: false,
        code: data?.code || (res.status === 401 ? ERROR_CODES.UNAUTHENTICATED : res.status === 403 ? ERROR_CODES.FORBIDDEN : ERROR_CODES.UNKNOWN),
        message: data?.message || `HTTP ${res.status}`,
        retryable: data?.retryable ?? false,
      };
      throw errorObj;
    }

    return data;
  }

  async getSession() {
    return this._request('/v1/bridge/session', 'GET');
  }

  async claimJob(requestId, capabilities = {}) {
    return this._request('/v1/bridge/claim', 'POST', {
      requestId,
      schemaVersion: BRIDGE_SCHEMA_VERSION,
      capabilities,
    });
  }

  async getContext(requestId, jobId, attemptId, knownContextVersion = null) {
    return this._request('/v1/bridge/context', 'POST', {
      requestId,
      schemaVersion: BRIDGE_SCHEMA_VERSION,
      jobId,
      attemptId,
      knownContextVersion,
    });
  }

  async sendEvent(requestId, jobId, attemptId, seq, type, summary, checkpoint = null) {
    return this._request('/v1/bridge/events', 'POST', {
      requestId,
      schemaVersion: BRIDGE_SCHEMA_VERSION,
      jobId,
      attemptId,
      seq,
      type,
      summary,
      checkpoint,
    });
  }

  async sendHeartbeat(requestId, jobId, attemptId) {
    return this._request('/v1/bridge/heartbeat', 'POST', {
      requestId,
      schemaVersion: BRIDGE_SCHEMA_VERSION,
      jobId,
      attemptId,
    });
  }

  async report(requestId, jobId, attemptId, reportPayload) {
    return this._request('/v1/bridge/report', 'POST', {
      requestId,
      schemaVersion: BRIDGE_SCHEMA_VERSION,
      jobId,
      attemptId,
      ...reportPayload,
    });
  }
}
