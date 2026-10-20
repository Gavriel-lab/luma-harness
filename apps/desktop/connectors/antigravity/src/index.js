import path from 'path';
import fs from 'fs';
import { BrokerClient } from './brokerClient.js';
import { AntigravityRunner } from './antigravityRunner.js';
import { CheckpointStore } from './checkpoint.js';
import { DesktopAgentAdapter } from './desktopAgentAdapter.js';
import { ChatHandler } from './chatHandler.js';

export {
  BrokerClient,
  AntigravityRunner,
  CheckpointStore,
  DesktopAgentAdapter,
  ChatHandler,
};

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    manifest: null,
    ready: null,
    brokerUrl: null,
    token: null,
    agentId: null,
    executorId: 'antigravity-adapter',
    checkpointDir: path.resolve('checkpoints'),
    pollIntervalMs: 5000,
    once: false,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--manifest' && args[i + 1]) {
      options.manifest = args[++i];
    } else if (args[i] === '--ready' && args[i + 1]) {
      options.ready = args[++i];
    } else if (args[i] === '--broker' && args[i + 1]) {
      options.brokerUrl = args[++i];
    } else if (args[i] === '--agent' && args[i + 1]) {
      options.agentId = args[++i];
    } else if (args[i] === '--once') {
      options.once = true;
    }
  }

  if (options.ready && !options.manifest) {
    if (fs.existsSync(options.ready)) {
      const readyData = JSON.parse(fs.readFileSync(options.ready, 'utf8'));
      const antigravity = readyData.members?.find(m => m.key === 'antigravity' || m.agentId === 'agent_worker_editor');
      if (antigravity) {
        options.manifest = antigravity.manifestPath;
        if (!options.agentId) options.agentId = antigravity.agentId;
        if (!options.executorId) options.executorId = antigravity.executorId;
      }
    }
  }

  if (options.manifest && fs.existsSync(options.manifest)) {
    try {
      const mData = JSON.parse(fs.readFileSync(options.manifest, 'utf8'));
      if (!options.agentId && mData.agentId) {
        options.agentId = mData.agentId;
      }
      if (!options.executorId && mData.executorId) {
        options.executorId = mData.executorId;
      }
    } catch (e) {}
  }

  if (!options.agentId) {
    options.agentId = 'agent_worker_editor';
  }

  return options;
}

async function main() {
  const opts = parseArgs();
  console.log('[DesktopAgentAdapter] Starting Antigravity adapter...');
  console.log(`[DesktopAgentAdapter] Agent ID: ${opts.agentId}`);
  console.log(`[DesktopAgentAdapter] Executor ID: ${opts.executorId}`);

  if (!opts.manifest && !opts.brokerUrl) {
    console.error('[DesktopAgentAdapter] Error: Either --manifest <path>, --ready <path> or --broker <url> must be provided.');
    process.exit(1);
  }

  const brokerClient = new BrokerClient({
    manifestPath: opts.manifest,
    brokerUrl: opts.brokerUrl,
    token: opts.token,
    agentId: opts.agentId,
    executorId: opts.executorId,
  });

  const runner = new AntigravityRunner();
  if (!runner.isAvailable()) {
    console.warn(`[DesktopAgentAdapter] Warning: Antigravity CLI executable not found at ${runner.agyPath}`);
  }

  const checkpointStore = new CheckpointStore(opts.checkpointDir);

  const adapter = new DesktopAgentAdapter({
    brokerClient,
    runner,
    checkpointStore,
    agentId: opts.agentId,
    executorId: opts.executorId,
  });

  const chatHandler = new ChatHandler({
    runner,
    agentId: opts.agentId,
    executorId: opts.executorId,
  });

  if (opts.once) {
    console.log('[DesktopAgentAdapter] Running single cycle...');
    const result = await adapter.runOnce();
    console.log('[DesktopAgentAdapter] Cycle completed:', result);
    return;
  }

  console.log('[DesktopAgentAdapter] Entering polling loop with in-flight guard...');
  let inFlight = false;

  const poll = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const res = await adapter.runOnce();
      if (res && res.status !== 'idle' && res.status !== 'busy') {
        console.log('[DesktopAgentAdapter] Job executed:', res);
      }
    } catch (err) {
      console.error('[DesktopAgentAdapter] Error during cycle:', err.message || err);
    } finally {
      inFlight = false;
    }
  };

  await poll();
  setInterval(poll, opts.pollIntervalMs);
}

import { pathToFileURL } from 'url';

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(err => {
    console.error('[DesktopAgentAdapter] Fatal error:', err);
    process.exit(1);
  });
}
