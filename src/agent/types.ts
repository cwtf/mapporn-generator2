import type { MapState } from '../map/types';

export type Part =
  /** hidden text is sent to the model but not shown in the UI (e.g. the map-state preamble) */
  | { type: 'text'; text: string; hidden?: boolean }
  /**
   * Model reasoning. Anthropic thinking blocks carry a signature (or opaque redacted data) and
   * must be sent back unchanged; OpenAI-compatible providers use plain `reasoning_content`.
   */
  | { type: 'reasoning'; origin: 'anthropic' | 'openai'; text: string; signature?: string; redacted?: string }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown>; argsError?: string }
  | { type: 'tool_result'; callId: string; name: string; content: string; isError?: boolean };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  parts: Part[];
  ts: number;
  /** Snapshot of the map when this turn finished (set on the last assistant message of a turn) */
  map?: MapState;
  error?: string;
  model?: string;
  stopReason?: string;
}

export interface ChatRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  map: MapState;
}

export interface ChatSummary {
  id: string;
  title: string;
  updatedAt: number;
  turns: number;
}
