import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ApiFormat = 'anthropic' | 'openai';

export interface ProviderProfile {
  id: string;
  name: string;
  format: ApiFormat;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  stream: boolean;
  /** Anthropic prompt caching (cache_control breakpoints) */
  promptCaching: boolean;
  /** JSON object of extra HTTP headers */
  headers: string;
  /** JSON object merged into the request body (e.g. {"temperature":0.3} or {"output_config":{"effort":"high"}}) */
  extraBody: string;
}

export interface Preset {
  id: string;
  label: string;
  format: ApiFormat;
  baseUrl: string;
  model: string;
  promptCaching?: boolean;
  note?: string;
}

export const PRESETS: Preset[] = [
  { id: 'anthropic', label: 'Anthropic (Claude)', format: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5', promptCaching: true },
  { id: 'openai', label: 'OpenAI', format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5' },
  { id: 'openrouter', label: 'OpenRouter', format: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-opus-5' },
  { id: 'gemini', label: 'Google Gemini (OpenAI-compatible)', format: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-pro' },
  { id: 'deepseek', label: 'DeepSeek', format: 'openai', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  { id: 'mistral', label: 'Mistral', format: 'openai', baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-large-latest' },
  { id: 'groq', label: 'Groq', format: 'openai', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  { id: 'xai', label: 'xAI (Grok)', format: 'openai', baseUrl: 'https://api.x.ai/v1', model: 'grok-4' },
  { id: 'together', label: 'Together AI', format: 'openai', baseUrl: 'https://api.together.xyz/v1', model: '' },
  { id: 'ollama', label: 'Ollama (local)', format: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1', note: 'No API key needed.' },
  { id: 'lmstudio', label: 'LM Studio (local)', format: 'openai', baseUrl: 'http://localhost:1234/v1', model: '', note: 'No API key needed.' },
  { id: 'custom-anthropic', label: 'Custom (Anthropic format)', format: 'anthropic', baseUrl: 'https://', model: '' },
  { id: 'custom-openai', label: 'Custom (OpenAI format)', format: 'openai', baseUrl: 'https://', model: '' },
];

export function profileFromPreset(p: Preset): ProviderProfile {
  return {
    id: crypto.randomUUID(),
    name: p.id.startsWith('custom') ? p.label.replace(' format', '') : p.label.replace(/ \(.*\)$/, ''),
    format: p.format,
    baseUrl: p.baseUrl,
    apiKey: '',
    model: p.model,
    maxTokens: 16000,
    stream: true,
    promptCaching: p.promptCaching ?? false,
    headers: '',
    extraBody: '',
  };
}

interface SettingsStore {
  profiles: ProviderProfile[];
  activeId: string;
  maxSteps: number;
  upsertProfile: (p: ProviderProfile) => void;
  removeProfile: (id: string) => void;
  setActive: (id: string) => void;
  setMaxSteps: (n: number) => void;
}

const initial = profileFromPreset(PRESETS[0]);

export const useSettings = create<SettingsStore>()(
  persist(
    (set) => ({
      profiles: [initial],
      activeId: initial.id,
      maxSteps: 40,
      upsertProfile: (p) =>
        set((s) => ({
          profiles: s.profiles.some((x) => x.id === p.id) ? s.profiles.map((x) => (x.id === p.id ? p : x)) : [...s.profiles, p],
        })),
      removeProfile: (id) =>
        set((s) => {
          const profiles = s.profiles.filter((p) => p.id !== id);
          return { profiles, activeId: s.activeId === id ? (profiles[0]?.id ?? '') : s.activeId };
        }),
      setActive: (activeId) => set({ activeId }),
      setMaxSteps: (maxSteps) => set({ maxSteps }),
    }),
    { name: 'mapgen.settings' },
  ),
);

export function activeProfile(): ProviderProfile | undefined {
  const s = useSettings.getState();
  return s.profiles.find((p) => p.id === s.activeId) ?? s.profiles[0];
}
