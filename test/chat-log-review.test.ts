import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatLogger } from "../src/core/chat-log";
import type { Chat, Message } from "../src/core/models";

const roots: string[] = [];
afterEach(async () => { for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true }); });
const chat: Chat = { id: "a".repeat(24), name: "Synthetic review", isGroup: true, unread: 0, messagesCount: 1 };
const emptySource = { resolveChat: async () => chat, history: async () => [] as Message[] };
async function path() { const dir = await mkdtemp(join(realpathSync(tmpdir()), "mizito-log-review-")); roots.push(dir); return join(dir, "history.sqlite"); }

test("unrelated version-0 and forged version-1 databases are refused without changing their bytes", async () => {
  for (const version of [0, 1]) {
    const p = await path(), db = new Database(p);
    db.exec(`CREATE TABLE unrelated_data (value TEXT); INSERT INTO unrelated_data VALUES ('keep'); PRAGMA user_version=${version};`); db.close(); await chmod(p, 0o600);
    const before = await readFile(p);
    expect(() => new ChatLogger({ path: p, source: emptySource })).toThrow("INVALID_SCHEMA");
    expect(await readFile(p)).toEqual(before);
  }
});

test("existing logger validates marker, column structure and primary keys on reopen", async () => {
  for (const change of ["UPDATE metadata SET value='other-format' WHERE key='format'", "ALTER TABLE media RENAME COLUMN bytes TO missing_bytes"]) {
    const p = await path(); new ChatLogger({ path: p, source: emptySource }).close();
    const db = new Database(p); db.exec(change); db.close(); const before = await readFile(p);
    expect(() => new ChatLogger({ path: p, source: emptySource })).toThrow("INVALID_SCHEMA");
    expect(await readFile(p)).toEqual(before);
  }
});

test("edited attachments are re-fetched even when normalized metadata and edit Boolean stay identical", async () => {
  const p = await path(); let revision = 1, calls = 0;
  const m: Message = { id: "b".repeat(24), chatId: chat.id, chatName: chat.name, sender: "Synthetic sender", from: "c".repeat(24), fromMe: false, index: 1, date: 123, text: "caption", mentions: [], edited: true, deleted: false, service: false, attachment: { kind: "photo", name: "same.png", size: 1 } };
  const logger = new ChatLogger({ path: p, source: { ...emptySource, history: async () => [m] }, fetchMedia: async () => { calls++; return { bytes: Buffer.from([revision]), mime: "image/png", kind: "photo" }; } });
  try {
    await logger.run({ chats: chat.id, perChatLimit: 15, includeMedia: true }); revision = 2;
    await logger.run({ chats: chat.id, perChatLimit: 15, includeMedia: true }); expect(calls).toBe(2);
    const db = new Database(p, { readonly: true });
    try { expect(Buffer.from((db.query("SELECT bytes FROM media").get() as { bytes: Uint8Array }).bytes)).toEqual(Buffer.from([2])); } finally { db.close(); }
  } finally { logger.close(); }
});
