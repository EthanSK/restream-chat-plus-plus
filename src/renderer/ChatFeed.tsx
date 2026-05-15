import React from 'react';
import { Virtuoso } from 'react-virtuoso';
import { ChatMessage, PLATFORM_COLORS, PLATFORM_LABELS } from '../shared/types';

interface Props {
  messages: ChatMessage[];
  authenticated: boolean;
}

export function ChatFeed({ messages, authenticated }: Props): React.ReactElement {
  if (!authenticated) {
    return (
      <div className="feed">
        <div className="empty">
          <h2>Welcome to Restream Chat++</h2>
          <p>
            A native, cross-platform replacement for the official Restream Chat
            desktop app — built because the official one is x86 Electron under
            Rosetta and crashes on every audio queue.
          </p>
          <p>Sign in with Restream above to start streaming live chat into this
            window.</p>
        </div>
      </div>
    );
  }
  if (messages.length === 0) {
    return (
      <div className="feed">
        <div className="empty">
          <h2>Listening for chat…</h2>
          <p>
            Once a viewer messages on any of your linked platforms, it'll show
            up here.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="feed">
      <Virtuoso
        data={messages}
        followOutput="smooth"
        initialTopMostItemIndex={messages.length - 1}
        itemContent={(_, m) => <MessageRow message={m} />}
      />
    </div>
  );
}

function MessageRow({ message: m }: { message: ChatMessage }): React.ReactElement {
  const color = m.color || PLATFORM_COLORS[m.platform];
  return (
    <div className="message-row">
      <span className="platform-badge" style={{ background: color }} />
      <div className="message-meta">
        <div className="message-header">
          <span className="username" style={{ color }}>
            {m.username}
          </span>
          <span className="platform-label">{PLATFORM_LABELS[m.platform]}</span>
          <span className="timestamp">{formatTs(m.ts)}</span>
        </div>
        <div className="body">{m.text}</div>
      </div>
    </div>
  );
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}
