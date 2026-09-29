import type { ProviderProfile } from '../store/settings';
import { useMapStore } from '../store/mapStore';
import { callLLM } from './llm';
import { systemPrompt } from './prompt';
import { executeTool, TOOL_DEFS } from './tools';
import type { ChatMessage, Part } from './types';

export interface AgentCallbacks {
  /** called with the full message list whenever it changes (including streaming partials) */
  onMessages: (messages: ChatMessage[]) => void;
}

const uid = () => crypto.randomUUID();

/**
 * Run the tool-use loop until the model stops calling tools, the step budget runs out or
 * the signal aborts. Returns the final message list; the last assistant message carries a
 * snapshot of the map.
 */
export async function runAgent(
  history: ChatMessage[],
  profile: ProviderProfile,
  maxSteps: number,
  signal: AbortSignal,
  cb: AgentCallbacks,
): Promise<ChatMessage[]> {
  let messages = [...history];
  const system = systemPrompt();

  const finish = (last?: Partial<ChatMessage>) => {
    const map = structuredClone(useMapStore.getState().map);
    const idx = messages.map((m) => m.role).lastIndexOf('assistant');
    if (idx >= 0 && idx === messages.length - 1) {
      messages[idx] = { ...messages[idx], ...last, map };
    } else {
      // Turn ended on tool results or an error: add a closing assistant message to hold the snapshot.
      messages.push({ id: uid(), role: 'assistant', parts: [], ts: Date.now(), map, ...last });
    }
    cb.onMessages(messages);
    return messages;
  };

  for (let step = 0; step < maxSteps; step++) {
    const draft: ChatMessage = { id: uid(), role: 'assistant', parts: [], ts: Date.now(), model: profile.model };
    let result;
    try {
      result = await callLLM({
        profile,
        system,
        messages,
        tools: TOOL_DEFS,
        signal,
        onPartial: (parts) => cb.onMessages([...messages, { ...draft, parts }]),
      });
    } catch (e) {
      if (signal.aborted) return finish({ stopReason: 'aborted' });
      return finish({ error: (e as Error).message });
    }

    const assistant: ChatMessage = { ...draft, parts: result.parts, stopReason: result.stopReason };
    messages = [...messages, assistant];
    cb.onMessages(messages);

    const calls = result.parts.filter((p) => p.type === 'tool_call');
    if (result.stopReason === 'refusal') return finish({ error: 'The model declined this request.' });
    if (!calls.length) {
      if (result.stopReason === 'max_tokens') return finish({ error: 'The reply hit the max-tokens limit. Increase it in Settings.' });
      return finish();
    }

    // Execute tools one at a time: map edits must apply in order.
    const results: Part[] = [];
    const toolMsg: ChatMessage = { id: uid(), role: 'tool', parts: results, ts: Date.now() };
    messages = [...messages, toolMsg];
    for (const call of calls) {
      if (signal.aborted) break;
      let content: string;
      let isError = false;
      if (call.argsError) {
        content = result.stopReason === 'max_tokens' ? 'Your output was cut off (max tokens) before the arguments were complete. Send smaller batches.' : call.argsError;
        isError = true;
      } else {
        try {
          content = await executeTool(call.name, call.args, signal);
        } catch (e) {
          content = `Error: ${(e as Error).message}`;
          isError = true;
        }
      }
      results.push({ type: 'tool_result', callId: call.id, name: call.name, content, ...(isError ? { isError } : {}) });
      messages[messages.length - 1] = { ...toolMsg, parts: [...results] };
      cb.onMessages(messages);
    }
    if (signal.aborted) return finish({ stopReason: 'aborted' });
  }
  return finish({ error: `Stopped after ${maxSteps} steps (limit set in Settings).` });
}
