import { create } from 'zustand';
import { runAgent } from '../agent/agent';
import { briefMapState } from '../agent/tools';
import type { ChatMessage, ChatRecord, ChatSummary } from '../agent/types';
import * as db from '../db';
import { geo } from '../map/geodata';
import type { MapState } from '../map/types';
import { useMapStore } from './mapStore';
import { activeProfile, useSettings } from './settings';

interface ChatStore {
  chats: ChatSummary[];
  current: ChatRecord | null;
  running: boolean;
  abort?: AbortController;
  refresh: () => Promise<void>;
  newChat: () => void;
  openChat: (id: string) => Promise<void>;
  deleteChat: (id: string) => Promise<void>;
  deleteAll: () => Promise<void>;
  send: (text: string) => Promise<void>;
  stop: () => void;
  restoreSnapshot: (map: MapState) => void;
}

function titleFrom(text: string) {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 57)}…` : t || 'New map';
}

/** Load subdivision geometry a saved map depends on before showing it. */
async function prepareMap(map: MapState) {
  await Promise.all(map.subdivisions.map((c) => geo.loadSubdivisions(c).catch(() => undefined)));
  // Region ids inside colours/choropleth may belong to other countries' subdivisions too.
  const ids = [...Object.keys(map.regions), ...Object.keys(map.choropleth?.values ?? {})];
  const countries = new Set<string>();
  for (const id of ids) {
    const m = id.match(/^([A-Z]{2})-/);
    if (m) {
      const cid = await geo.resolveCountry(m[1]);
      if (cid && geo.hasSubdivisions(cid)) countries.add(cid);
    }
  }
  await Promise.all([...countries].map((c) => geo.loadSubdivisions(c).catch(() => undefined)));
}

export const useChats = create<ChatStore>((set, get) => ({
  chats: [],
  current: null,
  running: false,

  refresh: async () => set({ chats: await db.listChats() }),

  newChat: () => {
    get().stop();
    set({ current: null });
    useMapStore.getState().reset();
  },

  openChat: async (id) => {
    get().stop();
    const chat = await db.getChat(id);
    if (!chat) return;
    await prepareMap(chat.map);
    set({ current: chat });
    useMapStore.getState().setMap(chat.map);
  },

  deleteChat: async (id) => {
    await db.deleteChat(id);
    if (get().current?.id === id) get().newChat();
    await get().refresh();
  },

  deleteAll: async () => {
    get().stop();
    await db.deleteAllChats();
    set({ current: null });
    useMapStore.getState().reset();
    await get().refresh();
  },

  stop: () => {
    get().abort?.abort();
  },

  restoreSnapshot: (map) => {
    void prepareMap(map).then(() => useMapStore.getState().setMap(map));
  },

  send: async (text) => {
    if (get().running || !text.trim()) return;
    const profile = activeProfile();
    if (!profile) return;
    const now = Date.now();
    const mapNow = useMapStore.getState().map;
    const chat: ChatRecord = get().current ?? {
      id: crypto.randomUUID(),
      title: titleFrom(text),
      createdAt: now,
      updatedAt: now,
      messages: [],
      map: mapNow,
    };
    const user: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      ts: now,
      parts: [
        { type: 'text', text: `[Current map: ${briefMapState(mapNow)}]`, hidden: true },
        { type: 'text', text: text.trim() },
      ],
    };
    const abort = new AbortController();
    let latest: ChatRecord = { ...chat, messages: [...chat.messages, user], updatedAt: now };
    set({ current: latest, running: true, abort });
    await db.saveChat(latest);
    void get().refresh();

    try {
      const messages = await runAgent(latest.messages, profile, useSettings.getState().maxSteps, abort.signal, {
        onMessages: (msgs) => {
          // Ignore updates if the user switched chats mid-run.
          if (get().current?.id !== chat.id) return;
          latest = { ...latest, messages: msgs };
          set({ current: latest });
        },
      });
      latest = { ...latest, messages, map: structuredClone(useMapStore.getState().map), updatedAt: Date.now() };
    } finally {
      await db.saveChat(latest);
      if (get().current?.id === chat.id) set({ current: latest });
      set({ running: false, abort: undefined });
      void get().refresh();
    }
  },
}));

// Persist manual map edits (zoom, projection picker) into the open chat, debounced.
let saveTimer: ReturnType<typeof setTimeout> | undefined;
useMapStore.subscribe((s) => {
  const { current, running } = useChats.getState();
  if (!current || running) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const cur = useChats.getState().current;
    if (!cur || cur.id !== current.id) return;
    const next = { ...cur, map: structuredClone(s.map) };
    useChats.setState({ current: next });
    void db.saveChat(next);
  }, 800);
});
