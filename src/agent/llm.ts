// Provider-neutral chat calls. Requests go through the local server (/api/llm/chat), which
// adds auth headers and relays to the configured base URL, so any provider that speaks the
// Anthropic Messages or OpenAI Chat Completions format works.

import type { ProviderProfile } from '../store/settings';
import type { ChatMessage, Part } from './types';

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LLMRequest {
  profile: ProviderProfile;
  system: string;
  messages: ChatMessage[];
  tools: ToolDef[];
  signal: AbortSignal;
  onPartial?: (parts: Part[]) => void;
}

export interface LLMResult {
  parts: Part[];
  stopReason: string;
}

type Json = Record<string, unknown>;

function parseJsonObject(text: string, what: string): Json {
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch {
    /* handled below */
  }
  throw new Error(`${what} must be a JSON object`);
}

/**
 * Make the transcript valid for strict providers: every tool call must be answered by a
 * tool result (a turn that was stopped mid-tool gets a synthetic "cancelled" result).
 */
export function sanitize(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'assistant' && !m.parts.some((p) => p.type === 'text' ? p.text.trim() : p.type === 'tool_call')) continue;
    out.push(m);
    if (m.role !== 'assistant') continue;
    const calls = m.parts.filter((p) => p.type === 'tool_call');
    if (!calls.length) continue;
    const next = messages[i + 1];
    const answered = new Set(next?.role === 'tool' ? next.parts.map((p) => (p.type === 'tool_result' ? p.callId : '')) : []);
    const missing: Part[] = calls
      .filter((c) => !answered.has(c.id))
      .map((c) => ({ type: 'tool_result', callId: c.id, name: c.name, content: 'Cancelled by the user.', isError: true }));
    if (!missing.length) continue;
    if (next?.role === 'tool') {
      out.push({ ...next, parts: [...next.parts, ...missing] });
      i++;
    } else {
      out.push({ id: `${m.id}-cancel`, role: 'tool', parts: missing, ts: m.ts });
    }
  }
  return out;
}

// ---- Anthropic Messages format ------------------------------------------------------

function toAnthropicMessages(messages: ChatMessage[]): Json[] {
  const out: { role: 'user' | 'assistant'; content: Json[] }[] = [];
  for (const m of sanitize(messages)) {
    const content: Json[] = [];
    for (const p of m.parts) {
      if (p.type === 'text' && p.text.trim()) content.push({ type: 'text', text: p.text });
      else if (p.type === 'reasoning' && p.origin === 'anthropic') {
        if (p.redacted) content.push({ type: 'redacted_thinking', data: p.redacted });
        else if (p.signature) content.push({ type: 'thinking', thinking: p.text, signature: p.signature });
      } else if (p.type === 'tool_call') content.push({ type: 'tool_use', id: p.id, name: p.name, input: p.args });
      else if (p.type === 'tool_result')
        content.push({ type: 'tool_result', tool_use_id: p.callId, content: p.content, ...(p.isError ? { is_error: true } : {}) });
    }
    if (!content.length) continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const last = out[out.length - 1];
    // Tool results must come first in a user turn; merging keeps roles alternating.
    if (last?.role === role) last.content.push(...content);
    else out.push({ role, content });
  }
  return out;
}

function anthropicBody(req: LLMRequest): Json {
  const { profile } = req;
  const cache = profile.promptCaching ? { cache_control: { type: 'ephemeral' } } : {};
  const messages = toAnthropicMessages(req.messages);
  if (profile.promptCaching && messages.length) {
    const last = messages[messages.length - 1].content as Json[];
    last[last.length - 1] = { ...last[last.length - 1], ...cache };
  }
  const tools = req.tools.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
    ...(i === req.tools.length - 1 ? cache : {}),
  }));
  return {
    model: profile.model,
    max_tokens: profile.maxTokens,
    system: [{ type: 'text', text: req.system, ...cache }],
    messages,
    tools,
    stream: profile.stream,
    ...parseJsonObject(profile.extraBody, 'Extra body'),
  };
}

function readAnthropicMessage(data: Json): LLMResult {
  const parts: Part[] = [];
  for (const b of (data.content as Json[]) ?? []) {
    if (b.type === 'text') parts.push({ type: 'text', text: String(b.text ?? '') });
    else if (b.type === 'thinking') parts.push({ type: 'reasoning', origin: 'anthropic', text: String(b.thinking ?? ''), signature: String(b.signature ?? '') });
    else if (b.type === 'redacted_thinking') parts.push({ type: 'reasoning', origin: 'anthropic', text: '', redacted: String(b.data ?? '') });
    else if (b.type === 'tool_use') parts.push({ type: 'tool_call', id: String(b.id), name: String(b.name), args: (b.input as Json) ?? {} });
  }
  return { parts, stopReason: String(data.stop_reason ?? 'end_turn') };
}

async function streamAnthropic(res: Response, onPartial?: (p: Part[]) => void): Promise<LLMResult> {
  const blocks: (Part & { json?: string })[] = [];
  let stopReason = 'end_turn';
  const emit = throttle(() => onPartial?.(blocks.map(finalizePart)));
  for await (const ev of sse(res)) {
    if (!ev.data || ev.data === '[DONE]') continue;
    const d = JSON.parse(ev.data);
    switch (d.type) {
      case 'content_block_start': {
        const b = d.content_block;
        if (b.type === 'text') blocks[d.index] = { type: 'text', text: b.text ?? '' };
        else if (b.type === 'thinking') blocks[d.index] = { type: 'reasoning', origin: 'anthropic', text: b.thinking ?? '', signature: '' };
        else if (b.type === 'redacted_thinking') blocks[d.index] = { type: 'reasoning', origin: 'anthropic', text: '', redacted: b.data };
        else if (b.type === 'tool_use') blocks[d.index] = { type: 'tool_call', id: b.id, name: b.name, args: {}, json: '' };
        break;
      }
      case 'content_block_delta': {
        const b = blocks[d.index];
        const delta = d.delta;
        if (!b) break;
        if (delta.type === 'text_delta' && b.type === 'text') b.text += delta.text;
        else if (delta.type === 'thinking_delta' && b.type === 'reasoning') b.text += delta.thinking;
        else if (delta.type === 'signature_delta' && b.type === 'reasoning') b.signature = (b.signature ?? '') + delta.signature;
        else if (delta.type === 'input_json_delta' && b.type === 'tool_call') b.json += delta.partial_json;
        emit();
        break;
      }
      case 'message_delta':
        if (d.delta?.stop_reason) stopReason = d.delta.stop_reason;
        break;
      case 'error':
        throw new Error(d.error?.message ?? 'Provider stream error');
    }
  }
  emit.flush();
  return { parts: blocks.filter(Boolean).map(finalizePart), stopReason };
}

// ---- OpenAI Chat Completions format -------------------------------------------------

function toOpenAIMessages(system: string, messages: ChatMessage[]): Json[] {
  const out: Json[] = [{ role: 'system', content: system }];
  for (const m of sanitize(messages)) {
    if (m.role === 'user') {
      const text = m.parts.map((p) => (p.type === 'text' ? p.text : '')).filter(Boolean).join('\n\n');
      out.push({ role: 'user', content: text });
    } else if (m.role === 'assistant') {
      const text = m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
      const calls = m.parts.filter((p) => p.type === 'tool_call');
      const reasoning = m.parts.find((p) => p.type === 'reasoning' && p.origin === 'openai');
      const msg: Json = { role: 'assistant', content: text || null };
      if (calls.length)
        msg.tool_calls = calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
      if (reasoning?.type === 'reasoning' && reasoning.text) msg.reasoning_content = reasoning.text;
      out.push(msg);
    } else {
      for (const p of m.parts) if (p.type === 'tool_result') out.push({ role: 'tool', tool_call_id: p.callId, content: p.content });
    }
  }
  return out;
}

function openaiBody(req: LLMRequest): Json {
  const { profile } = req;
  // OpenAI's own API wants max_completion_tokens for current models; compatible providers use max_tokens.
  const tokenKey = /api\.openai\.com/.test(profile.baseUrl) ? 'max_completion_tokens' : 'max_tokens';
  return {
    model: profile.model,
    messages: toOpenAIMessages(req.system, req.messages),
    tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
    [tokenKey]: profile.maxTokens,
    stream: profile.stream,
    ...parseJsonObject(profile.extraBody, 'Extra body'),
  };
}

function readOpenAIMessage(data: Json): LLMResult {
  const choice = ((data.choices as Json[]) ?? [])[0] ?? {};
  const msg = (choice.message as Json) ?? {};
  const parts: Part[] = [];
  const reasoning = msg.reasoning_content ?? msg.reasoning;
  if (typeof reasoning === 'string' && reasoning) parts.push({ type: 'reasoning', origin: 'openai', text: reasoning });
  if (typeof msg.content === 'string' && msg.content) parts.push({ type: 'text', text: msg.content });
  for (const c of (msg.tool_calls as Json[]) ?? []) {
    const fn = c.function as Json;
    parts.push(parseToolArgs({ type: 'tool_call', id: String(c.id), name: String(fn.name), args: {}, json: String(fn.arguments ?? '') }));
  }
  return { parts, stopReason: mapFinish(String(choice.finish_reason ?? 'stop')) };
}

async function streamOpenAI(res: Response, onPartial?: (p: Part[]) => void): Promise<LLMResult> {
  let reasoning = '';
  let text = '';
  const calls: (Part & { type: 'tool_call'; json: string })[] = [];
  let finish = 'stop';
  const snapshot = (): Part[] => [
    ...(reasoning ? [{ type: 'reasoning', origin: 'openai', text: reasoning } as Part] : []),
    ...(text ? [{ type: 'text', text } as Part] : []),
    ...calls.filter(Boolean).map(finalizePart),
  ];
  const emit = throttle(() => onPartial?.(snapshot()));
  for await (const ev of sse(res)) {
    if (!ev.data || ev.data === '[DONE]') continue;
    const d = JSON.parse(ev.data);
    if (d.error) throw new Error(d.error.message ?? JSON.stringify(d.error));
    const choice = d.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    const r = delta.reasoning_content ?? delta.reasoning;
    if (typeof r === 'string') reasoning += r;
    if (typeof delta.content === 'string') text += delta.content;
    for (const tc of delta.tool_calls ?? []) {
      const i = tc.index ?? calls.length;
      calls[i] ??= { type: 'tool_call', id: tc.id ?? `call_${i}`, name: '', args: {}, json: '' };
      if (tc.id) calls[i].id = tc.id;
      if (tc.function?.name) calls[i].name += tc.function.name;
      if (tc.function?.arguments) calls[i].json += tc.function.arguments;
    }
    if (choice.finish_reason) finish = choice.finish_reason;
    emit();
  }
  emit.flush();
  return { parts: snapshot(), stopReason: mapFinish(finish) };
}

function mapFinish(f: string): string {
  if (f === 'tool_calls' || f === 'function_call') return 'tool_use';
  if (f === 'length') return 'max_tokens';
  if (f === 'content_filter') return 'refusal';
  return 'end_turn';
}

// ---- shared -------------------------------------------------------------------------

function parseToolArgs(p: Part & { json?: string }): Part {
  if (p.type !== 'tool_call' || p.json === undefined) return p;
  const { json, ...rest } = p;
  if (!json.trim()) return { ...rest, args: {} };
  try {
    const v = JSON.parse(json);
    return { ...rest, args: v && typeof v === 'object' ? v : {} };
  } catch {
    return { ...rest, args: {}, argsError: `Could not parse tool arguments as JSON: ${json.slice(0, 200)}` };
  }
}

function finalizePart(p: Part & { json?: string }): Part {
  return p.type === 'tool_call' ? parseToolArgs(p) : p;
}

async function* sse(res: Response): AsyncGenerator<{ event?: string; data: string }> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buf += value;
    let idx: number;
    while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
      let event: string | undefined;
      const data: string[] = [];
      for (const line of chunk.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) yield { event, data: data.join('\n') };
    }
    if (done) break;
  }
}

function throttle(fn: () => void, ms = 50) {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    last = Date.now();
    timer = undefined;
    fn();
  };
  const t = () => {
    if (timer) return;
    const wait = ms - (Date.now() - last);
    if (wait <= 0) run();
    else timer = setTimeout(run, wait);
  };
  t.flush = () => {
    if (timer) clearTimeout(timer);
    run();
  };
  return t;
}

async function errorMessage(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const j = JSON.parse(text);
    const msg = j.error?.message ?? j.error ?? j.message ?? j.detail;
    if (msg) return `${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`;
  } catch {
    /* not JSON */
  }
  return `${res.status}: ${text.slice(0, 500) || res.statusText}`;
}

export async function callLLM(req: LLMRequest): Promise<LLMResult> {
  const { profile } = req;
  if (!profile.model) throw new Error('No model configured. Open Settings and choose a model.');
  const body = profile.format === 'anthropic' ? anthropicBody(req) : openaiBody(req);
  const res = await fetch('/api/llm/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      format: profile.format,
      baseUrl: profile.baseUrl,
      apiKey: profile.apiKey,
      headers: parseJsonObject(profile.headers, 'Extra headers'),
      body,
    }),
    signal: req.signal,
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  const isStream = (res.headers.get('content-type') ?? '').includes('text/event-stream');
  if (profile.format === 'anthropic') return isStream ? streamAnthropic(res, req.onPartial) : readAnthropicMessage(await res.json());
  return isStream ? streamOpenAI(res, req.onPartial) : readOpenAIMessage(await res.json());
}

export async function listModels(profile: ProviderProfile): Promise<string[]> {
  const res = await fetch('/api/llm/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      format: profile.format,
      baseUrl: profile.baseUrl,
      apiKey: profile.apiKey,
      headers: parseJsonObject(profile.headers, 'Extra headers'),
    }),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()).models;
}
