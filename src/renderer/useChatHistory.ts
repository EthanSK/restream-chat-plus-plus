import { useRef, useState } from 'react';
import type { ChatMessage } from '../shared/types';
import { rcpp } from './api';

export type ChatHistoryStatus = 'ready' | 'loading' | 'exhausted' | 'error';

interface HistoryState {
  messages: ChatMessage[];
  status: ChatHistoryStatus;
  nextBefore?: number;
}

const EMPTY_HISTORY: HistoryState = { messages: [], status: 'ready' };

export function useChatHistory() {
  const [history, setHistory] = useState(EMPTY_HISTORY);
  const requestRef = useRef<symbol | undefined>(undefined);

  function resetHistory(): void {
    requestRef.current = undefined;
    setHistory(EMPTY_HISTORY);
  }

  async function loadOlderMessages(beforeLive?: number): Promise<void> {
    if (requestRef.current || history.status === 'exhausted') return;
    const request = Symbol();
    requestRef.current = request;
    setHistory((previous) => ({ ...previous, status: 'loading' }));
    try {
      const page = await rcpp.loadOlderChatMessages(history.nextBefore ?? beforeLive);
      // Clear Chat can run while the IPC reply is on its way back.
      if (requestRef.current !== request) return;
      setHistory((previous) => ({
        messages: [...page.messages, ...previous.messages],
        nextBefore: page.nextBefore,
        status: page.nextBefore === undefined ? 'exhausted' : 'ready',
      }));
    } catch {
      if (requestRef.current === request) {
        setHistory((previous) => ({ ...previous, status: 'error' }));
      }
    } finally {
      if (requestRef.current === request) requestRef.current = undefined;
    }
  }

  return { history, loadOlderMessages, resetHistory };
}
