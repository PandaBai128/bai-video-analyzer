export type LanguageModelMessageContent = string;

export interface LanguageModelChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: LanguageModelMessageContent;
}

export interface LanguageModelChatResult {
  readonly content: string;
  readonly model: string;
  readonly timings?: readonly {
    readonly label: string;
    readonly durationMs: number;
  }[];
  readonly rawResponse?: unknown;
}

export type LanguageModelUsageFeature = 'analysis' | 'navigation' | 'followup' | 'notes' | 'test';

export interface LanguageModelChatOptions {
  readonly model?: string;
  readonly signal?: AbortSignal;
  readonly maxTokens?: number;
  readonly usageFeature?: LanguageModelUsageFeature;
}

export interface LanguageModelStreamOptions extends LanguageModelChatOptions {
  readonly signal?: AbortSignal;
  readonly fallbackToNonStream?: boolean;
  readonly idleTimeoutMs?: number;
}

export interface LanguageModelStreamChunk {
  readonly text: string;
  readonly reasoning?: string;
  readonly done: boolean;
}

export interface LanguageModelAuthTestResult {
  readonly message: string;
  readonly latencyMs: number;
}

export interface LanguageModelClient {
  testAuth(signal?: AbortSignal): Promise<LanguageModelAuthTestResult>;
  chat(
    messages: readonly LanguageModelChatMessage[],
    options?: LanguageModelChatOptions,
  ): Promise<LanguageModelChatResult>;
  streamChat(
    messages: readonly LanguageModelChatMessage[],
    options?: LanguageModelStreamOptions,
  ): AsyncGenerator<LanguageModelStreamChunk, void, void>;
}

export class LanguageModelApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly detail: string,
  ) {
    super(message);
    this.name = 'LanguageModelApiError';
  }
}

export class LanguageModelStreamUnsupportedError extends Error {
  constructor(
    message: string,
    readonly rawBody: string,
  ) {
    super(message);
    this.name = 'LanguageModelStreamUnsupportedError';
  }
}
