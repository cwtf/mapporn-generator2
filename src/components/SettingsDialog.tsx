import { useEffect, useRef, useState } from 'react';
import { listModels } from '../agent/llm';
import { PRESETS, profileFromPreset, useSettings, type ProviderProfile } from '../store/settings';
import { useTheme, type ThemePref } from '../store/theme';
import { Icon } from './Icon';

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const { profiles, activeId, maxSteps, upsertProfile, removeProfile, setActive, setMaxSteps } = useSettings();
  const { pref, setPref } = useTheme();
  const [editingId, setEditingId] = useState(activeId);
  const [addPreset, setAddPreset] = useState('');

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setEditingId(useSettings.getState().activeId);
      d.showModal();
    } else if (!open && d.open) d.close();
  }, [open]);

  const editing = profiles.find((p) => p.id === editingId) ?? profiles[0];

  return (
    <dialog ref={ref} className="settings" onClose={onClose} onCancel={onClose}>
      <div className="settings-head">
        <h2>Settings</h2>
        <button type="button" className="btn icon" onClick={onClose} aria-label="Close settings">
          <Icon name="close" />
        </button>
      </div>

      <section>
        <h3>Appearance</h3>
        <div className="segmented" role="radiogroup" aria-label="Theme">
          {(['system', 'light', 'dark'] as ThemePref[]).map((t) => (
            <button type="button" key={t} role="radio" aria-checked={pref === t} className={pref === t ? 'active' : ''} onClick={() => setPref(t)}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h3>AI providers</h3>
        <p className="muted small">
          Any provider that speaks the Anthropic Messages or OpenAI Chat Completions API works. Keys are stored in this browser only and sent to your
          provider through the local server.
        </p>
        <div className="profile-row">
          <select value={editing?.id ?? ''} onChange={(e) => setEditingId(e.target.value)} aria-label="Profile to edit">
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.id === activeId ? ' (active)' : ''}
              </option>
            ))}
          </select>
          <select
            value={addPreset}
            onChange={(e) => {
              const preset = PRESETS.find((p) => p.id === e.target.value);
              if (preset) {
                const prof = profileFromPreset(preset);
                upsertProfile(prof);
                setEditingId(prof.id);
              }
              setAddPreset('');
            }}
            aria-label="Add provider"
          >
            <option value="">+ Add provider…</option>
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        {editing && (
          <ProfileEditor
            key={editing.id}
            profile={editing}
            isActive={editing.id === activeId}
            onChange={upsertProfile}
            onActivate={() => setActive(editing.id)}
            onDelete={
              profiles.length > 1
                ? () => {
                    removeProfile(editing.id);
                    setEditingId(useSettings.getState().activeId);
                  }
                : undefined
            }
          />
        )}
      </section>

      <section>
        <h3>Agent</h3>
        <label className="field inline">
          <span>Max tool steps per message</span>
          <input type="number" min={5} max={200} value={maxSteps} onChange={(e) => setMaxSteps(Math.max(5, Math.min(200, Number(e.target.value) || 40)))} />
        </label>
      </section>
    </dialog>
  );
}

function ProfileEditor({
  profile,
  isActive,
  onChange,
  onActivate,
  onDelete,
}: {
  profile: ProviderProfile;
  isActive: boolean;
  onChange: (p: ProviderProfile) => void;
  onActivate: () => void;
  onDelete?: () => void;
}) {
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error' | 'busy'; text: string }>();
  const set = <K extends keyof ProviderProfile>(k: K, v: ProviderProfile[K]) => onChange({ ...profile, [k]: v });

  const jsonError = (s: string) => {
    if (!s.trim()) return undefined;
    try {
      const v = JSON.parse(s);
      return v && typeof v === 'object' && !Array.isArray(v) ? undefined : 'Must be a JSON object';
    } catch {
      return 'Invalid JSON';
    }
  };

  const fetchModels = async () => {
    setStatus({ kind: 'busy', text: 'Contacting provider…' });
    try {
      const list = await listModels(profile);
      setModels(list);
      setStatus({ kind: 'ok', text: `Connected — ${list.length} models available.` });
    } catch (e) {
      setStatus({ kind: 'error', text: (e as Error).message });
    }
  };

  return (
    <div className="profile">
      <div className="grid2">
        <label className="field">
          <span>Name</span>
          <input value={profile.name} onChange={(e) => set('name', e.target.value)} />
        </label>
        <label className="field">
          <span>API format</span>
          <select value={profile.format} onChange={(e) => set('format', e.target.value as ProviderProfile['format'])}>
            <option value="anthropic">Anthropic Messages</option>
            <option value="openai">OpenAI Chat Completions</option>
          </select>
        </label>
      </div>
      <label className="field">
        <span>Base URL</span>
        <input
          value={profile.baseUrl}
          onChange={(e) => set('baseUrl', e.target.value)}
          placeholder={profile.format === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'}
          spellCheck={false}
        />
        <small className="muted">
          {profile.format === 'anthropic' ? 'Requests go to {base}/v1/messages' : 'Requests go to {base}/chat/completions'}
        </small>
      </label>
      <label className="field">
        <span>API key</span>
        <div className="with-button">
          <input
            type={showKey ? 'text' : 'password'}
            value={profile.apiKey}
            onChange={(e) => set('apiKey', e.target.value)}
            placeholder="Not needed for local servers"
            autoComplete="off"
            spellCheck={false}
          />
          <button type="button" className="btn icon" onClick={() => setShowKey((s) => !s)} aria-label={showKey ? 'Hide key' : 'Show key'}>
            <Icon name={showKey ? 'eyeOff' : 'eye'} />
          </button>
        </div>
      </label>
      <label className="field">
        <span>Model</span>
        <div className="with-button">
          <input value={profile.model} onChange={(e) => set('model', e.target.value)} list={`models-${profile.id}`} spellCheck={false} />
          <button type="button" className="btn small" onClick={fetchModels} disabled={status?.kind === 'busy'}>
            Fetch models
          </button>
        </div>
        <datalist id={`models-${profile.id}`}>
          {models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </label>
      {status && <div className={`status ${status.kind}`}>{status.text}</div>}
      <div className="grid2">
        <label className="field">
          <span>Max output tokens</span>
          <input type="number" min={256} value={profile.maxTokens} onChange={(e) => set('maxTokens', Math.max(256, Number(e.target.value) || 16000))} />
        </label>
        <div className="checks">
          <label className="check">
            <input type="checkbox" checked={profile.stream} onChange={(e) => set('stream', e.target.checked)} /> Stream responses
          </label>
          {profile.format === 'anthropic' && (
            <label className="check">
              <input type="checkbox" checked={profile.promptCaching} onChange={(e) => set('promptCaching', e.target.checked)} /> Prompt caching
            </label>
          )}
        </div>
      </div>
      <details className="advanced">
        <summary>Advanced</summary>
        <label className="field">
          <span>Extra headers (JSON)</span>
          <textarea rows={2} value={profile.headers} onChange={(e) => set('headers', e.target.value)} placeholder='{"HTTP-Referer": "https://example.com"}' spellCheck={false} />
          {jsonError(profile.headers) && <small className="error-text">{jsonError(profile.headers)}</small>}
        </label>
        <label className="field">
          <span>Extra request body (JSON, merged into every request)</span>
          <textarea
            rows={3}
            value={profile.extraBody}
            onChange={(e) => set('extraBody', e.target.value)}
            placeholder={profile.format === 'anthropic' ? '{"output_config": {"effort": "high"}}' : '{"temperature": 0.3}'}
            spellCheck={false}
          />
          {jsonError(profile.extraBody) && <small className="error-text">{jsonError(profile.extraBody)}</small>}
        </label>
      </details>
      <div className="profile-actions">
        {onDelete && (
          <button type="button" className="btn danger" onClick={onDelete}>
            <Icon name="trash" size={15} /> Remove
          </button>
        )}
        <div className="spacer" />
        {isActive ? (
          <span className="muted small">
            <Icon name="check" size={14} /> Active profile
          </span>
        ) : (
          <button type="button" className="btn primary" onClick={onActivate}>
            Use this profile
          </button>
        )}
      </div>
    </div>
  );
}
