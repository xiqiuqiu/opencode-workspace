/**
 * Claude Code SDK 桥接
 * 核心：调用 CC SDK 的 query 函数
 */

import { query } from "@anthropic-ai/claude-code";
import { execSync } from "child_process";
import type { Bridge, ChatOptions, ConversationHistory, ConversationSummary } from "./bridge.js";
import { getConversation, getConversationList } from "./history.js";

// 检测 Claude CLI 路径
function detectClaudeCliPath(): string {
  const command = process.platform === "win32" ? "where claude" : "which claude";
  try {
    return execSync(command, { encoding: "utf-8" }).trim();
  } catch {
    return process.platform === "win32" ? "claude" : "/usr/local/bin/claude";
  }
}

const CLAUDE_CLI_PATH = detectClaudeCliPath();

class ClaudeBridge implements Bridge {
  getName(): string {
    return "claude-code";
  }

  async checkAvailable(): Promise<boolean> {
    try {
      const { execSync } = await import("child_process");
      execSync("claude --version", { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  async executeChat(options: ChatOptions): Promise<void> {
    const { message, sessionId, cwd, onMessage, onDone, onError } = options;
    let currentSessionId = sessionId || "";

    try {
      for await (const sdkMessage of query({
        prompt: message,
        options: {
          // 指定 CLI 路径，确保完整加载配置（包括 skills）
          executable: "node" as const,
          pathToClaudeCodeExecutable: CLAUDE_CLI_PATH,
          cwd: cwd || process.cwd(),
          resume: sessionId || undefined,
          // 小程序端无法交互确认权限，使用 bypassPermissions
          // 注意：这需要用户信任，后续可以改成更安全的模式
          permissionMode: "bypassPermissions",
        },
      })) {
        if (
          sdkMessage &&
          typeof sdkMessage === "object" &&
          "type" in sdkMessage &&
          sdkMessage.type === "system" &&
          "session_id" in sdkMessage
        ) {
          currentSessionId = sdkMessage.session_id as string;
        }

        onMessage(sdkMessage);
      }

      onDone(currentSessionId);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  async getConversationList(cwd: string): Promise<ConversationSummary[]> {
    return getConversationList(cwd);
  }

  async getConversation(cwd: string, sessionId: string): Promise<ConversationHistory | null> {
    return getConversation(cwd, sessionId);
  }
}

/**
 * 检查 CC CLI 是否可用
 */
export const claudeBridge = new ClaudeBridge();
