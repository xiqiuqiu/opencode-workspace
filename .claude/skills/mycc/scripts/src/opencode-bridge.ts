import { randomUUID } from "crypto";
import { createOpencodeClient } from "@opencode-ai/sdk";
import type { EventMessagePartUpdated, EventMessageUpdated, Session, TextPart } from "@opencode-ai/sdk";
import type { Bridge, ChatOptions, ConversationHistory, ConversationSummary } from "./bridge.js";

const DEFAULT_BASE_URL = "http://localhost:4096";

type ModelChoice = {
  providerID: string;
  modelID: string;
};

type StreamState = {
  finished: boolean;
  sessionId: string;
  messageId: string;
};

function createClient(cwd: string | undefined) {
  return createOpencodeClient({
    baseUrl: process.env.OPENCODE_BASE_URL || DEFAULT_BASE_URL,
    directory: cwd,
  });
}

async function isHealthy(cwd: string | undefined): Promise<boolean> {
  const baseUrl = process.env.OPENCODE_BASE_URL || DEFAULT_BASE_URL;
  const url = `${baseUrl.replace(/\/$/, "")}/global/health`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.log(`[OpenCode] health check failed: ${url} (${response.status})`);
      return false;
    }
    const data = (await response.json()) as { healthy?: boolean };
    console.log(`[OpenCode] health check OK: ${url}`);
    return Boolean(data?.healthy);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[OpenCode] health check failed: ${url} (${message})`);
    return false;
  }
}

async function getDefaultModel(cwd: string | undefined): Promise<ModelChoice> {
  const envProvider = process.env.OPENCODE_PROVIDER_ID;
  const envModel = process.env.OPENCODE_MODEL_ID;
  if (envProvider && envModel) {
    return { providerID: envProvider, modelID: envModel };
  }

  const client = createClient(cwd);
  const result = await client.config.providers({ responseStyle: "data" });
  const defaults = result?.default || {};
  const providerID = Object.keys(defaults)[0];
  const modelID = providerID ? defaults[providerID] : undefined;

  if (providerID && modelID) {
    return { providerID, modelID };
  }

  if (envProvider || envModel) {
    return {
      providerID: envProvider || "",
      modelID: envModel || "",
    };
  }

  throw new Error("无法从 OpenCode 读取默认模型，请设置 OPENCODE_PROVIDER_ID/OPENCODE_MODEL_ID");
}

function normalizeTime(value: number | string | undefined): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  return new Date(value).toISOString();
}

function buildSummary(session: Session): ConversationSummary {
  return {
    sessionId: session.id,
    startTime: normalizeTime(session.time?.created),
    lastTime: normalizeTime(session.time?.updated),
    messageCount: 0,
    lastMessagePreview: session.title || "(无预览)",
  };
}

function readTextFromPart(part: TextPart): string {
  if (!part?.text) return "";
  return part.text;
}

async function waitForCompletion(
  client: ReturnType<typeof createOpencodeClient>,
  state: StreamState,
  onMessage: (msg: unknown) => void,
  signal: AbortSignal
): Promise<void> {
  const streamResult = await client.event.subscribe({
    responseStyle: "data",
    signal,
  });

  const stream = streamResult.stream;
  for await (const raw of stream) {
    if (!raw || typeof raw !== "object") continue;
    if (!("type" in raw)) continue;
    const eventType = raw.type as string;

    if (eventType === "message.part.updated") {
      const event = raw as EventMessagePartUpdated;
      const part = event.properties?.part as TextPart | undefined;
      const delta = event.properties?.delta;
      if (!part || part.sessionID !== state.sessionId || part.messageID !== state.messageId) {
        continue;
      }
      const text = typeof delta === "string" ? delta : readTextFromPart(part);
      if (text) {
        onMessage({ type: "assistant", message: { content: [{ type: "text", text }] } });
      }
    }

    if (eventType === "message.updated") {
      const event = raw as EventMessageUpdated;
      const info = event.properties?.info;
      if (info && "sessionID" in info && info.sessionID === state.sessionId && "id" in info) {
        if (info.id === state.messageId && "finish" in info) {
          state.finished = true;
          return;
        }
      }
    }
  }

  if (!state.finished) {
    throw new Error("OpenCode 事件流中断");
  }
}

export class OpencodeBridge implements Bridge {
  getName(): string {
    return "opencode";
  }

  async checkAvailable(): Promise<boolean> {
    return isHealthy(undefined);
  }

  async executeChat(options: ChatOptions): Promise<void> {
    const { message, sessionId, cwd, onMessage, onDone, onError } = options;

    if (!(await isHealthy(cwd))) {
      onError("OpenCode 服务未启动，请先运行 opencode serve");
      return;
    }

    const client = createClient(cwd);
    const model = await getDefaultModel(cwd);
    const messageId = `msg_${randomUUID()}`;

    const sessionInfo = sessionId
      ? { id: sessionId }
      : await client.session.create({
          responseStyle: "data",
          body: {},
          query: cwd ? { directory: cwd } : undefined,
        });

    const currentSessionId = sessionId || sessionInfo.id;
    const controller = new AbortController();
    const state: StreamState = {
      finished: false,
      sessionId: currentSessionId,
      messageId,
    };

    try {
      const runner = waitForCompletion(client, state, onMessage, controller.signal);

      await client.session.prompt({
        responseStyle: "data",
        path: { id: currentSessionId },
        body: {
          messageID: messageId,
          model,
          parts: [{ type: "text", text: message }],
        },
      });

      await runner;
      controller.abort();
      onDone(currentSessionId);
    } catch (error) {
      controller.abort();
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  async getConversationList(cwd: string, limit?: number): Promise<ConversationSummary[]> {
    if (!(await isHealthy(cwd))) {
      return [];
    }

    const client = createClient(cwd);
    const sessions = await client.session.list({
      responseStyle: "data",
      query: cwd ? { directory: cwd } : undefined,
    });
    const summaries = (sessions || []).map(buildSummary);
    if (limit && limit > 0) {
      return summaries.slice(0, limit);
    }
    return summaries;
  }

  async getConversation(cwd: string, sessionId: string): Promise<ConversationHistory | null> {
    if (!(await isHealthy(cwd))) {
      return null;
    }

    const client = createClient(cwd);
    const messages = await client.session.messages({
      responseStyle: "data",
      path: { id: sessionId },
      query: cwd ? { directory: cwd } : undefined,
    });

    if (!messages) return null;
    const items = messages.map(entry => ({
      info: entry.info,
      parts: entry.parts,
    }));

    return {
      sessionId,
      messages: items,
    };
  }
}
