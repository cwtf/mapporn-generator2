import { useEffect, useState } from 'react';
import { useChats } from '../store/chatStore';
import { Icon } from './Icon';

function relTime(ts: number) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ts).toLocaleDateString();
}

export function HistoryPanel({ onOpened }: { onOpened: () => void }) {
  const { chats, current, refresh, openChat, deleteChat, deleteAll } = useChats();
  const [confirmId, setConfirmId] = useState<string>();
  const [confirmAll, setConfirmAll] = useState(false);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!confirmId && !confirmAll) return;
    const t = setTimeout(() => (setConfirmId(undefined), setConfirmAll(false)), 4000);
    return () => clearTimeout(t);
  }, [confirmId, confirmAll]);

  return (
    <div className="history">
      <div className="history-head">
        <span className="muted">{chats.length ? `${chats.length} saved map${chats.length === 1 ? '' : 's'}` : 'No saved maps yet'}</span>
        {chats.length > 0 && (
          <button
            type="button"
            className={`btn small danger${confirmAll ? ' armed' : ''}`}
            onClick={() => {
              if (confirmAll) {
                setConfirmAll(false);
                void deleteAll();
              } else setConfirmAll(true);
            }}
          >
            <Icon name="trash" size={14} /> {confirmAll ? 'Confirm delete all' : 'Delete all'}
          </button>
        )}
      </div>
      <ul className="history-list">
        {chats.map((c) => (
          <li key={c.id} className={c.id === current?.id ? 'active' : ''}>
            <button
              type="button"
              className="history-item"
              onClick={async () => {
                await openChat(c.id);
                onOpened();
              }}
            >
              <span className="history-title">{c.title}</span>
              <span className="muted small">
                {relTime(c.updatedAt)} · {c.turns} message{c.turns === 1 ? '' : 's'}
              </span>
            </button>
            <button
              type="button"
              className={`btn icon small danger${confirmId === c.id ? ' armed' : ''}`}
              title={confirmId === c.id ? 'Click again to delete' : 'Delete'}
              aria-label={`Delete ${c.title}`}
              onClick={() => {
                if (confirmId === c.id) {
                  setConfirmId(undefined);
                  void deleteChat(c.id);
                } else setConfirmId(c.id);
              }}
            >
              {confirmId === c.id ? <Icon name="check" size={14} /> : <Icon name="trash" size={14} />}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
