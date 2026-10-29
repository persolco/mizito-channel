import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatLogger, ChatLogError } from "../src/core/chat-log";
import type { Chat, Message } from "../src/core/models";

const dirs: string[] = [];
const id = (n: number) => n.toString(16).padStart(24, "0");
const chat: Chat = { id: id(1), name: "Synthetic private chat", isGroup: false, unread: 2, messagesCount: 0 };
const msg = (n: number, extra: Partial<Message> = {}): Message => ({ sender: "Synthetic sender", id: id(n), chatId: chat.id, chatName: chat.name, index: n, from: id(2), fromMe: false, date: 123, text: "private synthetic text", mentions: [], edited: false, deleted: false, service: false, ...extra });
function setup(messages: Message[] = []) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "chat-log-test-")); dirs.push(root);
  const path = join(root, "private", "log.sqlite");
  const offsets: number[] = [];
  const source = { resolveChat: async (_ref: string, opts: { exact: true }) => { expect(opts.exact).toBe(true); return chat; }, history: async (_chat: Chat, offset: number) => { offsets.push(offset); return messages.slice(offset, offset + 15); } };
  return { path, source, offsets, root };
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("private opt-in chat logger", () => {
  test("stores text and actual BLOB; idempotent rerun and observed edits/deletions", async () => {
    const messages = [msg(10, { attachment: { kind: "photo", name: "synthetic.png" } }), msg(11)];
    const s = setup(messages); let calls = 0;
    const logger = new ChatLogger({ path: s.path, source: s.source, fetchMedia: async () => { calls++; return { bytes: Buffer.from([0, 1, 255, 12]), mime: "image/png", kind: "photo" }; } });
    await logger.run({ chats: chat.id, perChatLimit: 20, includeMedia: true });
    await logger.run({ chats: [chat.id], perChatLimit: 20, includeMedia: true });
    expect(calls).toBe(1);
    messages[0] = msg(10, { text: "edited synthetic", edited: true, deleted: true });
    messages.pop(); // Absence must NOT manufacture a remote deletion.
    await logger.run({ chats: chat.id, perChatLimit: 20 });
    logger.close(); const db = new Database(s.path);
    expect(db.query("select count(*) as n from messages").get()).toEqual({ n: 2 });
    expect(db.query("select text,edited,deleted from messages where message_id=?").get(id(10))).toEqual({ text: "edited synthetic", edited: 1, deleted: 1 });
    expect(db.query("select deleted from messages where message_id=?").get(id(11))).toEqual({ deleted: 0 });
    expect(db.query("select count(*) as n from media").get()).toEqual({ n: 0 }); // Observed removal/deletion drops obsolete media.
    db.close();
  });

  test("BLOB equality and generic retryable failures, disabled/unsupported/oversize/empty outcomes", async () => {
    const messages = [msg(10, { attachment: { kind: "photo" } }), msg(11, { attachment: { kind: "video" } })];
    const s = setup(messages); let calls = 0;
    const logger = new ChatLogger({ path: s.path, source: s.source, maxMediaBytes: 4, fetchMedia: async () => { calls++; if (calls === 1) throw Error("secret signed token URL"); return { bytes: Buffer.from([0, 255, 23]), mime: "image/png", kind: "photo" }; } });
    await logger.run({ chats: chat.id, perChatLimit: 20 }); expect(calls).toBe(0);
    await logger.run({ chats: chat.id, perChatLimit: 20, includeMedia: true });
    let db = new Database(s.path);
    expect(db.query("select status,error_code,bytes from media where message_id=?").get(id(10))).toEqual({ status: "failed", error_code: "MEDIA_FETCH_FAILED", bytes: null }); db.close();
    await logger.run({ chats: chat.id, perChatLimit: 20, includeMedia: true }); logger.close();
    db = new Database(s.path);
    const row = db.query("select status,bytes from media where message_id=?").get(id(10)) as any;
    expect(row.status).toBe("downloaded"); expect(Buffer.from(row.bytes)).toEqual(Buffer.from([0, 255, 23]));
    expect(db.query("select status from media where message_id=?").get(id(11))).toEqual({ status: "unsupported" }); db.close();
    expect(readFileSync(s.path).includes(Buffer.from("secret signed token URL"))).toBe(false);
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(5)]) {
      const t = setup([msg(12, { attachment: { kind: "voice" } })]);
      const l = new ChatLogger({ path: t.path, source: t.source, maxMediaBytes: 4, fetchMedia: async () => ({ bytes, mime: "audio/ogg", kind: "voice" }) });
      await l.run({ chats: chat.id, perChatLimit: 1, includeMedia: true }); l.close();
      const check = new Database(t.path); expect(check.query("select status,bytes from media").get()).toEqual({ status: "failed", bytes: null }); check.close();
    }
  });

  test("bounded pages and explicit conservative continuation checkpoints", async () => {
    const s = setup(Array.from({ length: 40 }, (_, i) => msg(i + 10)));
    const logger = new ChatLogger({ path: s.path, source: s.source });
    const summary = await logger.run({ chats: chat.id, perChatLimit: 17 });
    expect(s.offsets).toEqual([0, 15]); expect(summary.messages).toBe(17); expect(summary.truncatedChats).toBe(1);
    expect(logger.getCheckpoint(chat.id)).toMatchObject({ nextOffset: 17, hasMore: true, truncated: true });
    await logger.run({ chats: chat.id, perChatLimit: 30, offsets: { [chat.id]: 17 } });
    expect(logger.getCheckpoint(chat.id)).toMatchObject({ nextOffset: 40, hasMore: false, truncated: false });
    await logger.run({ chats: chat.id, perChatLimit: 15 });
    expect(logger.getCheckpoint(chat.id)).toMatchObject({ nextOffset: 15, hasMore: null, truncated: true }); logger.close();
  });

  test("transaction rolls back messages/media/checkpoint on SQLite failure", async () => {
    const s = setup([msg(10, { attachment: { kind: "photo" } })]);
    const logger = new ChatLogger({ path: s.path, source: s.source, fetchMedia: async () => ({ bytes: Buffer.from([1]), mime: "image/png", kind: "photo" }) });
    const db = new Database(s.path);
    db.exec("CREATE TRIGGER synthetic_failure BEFORE INSERT ON checkpoints BEGIN SELECT RAISE(ABORT, 'sensitive SQL detail'); END");
    await expect(logger.run({ chats: chat.id, perChatLimit: 1, includeMedia: true })).rejects.toThrow("STORAGE_FAILED");
    for (const table of ["chats", "messages", "media", "checkpoints"]) expect(db.query(`select count(*) as n from ${table}`).get()).toEqual({ n: 0 });
    db.close(); logger.close();
  });

  test("strict literal IDs and scope, exact resolver and generic source errors", async () => {
    const s = setup([msg(10)]); const logger = new ChatLogger({ path: s.path, source: s.source });
    for (const chats of [[], "", "*", ` ${chat.id}`, [chat.id, chat.id]]) await expect(logger.run({ chats, perChatLimit: 1 })).rejects.toBeInstanceOf(ChatLogError);
    await expect(logger.run({ chats: "not the exact name", perChatLimit: 1 })).rejects.toThrow("INVALID_SCOPE");
    await expect(logger.run({ chats: chat.id, perChatLimit: 0 })).rejects.toThrow("INVALID_OPTIONS");
    await expect(logger.run({ chats: chat.id, perChatLimit: 1, includeMedia: true })).rejects.toThrow("MEDIA_PROVIDER_REQUIRED");
    logger.close();
    const t = setup([msg(10, { id: "broken-id" })]); const invalid = new ChatLogger({ path: t.path, source: t.source });
    await expect(invalid.run({ chats: chat.id, perChatLimit: 2 })).rejects.toThrow("INVALID_MESSAGE"); expect(invalid.getCheckpoint(chat.id)).toBeNull(); invalid.close();
    const u = setup(); const failed = new ChatLogger({ path: u.path, source: { ...u.source, history: async () => { throw Error("secret source token"); } } });
    await expect(failed.run({ chats: chat.id, perChatLimit: 1 })).rejects.toThrow("SOURCE_FAILED"); failed.close();
  });

  test("compound identity, reopening, bounded busy timeout, schema version, and counters-only summary", async () => {
    const s = setup(); const second: Chat = { ...chat, id: id(99), name: "Another synthetic chat" };
    const source = { resolveChat: async (ref: string) => ref === chat.id ? chat : second,
      history: async (c: Chat) => [msg(10, { chatId: c.id })] };
    const logger = new ChatLogger({ path: s.path, source, busyTimeoutMs: 1 });
    const summary = await logger.run({ chats: [chat.id, second.id], perChatLimit: 3 });
    expect(summary).toEqual({ chats: 2, messages: 2, mediaDownloaded: 0, mediaFailed: 0, mediaUnsupported: 0, mediaDisabled: 0, truncatedChats: 0 });
    const db = new Database(s.path);
    expect(db.query("select count(*) as n from messages").get()).toEqual({ n: 2 });
    db.exec("BEGIN IMMEDIATE");
    await expect(logger.run({ chats: chat.id, perChatLimit: 1 })).rejects.toThrow("STORAGE_FAILED");
    db.exec("ROLLBACK"); logger.close();
    const reopened = new ChatLogger({ path: s.path, source });
    expect(reopened.getCheckpoint(chat.id)?.scanned).toBe(1); reopened.close();
    db.exec("PRAGMA user_version=99"); db.close();
    expect(() => new ChatLogger({ path: s.path, source })).toThrow("UNSUPPORTED_SCHEMA");
  });

  test("completed pages survive later read failure; no false checkpoint advancement", async () => {
    const s = setup();
    const source = { ...s.source, history: async (_c: Chat, offset: number) => {
      if (offset) throw Error("sensitive upstream error");
      return Array.from({ length: 15 }, (_, i) => msg(i + 10));
    } };
    const logger = new ChatLogger({ path: s.path, source });
    await expect(logger.run({ chats: chat.id, perChatLimit: 20 })).rejects.toThrow("SOURCE_FAILED");
    expect(logger.getCheckpoint(chat.id)).toMatchObject({ nextOffset: 15, scanned: 15, hasMore: true });
    logger.close();
  });

  test("raw extra fields are excluded, rollback journal is private, dangerous sidecars rejected", async () => {
    const synthetic = Object.assign(msg(10, { attachment: { kind: "photo" } }), { raw: { token: "DO-NOT-STORE-SIGNED-SOURCE" } });
    const s = setup([synthetic]); let checkedJournal = false;
    const logger = new ChatLogger({ path: s.path, source: s.source, fetchMedia: async (_c: Chat, m: Message) => {
      expect("raw" in m).toBe(false); return { bytes: Buffer.from([1]), mime: "image/png", kind: "photo" };
    } });
    // Synthetic in-process instrumentation only: observe permissions before actual commit.
    const internal = (logger as unknown as { db: Database }).db;
    const original = internal.transaction.bind(internal);
    internal.transaction = ((fn: () => unknown) => original(() => {
      const value = fn();
      expect(lstatSync(`${s.path}-journal`).mode & 0o777).toBe(0o600);
      checkedJournal = true; return value;
    })) as typeof internal.transaction;
    await logger.run({ chats: chat.id, perChatLimit: 2, includeMedia: true }); expect(checkedJournal).toBe(true);
    logger.close();
    expect(readFileSync(s.path).includes(Buffer.from("DO-NOT-STORE-SIGNED-SOURCE"))).toBe(false);
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      symlinkSync(s.path, s.path + suffix);
      expect(() => new ChatLogger({ path: s.path, source: s.source })).toThrow("UNSAFE_PATH"); rmSync(s.path + suffix);
    }
    chmodSync(s.path, 0o644);
    expect(() => new ChatLogger({ path: s.path, source: s.source })).toThrow("UNSAFE_PATH");
  });

  test("private permissions and rejection of symlink/hardlink/insecure paths", () => {
    const s = setup(); const logger = new ChatLogger({ path: s.path, source: s.source }); logger.close();
    expect(lstatSync(s.path).mode & 0o777).toBe(0o600); expect(lstatSync(join(s.root, "private")).mode & 0o777).toBe(0o700);
    const db = new Database(s.path); expect(db.query("pragma journal_mode").get()).toEqual({ journal_mode: "delete" }); db.close();
    const linked = join(s.root, "private", "linked.sqlite"); linkSync(s.path, linked);
    expect(() => new ChatLogger({ path: s.path, source: s.source })).toThrow("UNSAFE_PATH"); rmSync(linked);
    const sym = join(s.root, "private", "sym.sqlite"); symlinkSync(s.path, sym);
    expect(() => new ChatLogger({ path: sym, source: s.source })).toThrow("UNSAFE_PATH");
    const alias = join(s.root, "alias"); symlinkSync(join(s.root, "private"), alias);
    expect(() => new ChatLogger({ path: join(alias, "another.sqlite"), source: s.source })).toThrow("UNSAFE_PATH");
    chmodSync(join(s.root, "private"), 0o755);
    expect(() => new ChatLogger({ path: s.path, source: s.source })).toThrow("UNSAFE_PATH");
    const p = join(s.root, "public"); mkdirSync(p, { mode: 0o755 });
    expect(() => new ChatLogger({ path: join(p, "a.sqlite"), source: s.source })).toThrow("UNSAFE_PATH");
  });
});
