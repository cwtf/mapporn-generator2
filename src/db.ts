import { openDB, type DBSchema } from 'idb';
import type { ChatRecord, ChatSummary } from './agent/types';

interface MapGenDB extends DBSchema {
  chats: { key: string; value: ChatRecord; indexes: { updatedAt: number } };
}

const dbp = openDB<MapGenDB>('mapgen', 1, {
  upgrade(db) {
    const store = db.createObjectStore('chats', { keyPath: 'id' });
    store.createIndex('updatedAt', 'updatedAt');
  },
});

export async function listChats(): Promise<ChatSummary[]> {
  const db = await dbp;
  const all = await db.getAllFromIndex('chats', 'updatedAt');
  return all.reverse().map((c) => ({
    id: c.id,
    title: c.title,
    updatedAt: c.updatedAt,
    turns: c.messages.filter((m) => m.role === 'user').length,
  }));
}

export async function getChat(id: string) {
  return (await dbp).get('chats', id);
}

export async function saveChat(chat: ChatRecord) {
  await (await dbp).put('chats', structuredClone(chat));
}

export async function deleteChat(id: string) {
  await (await dbp).delete('chats', id);
}

export async function deleteAllChats() {
  await (await dbp).clear('chats');
}
