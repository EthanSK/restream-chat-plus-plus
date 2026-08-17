import type {
  ChatConnection,
  ChatSendDestination,
  ChatSendDestinationResult,
  DirectChatConnection,
  DirectChatProvider,
  DirectChatSendResult,
  SendTextResult,
} from '../shared/types';
import type { QueuedSend } from './chat-send-queue';

interface FrozenSend {
  targets: ChatSendDestination[];
  successes: Map<ChatSendDestination, ChatSendDestinationResult>;
}

export interface ChatSendFanout {
  send(item: QueuedSend): Promise<SendTextResult>;
}

/** Sends once per intended destination and remembers partial success so retries cannot duplicate it. */
export function createChatSendFanout({
  getRestreamConnections,
  getDirectConnections,
  sendRestream,
  sendDirect,
}: {
  getRestreamConnections: () => ChatConnection[];
  getDirectConnections: () => DirectChatConnection[];
  sendRestream: (item: QueuedSend) => Promise<SendTextResult>;
  sendDirect: (
    provider: DirectChatProvider,
    text: string,
  ) => Promise<DirectChatSendResult>;
}): ChatSendFanout {
  const sends = new Map<string, FrozenSend>();

  return {
    async send(item): Promise<SendTextResult> {
      let frozen = sends.get(item.clientId);
      if (!frozen) {
        const targets = intendedTargets(
          getRestreamConnections(),
          getDirectConnections(),
        );
        if (targets.length === 0) {
          return { ok: false, reason: 'no-active-connections' };
        }
        if (sends.size >= 500) {
          const oldest = sends.keys().next().value;
          if (oldest !== undefined) sends.delete(oldest); // Failed messages retain progress for manual retry; cap that evidence so a long session cannot grow forever.
        }
        frozen = { targets, successes: new Map() };
        sends.set(item.clientId, frozen);
      }

      const results: ChatSendDestinationResult[] = [];
      for (const destination of frozen.targets) {
        const succeeded = frozen.successes.get(destination);
        if (succeeded) {
          results.push(succeeded);
          continue;
        }
        const result =
          destination === 'restream'
            ? await sendRestream(item)
            : await sendDirect(destination, item.text);
        const destinationResult: ChatSendDestinationResult = {
          destination,
          ok: result.ok,
          status: result.status,
          error: result.error,
          messageId:
            'messageId' in result && typeof result.messageId === 'string'
              ? result.messageId
              : undefined,
          authorizationRequired:
            'authorizationRequired' in result &&
            result.authorizationRequired === true,
        };
        results.push(destinationResult);
        if (destinationResult.ok) frozen.successes.set(destination, destinationResult);
      }

      const failed = results.filter((result) => !result.ok);
      if (failed.length === 0) {
        sends.delete(item.clientId);
        return { ok: true, destinations: results };
      }
      const sent = results.filter((result) => result.ok);
      const authorizationRequired = failed.some(
        (result) => result.authorizationRequired,
      );
      return {
        ok: false,
        reason: authorizationRequired
          ? 'provider-authorization-required'
          : 'destination-send-failed',
        status: failed.find((result) => result.status)?.status,
        error: deliveryFailureText(sent, failed, authorizationRequired),
        destinations: results,
      };
    },
  };
}

export function intendedTargets(
  restreamConnections: ChatConnection[],
  directConnections: DirectChatConnection[],
): ChatSendDestination[] {
  const restreamPlatforms = new Set(
    restreamConnections
      .filter((connection) => connection.status === 'connected')
      .map((connection) => connection.platform),
  );
  const targets: ChatSendDestination[] = [];
  if (restreamPlatforms.size > 0) targets.push('restream');
  for (const provider of ['twitch', 'kick'] as const) {
    if (restreamPlatforms.has(provider)) continue;
    if (
      directConnections.some(
        (connection) =>
          connection.provider === provider && connection.status === 'connected',
      )
    ) {
      targets.push(provider);
    }
  }
  return targets;
}

function deliveryFailureText(
  sent: ChatSendDestinationResult[],
  failed: ChatSendDestinationResult[],
  authorizationRequired: boolean,
): string {
  const sentText =
    sent.length > 0
      ? `Sent to ${sent.map((result) => label(result.destination)).join(', ')}. `
      : '';
  const failedText = failed
    .map(
      (result) =>
        `${label(result.destination)} failed${result.error ? `: ${result.error}` : ''}`,
    )
    .join('; ');
  const reconnectText = authorizationRequired
    ? ' Reconnect the failed platform to approve sending.'
    : '';
  return `${sentText}${failedText}.${reconnectText}`;
}

function label(destination: ChatSendDestination): string {
  switch (destination) {
    case 'restream':
      return 'Restream';
    case 'twitch':
      return 'Twitch';
    case 'kick':
      return 'Kick';
  }
}
