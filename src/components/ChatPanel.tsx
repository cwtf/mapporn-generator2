import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MAP_TOOL_NAMES } from '../agent/tools';
import type { ChatMessage, Part } from '../agent/types';
import { useChats } from '../store/chatStore';
import { useSettings } from '../store/settings';
import { Icon } from './Icon';
import { Markdown } from './Markdown';

const EXAMPLES = [
  'GDP per capita by country (latest World Bank data), with a good colour scale',
  'Countries that drive on the left',
  'US states by the party that won the 2024 presidential election',
  'Europe by official language family, in Lambert conformal conic',
  'Capital cities of South America with markers and labels',
  'Flight-style arcs from London to the 10 largest cities in the world',
];

type ToolResultPart = Extract<Part, { type: 'tool_result' }>;

export function ChatPanel({ onOpenSettings }: { onOpenSettings: () => void }) {
  const current = useChats((s) => s.current);
  const running = useChats((s) => s.running);
  const send = useChats((s) => s.send);
  const stop = useChats((s) => s.stop);
  const restore = useChats((s) => s.restoreSnapshot);
  const { profiles, activeId, setActive } = useSettings();
  const profile = profiles.find((p) => p.id === activeId) ?? profiles[0];
  const [input, setInput] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);

  const messages = current?.messages ?? [];

  // Keep scrolled to the bottom while streaming unless the user scrolled up.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    if (!input) return;
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  const submit = (text = input) => {
    if (!text.trim() || running) return;
    stick.current = true;
    setInput('');
    void send(text);
  };

  const results = new Map<string, ToolResultPart>();
  for (const m of messages) for (const p of m.parts) if (p.type === 'tool_result') results.set(p.callId, p);

  const isLocal = profile && /localhost|127\.0\.0\.1/.test(profile.baseUrl);
  const needsKey = profile && !profile.apiKey && !isLocal;
  const lastTurnEnd = messages.map((m) => !!m.map).lastIndexOf(true);

  return (
    <div className="chat">
      <div
        className="chat-list"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {messages.length === 0 && (
          <div className="welcome">
            <h2>What should we map?</h2>
            <p className="muted">Describe a map and the assistant will research the data and draw it. You can keep refining it afterwards.</p>
            <div className="examples">
              {EXAMPLES.map((ex) => (
                <button type="button" key={ex} className="example" onClick={() => submit(ex)} disabled={running || !profile}>
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) =>
          m.role === 'user' ? (
            <UserBubble key={m.id} message={m} />
          ) : m.role === 'assistant' ? (
            <AssistantBlock
              key={m.id}
              message={m}
              results={results}
              streaming={running && i === messages.length - 1}
              onRestore={m.map && i !== lastTurnEnd ? () => restore(m.map!) : undefined}
            />
          ) : null,
        )}
        {running && messages[messages.length - 1]?.role !== 'assistant' && (
          <div className="working">
            <span className="dots" /> Working…
          </div>
        )}
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {needsKey && (
          <button type="button" className="notice" onClick={onOpenSettings}>
            <Icon name="alert" size={15} /> Add an API key for {profile.name} in Settings
          </button>
        )}
        <div className="composer-box">
          <textarea
            ref={inputRef}
            value={input}
            placeholder={messages.length ? 'Refine the map…' : 'Describe a map…'}
            rows={1}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
          />
          {running ? (
            <button type="button" className="send stop" onClick={stop} title="Stop" aria-label="Stop">
              <Icon name="stop" size={16} />
            </button>
          ) : (
            <button type="submit" className="send" disabled={!input.trim() || !profile} title="Send (Enter)" aria-label="Send">
              <Icon name="send" size={16} />
            </button>
          )}
        </div>
        <div className="composer-meta">
          <select value={profile?.id ?? ''} onChange={(e) => setActive(e.target.value)} title="Model profile" disabled={running}>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.model || 'no model'}
              </option>
            ))}
          </select>
          <span className="muted hide-sm">Shift+Enter for newline</span>
        </div>
      </form>
    </div>
  );
}

function UserBubble({ message }: { message: ChatMessage }) {
  const text = message.parts.map((p) => (p.type === 'text' && !p.hidden ? p.text : '')).join('');
  return <div className="bubble user">{text}</div>;
}

function AssistantBlock({
  message,
  results,
  streaming,
  onRestore,
}: {
  message: ChatMessage;
  results: Map<string, ToolResultPart>;
  streaming: boolean;
  onRestore?: () => void;
}) {
  const hasContent = message.parts.some((p) => (p.type === 'text' ? p.text.trim() : p.type !== 'reasoning' || p.text.trim()));
  if (!hasContent && !message.error && !onRestore && !streaming) return null;
  return (
    <div className="assistant">
      {message.parts.map((p, i) => {
        if (p.type === 'text') return p.text.trim() ? <Markdown key={i} text={p.text} /> : null;
        if (p.type === 'reasoning') return p.text.trim() ? <Reasoning key={i} text={p.text} live={streaming} /> : null;
        if (p.type === 'tool_call') return <ToolChip key={i} call={p} result={results.get(p.id)} />;
        return null;
      })}
      {streaming && !hasContent && (
        <div className="working">
          <span className="dots" /> Thinking…
        </div>
      )}
      {message.error && (
        <div className="error-box">
          <Icon name="alert" size={15} /> {message.error}
        </div>
      )}
      {message.stopReason === 'aborted' && <div className="muted small">Stopped.</div>}
      {onRestore && (
        <button type="button" className="restore" onClick={onRestore} title="Show the map as it was after this reply">
          <Icon name="restore" size={14} /> Show map from here
        </button>
      )}
    </div>
  );
}

function Reasoning({ text, live }: { text: string; live: boolean }) {
  return (
    <details className="reasoning" open={live || undefined}>
      <summary>Reasoning</summary>
      <div className="reasoning-text">{text}</div>
    </details>
  );
}

const TOOL_LABELS: Record<string, string> = {
  get_map_state: 'Checked the map',
  list_regions: 'Looked up regions',
  set_projection: 'Changed projection',
  color_regions: 'Coloured regions',
  set_choropleth: 'Applied colour scale',
  show_subdivisions: 'Showed subdivisions',
  add_labels: 'Added labels',
  add_markers: 'Added markers',
  add_lines: 'Drew lines',
  set_title: 'Set title',
  set_legend: 'Updated legend',
  set_style: 'Styled map',
  zoom_to: 'Framed map',
  remove_elements: 'Removed elements',
  reset_map: 'Reset map',
  web_search: 'Searched the web',
  fetch_url: 'Read page',
  wikipedia_search: 'Searched Wikipedia',
  wikipedia_page: 'Read Wikipedia',
  wikidata_sparql: 'Queried Wikidata',
  geocode: 'Geocoded',
};

function toolDetail(call: Extract<Part, { type: 'tool_call' }>): string {
  const a = call.args as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (call.name) {
    case 'web_search':
    case 'wikipedia_search':
    case 'geocode':
      return s(a.query);
    case 'fetch_url':
      return s(a.url).replace(/^https?:\/\//, '');
    case 'wikipedia_page':
      return s(a.title);
    case 'set_projection':
      return s(a.projection);
    case 'set_title':
      return s(a.title);
    default:
      return '';
  }
}

function ToolChip({ call, result }: { call: Extract<Part, { type: 'tool_call' }>; result?: ToolResultPart }) {
  const status = !result ? 'pending' : result.isError ? 'error' : 'ok';
  const detail = toolDetail(call);
  const kind = MAP_TOOL_NAMES.has(call.name) ? 'map' : 'research';
  return (
    <details className={`tool ${status} ${kind}`}>
      <summary>
        <span className="tool-status">{status === 'pending' ? <span className="spinner" /> : <Icon name={status === 'ok' ? 'check' : 'alert'} size={13} />}</span>
        <span className="tool-name">{TOOL_LABELS[call.name] ?? call.name}</span>
        {detail && <span className="tool-detail">{detail}</span>}
      </summary>
      <div className="tool-body">
        <div className="tool-label">Input</div>
        <pre>{JSON.stringify(call.args, null, 2)}</pre>
        {result && (
          <>
            <div className="tool-label">Result</div>
            <pre>{result.content.length > 4000 ? `${result.content.slice(0, 4000)}\n…` : result.content}</pre>
          </>
        )}
      </div>
    </details>
  );
}
