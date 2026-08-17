import React, { useMemo, useState } from 'react';
import type {
  AuthStatus,
  ChatConnection,
  ConnectionState,
  DirectChatConnection,
  DirectChatProvider,
} from '../shared/types';
import { ChannelsPanel } from './ChannelsPanel';

interface Props {
  restreamAuth: AuthStatus;
  restreamConnection: ConnectionState;
  restreamChannels: ChatConnection[];
  directConnections: DirectChatConnection[];
  onDirectConnect(provider: DirectChatProvider): Promise<void>;
  onDirectDisconnect(provider: DirectChatProvider): Promise<void>;
}

const PROVIDERS: DirectChatProvider[] = ['twitch', 'kick'];

/** Compact second header row for the independent chat transports feeding one combined timeline. */
export function ChatSourcesBar({
  restreamAuth,
  restreamConnection,
  restreamChannels,
  directConnections,
  onDirectConnect,
  onDirectDisconnect,
}: Props): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [busyProvider, setBusyProvider] = useState<DirectChatProvider>();
  const byProvider = useMemo(
    () => new Map(directConnections.map((connection) => [connection.provider, connection])),
    [directConnections],
  );

  const run = async (
    provider: DirectChatProvider,
    action: (provider: DirectChatProvider) => Promise<void>,
  ): Promise<void> => {
    setBusyProvider(provider);
    try {
      await action(provider);
    } finally {
      setBusyProvider(undefined);
    }
  };

  const restreamStatus = restreamAuth.authenticated
    ? restreamConnection.status
    : 'disconnected';

  return (
    <div className="chat-sources-bar">
      <span className="chat-sources-label">Chat sources</span>
      <button
        type="button"
        className="source-chip"
        onClick={() => setOpen(true)}
        aria-label="Manage Restream chat source"
      >
        <span className={`source-status ${restreamStatus}`} />
        Restream
      </button>
      {PROVIDERS.map((provider) => {
        const connection = byProvider.get(provider);
        return (
          <button
            key={provider}
            type="button"
            className={`source-chip source-${provider}`}
            onClick={() => setOpen(true)}
            aria-label={`Manage ${providerLabel(provider)} chat source`}
          >
            <span className={`source-status ${connection?.status ?? 'disconnected'}`} />
            {providerLabel(provider)}
            {connection?.status === 'connected' && connection.isLive === true ? (
              <span
                className="source-viewers"
                title={`${providerLabel(provider)} live viewers`}
              >
                · {connection.viewerCount?.toLocaleString() ?? '—'}
              </span>
            ) : null}
          </button>
        );
      })}
      {restreamAuth.authenticated && <ChannelsPanel connections={restreamChannels} />}
      <span className="chat-sources-help">Messages merge into one feed</span>
      {open && (
        <>
          <div className="channels-scrim" onClick={() => setOpen(false)} />
          <div className="chat-sources-popover" role="dialog" aria-label="Chat source connections">
            <div className="channels-popover-head">
              <h3>Chat source connections</h3>
              <button
                type="button"
                className="btn icon ghost"
                onClick={() => setOpen(false)}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="chat-source-list">
              <div className="chat-source-row">
                <span className={`source-status ${restreamStatus}`} />
                <div className="chat-source-copy">
                  <strong>Restream</strong>
                  <span>
                    {restreamAuth.authenticated
                      ? restreamConnection.status === 'connected'
                        ? 'Connected to the combined Restream feed'
                        : `Signed in · ${restreamConnection.status}`
                      : 'Use the existing Sign in to Restream button'}
                  </span>
                </div>
              </div>
              {PROVIDERS.map((provider) => {
                const connection = byProvider.get(provider) ?? {
                  provider,
                  status: 'disconnected' as const,
                };
                const connected = connection.status === 'connected';
                const busy = connection.status === 'connecting' || busyProvider === provider;
                return (
                  <div className="chat-source-row" key={provider}>
                    <span className={`source-status ${connection.status}`} />
                    <div className="chat-source-copy">
                      <strong>
                        {providerLabel(provider)}
                        {connection.accountName ? ` · ${connection.accountName}` : ''}
                      </strong>
                      <span>{connection.lastError ?? connection.detail ?? statusCopy(connection.status)}</span>
                      {connected && connection.isLive !== undefined ? (
                        <span className="chat-source-viewers">
                          {connection.isLive
                            ? `${connection.viewerCount?.toLocaleString() ?? '—'} live ${connection.viewerCount === 1 ? 'viewer' : 'viewers'}`
                            : 'Stream offline'}
                        </span>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className={`btn${connected ? ' ghost' : ' primary'}`}
                      disabled={busy || connection.status === 'not-configured'}
                      onClick={() =>
                        void run(
                          provider,
                          connected ? onDirectDisconnect : onDirectConnect,
                        )
                      }
                    >
                      {busy ? 'Connecting…' : connected ? 'Disconnect' : 'Connect'}
                    </button>
                  </div>
                );
              })}
            </div>
            <p className="chat-sources-foot">
              Twitch and Kick messages are read and sent directly. Other connected
              channels send through Restream.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

function providerLabel(provider: DirectChatProvider): string {
  return provider === 'twitch' ? 'Twitch' : 'Kick';
}

function statusCopy(status: DirectChatConnection['status']): string {
  switch (status) {
    case 'not-configured':
      return 'Developer app setup is not finished yet.';
    case 'disconnected':
      return 'Not connected.';
    case 'connecting':
      return 'Connecting…';
    case 'connected':
      return 'Reading and sending chat directly.';
    case 'error':
      return 'Connection failed. Try again.';
  }
}
