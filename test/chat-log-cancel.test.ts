import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runChatLog } from "../src/cli/log";
import { ChatLogger, ChatLogUnsupportedMedia } from "../src/core/chat-log";
import type { Chat, Message } from "../src/core/models";

const chat: Chat = { id: "a".repeat(24), name: "Synthetic cancellation", isGroup: true, unread: 0, messagesCount: 1 };
const message: Message = { id: "b".repeat(24), chatId: chat.id, chatName: chat.name, sender: "Synthetic", from: "c".repeat(24), index: 1, date: 1, fromMe: false, text: "synthetic", mentions: [], edited: false, deleted: false, service: false };

test("Ctrl-C during pending history returns immediately without later writes or source work", async () => {
  const root = await mkdtemp(join(realpathSync(tmpdir()), "mizito-log-cancel-")), path = join(root, "history.sqlite");
  const ac = new AbortController(); let reads = 0, downloads = 0, release!: (rows: Message[]) => void, started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  try {
    const run = runChatLog([chat.id, "--db", path, "--media", "--follow", "--limit", "30"], {
      source: { resolveChat: async () => chat, history: async (_chat, _offset, options) => { reads++; expect(options?.signal).toBe(ac.signal); started(); return new Promise<Message[]>(resolve => { release = resolve; }); } },
      allowDownload: true, fetchMedia: async () => { downloads++; return { bytes: Buffer.from([1]), mime: "audio/mpeg", kind: "audio" }; },
      signal: ac.signal, out: () => {}, err: () => {},
    });
    await ready; ac.abort();
    expect(await Promise.race([run, new Promise(resolve => setTimeout(() => resolve("hung"), 100))])).toBe(0);
    release(Array.from({ length: 15 }, (_, i) => ({ ...message, id: i.toString(16).padStart(24, "0"), index: i, attachment: { kind: "audio" } })));
    await Bun.sleep(5); expect(reads).toBe(1); expect(downloads).toBe(0);
    const db = new Database(path, { readonly: true });
    try { expect(db.query("SELECT count(*) AS n FROM messages").get()).toEqual({ n: 0 }); expect(db.query("SELECT count(*) AS n FROM checkpoints").get()).toEqual({ n: 0 }); } finally { db.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("typed unsupported media is not recorded as failed or fetched again unchanged", async () => {
  const root = await mkdtemp(join(realpathSync(tmpdir()), "mizito-log-unsupported-")), path = join(root, "history.sqlite"); let calls = 0;
  const logger = new ChatLogger({ path, source: { resolveChat: async () => chat, history: async () => [{ ...message, attachment: { kind: "audio" } }] }, fetchMedia: async () => { calls++; throw new ChatLogUnsupportedMedia(); } });
  try {
    const first = await logger.run({ chats: chat.id, perChatLimit: 15, includeMedia: true });
    expect(first.mediaUnsupported).toBe(1); expect(first.mediaFailed).toBe(0);
    await logger.run({ chats: chat.id, perChatLimit: 15, includeMedia: true }); expect(calls).toBe(1);
    const db = new Database(path, { readonly: true });
    try { expect(db.query("SELECT status,error_code,bytes FROM media").get()).toEqual({ status: "unsupported", error_code: null, bytes: null }); } finally { db.close(); }
  } finally { logger.close(); await rm(root, { recursive: true, force: true }); }
});
