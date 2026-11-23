import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { MAX_CHAT_MESSAGES, type ChatHistoryPage, type ChatMessage } from '../shared/types';

const PAGE_SIZE = 50;

/** Local scrollback for normalized feed rows, in arrival order. */
export class ChatHistory {
  private readonly db: DatabaseSync;
  private readonly insert: StatementSync;
  private readonly trim: StatementSync;
  private readonly page: StatementSync;

  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    try {
      this.db.exec(`
        PRAGMA secure_delete = ON;
        CREATE TABLE IF NOT EXISTS messages (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          message TEXT NOT NULL
        );
      `);
      this.insert = this.db.prepare(
        'INSERT INTO messages (id, message) VALUES (?, ?) ON CONFLICT (id) DO NOTHING',
      );
      this.trim = this.db.prepare(`
        DELETE FROM messages WHERE sequence < (
          SELECT sequence FROM messages ORDER BY sequence DESC LIMIT 1 OFFSET ?
        )
      `);
      this.page = this.db.prepare(`
        SELECT sequence, message FROM messages WHERE sequence < ?
        ORDER BY sequence DESC LIMIT ?
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  add(chatMessage: ChatMessage): number | undefined {
    if (chatMessage.pendingSend !== undefined) return undefined;
    const { id, platform, username, text, ts, color, source, self } = chatMessage;
    // Persist only what the feed needs. Raw provider payloads and transient
    // delivery state don't belong in scrollback.
    const message = JSON.stringify({ id, platform, username, text, ts, color, source, self });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.insert.run(id, message);
      if (result.changes) this.trim.run(MAX_CHAT_MESSAGES - 1);
      this.db.exec('COMMIT');
      return result.changes ? Number(result.lastInsertRowid) : undefined;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  loadOlder(before = Number.MAX_SAFE_INTEGER): ChatHistoryPage {
    const rows = this.page.all(before, PAGE_SIZE + 1) as {
      sequence: number;
      message: string;
    }[];
    const nextBefore = rows.length > PAGE_SIZE ? rows[PAGE_SIZE - 1].sequence : undefined;
    const messages = rows.slice(0, PAGE_SIZE).reverse().map(({ sequence, message }) => ({
      ...(JSON.parse(message) as ChatMessage),
      historySequence: sequence,
    }));
    return { messages, nextBefore };
  }

  clear(): void {
    this.db.exec('DELETE FROM messages');
  }

  close(): void {
    this.db.close();
  }
}
