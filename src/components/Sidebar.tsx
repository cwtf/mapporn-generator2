import { useState } from 'react';
import { useChats } from '../store/chatStore';
import { ChatPanel } from './ChatPanel';
import { HistoryPanel } from './HistoryPanel';
import { Icon } from './Icon';

export function Sidebar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [tab, setTab] = useState<'chat' | 'history'>('chat');
  const newChat = useChats((s) => s.newChat);
  const title = useChats((s) => s.current?.title);

  return (
    <aside className="sidebar" aria-label="Map assistant">
      <div className="sidebar-head">
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'chat'} className={tab === 'chat' ? 'active' : ''} onClick={() => setTab('chat')}>
            <Icon name="chat" size={15} /> Assistant
          </button>
          <button type="button" role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
            <Icon name="history" size={15} /> History
          </button>
        </div>
        <button
          type="button"
          className="btn small"
          onClick={() => {
            newChat();
            setTab('chat');
          }}
          title="Start a new map"
        >
          <Icon name="plus" size={15} /> New
        </button>
      </div>
      {tab === 'chat' && title && <div className="chat-title" title={title}>{title}</div>}
      {tab === 'chat' ? <ChatPanel onOpenSettings={onOpenSettings} /> : <HistoryPanel onOpened={() => setTab('chat')} />}
    </aside>
  );
}
