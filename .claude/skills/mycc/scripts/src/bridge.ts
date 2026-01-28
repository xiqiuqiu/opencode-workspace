export interface ChatOptions {
  message: string;
  sessionId?: string;
  cwd?: string;
  onMessage: (msg: unknown) => void;
  onDone: (sessionId: string) => void;
  onError: (error: string) => void;
}

export interface ConversationSummary {
  sessionId: string;
  startTime: string;
  lastTime: string;
  messageCount: number;
  lastMessagePreview: string;
}

export interface ConversationHistory {
  sessionId: string;
  messages: unknown[];
}

export interface Bridge {
  getName(): string;
  checkAvailable(): Promise<boolean>;
  executeChat(options: ChatOptions): Promise<void>;
  getConversationList(cwd: string, limit?: number): Promise<ConversationSummary[]>;
  getConversation(cwd: string, sessionId: string): Promise<ConversationHistory | null>;
}
