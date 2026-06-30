export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
  id: string;
}

export interface ToolResult {
  id: string;
  content: string; // JSON-serialized result
}

export interface GenerateOptions {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  jsonMode?: boolean;
  responseSchema?: Record<string, unknown>;
  systemMessage?: string;
  tools?: ToolDefinition[];
  /** Task purpose for tiered model routing (e.g., 'summarization', 'draft'). */
  purpose?: string;
}

export interface ProviderResult {
  text: string;
  usage?: TokenUsage;
  toolCalls?: ToolCall[];
}

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  totalTokens?: number;
}

export type RateLimitType = 'RPM' | 'TPM' | 'RPD' | 'unknown';

export interface RetryProgress {
  attempt: number;
  maxRetries: number;
  backoffSeconds: number;
  limitType: RateLimitType;
  limitMessage: string;
}

export type BackendId = 'gemini' | 'claude' | 'groq' | 'openai' | 'azure' | 'ollama' | 'deepseek';

/** Superset of BackendId that includes non-generation backends needing API key management. */
export type ApiKeyBackend = BackendId | string;

export interface ModelCapabilities {
  supportsTools: boolean;
  supportsVision: boolean;
  supportsStreaming: boolean;
  maxContextTokens: number;
}

export type FetchFn = typeof globalThis.fetch;
