import type { Bridge, ChatOptions, ConversationHistory, ConversationSummary } from "./bridge.js";
import { claudeBridge } from "./cc-bridge.js";
import { OpencodeBridge } from "./opencode-bridge.js";

const opencodeBridge = new OpencodeBridge();
let activeBridge: Bridge | null = null;
let cachedInfo:
  | { bridge: Bridge; opencodeAvailable: boolean; claudeAvailable: boolean }
  | null = null;

export async function initBridge(cwd: string): Promise<{
  bridge: Bridge;
  opencodeAvailable: boolean;
  claudeAvailable: boolean;
}> {
  if (cachedInfo) return cachedInfo;

  const opencodeAvailable = await opencodeBridge.checkAvailable();
  const claudeAvailable = await claudeBridge.checkAvailable();

  if (opencodeAvailable) {
    activeBridge = opencodeBridge;
  } else if (claudeAvailable) {
    activeBridge = claudeBridge;
  } else {
    throw new Error("OpenCode 和 Claude Code 均不可用");
  }

  cachedInfo = {
    bridge: activeBridge,
    opencodeAvailable,
    claudeAvailable,
  };

  return cachedInfo;
}

async function ensureBridge(cwd: string): Promise<Bridge> {
  if (activeBridge) return activeBridge;
  const info = await initBridge(cwd);
  return info.bridge;
}

export async function executeChat(options: ChatOptions): Promise<void> {
  const bridge = await ensureBridge(options.cwd || process.cwd());
  await bridge.executeChat(options);
}

export async function getConversationList(
  cwd: string,
  limit?: number
): Promise<ConversationSummary[]> {
  const bridge = await ensureBridge(cwd);
  return bridge.getConversationList(cwd, limit);
}

export async function getConversation(
  cwd: string,
  sessionId: string
): Promise<ConversationHistory | null> {
  const bridge = await ensureBridge(cwd);
  return bridge.getConversation(cwd, sessionId);
}
