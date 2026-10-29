import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runChatLog } from "../src/cli/log";
import type { Chat, Message } from "../src/core/models";

const directories: string[] = [];
afterEach(async () => { for (const d of directories.splice(0)) await rm(d, { recursive: true, force: true }); });
const chat: Chat = { id: "a".repeat(24), name: "Synthetic team", isGroup: true, unread: 0, messagesCount: 1 };
const message: Message = { id: "b".repeat(24), chatId: chat.id, chatName: chat.name, sender: "Synthetic sender", from: "c".repeat(24), fromMe: false, index: 1, date: 1234, text: "synthetic text", mentions: [], edited: false, deleted: false, service: false };
async function fixture() {
  const dir = await mkdtemp(join(realpathSync(tmpdir()), "mizito-log-cli-")); directories.push(dir);
  const path = join(dir, "chat.sqlite"); const out: string[] = [], err: string[] = [];
  let reads = 0;
  const source = { resolveChat: async () => chat, history: async () => { reads++; return [message]; } };
  return { path, out, err, source, readCount: () => reads, deps: { source, allowDownload: false, out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
}

test("logger CLI writes a real bounded SQLite archive with counters-only output", async () => {
  const f = await fixture();
  expect(await runChatLog([chat.id, "--db", f.path, "--limit", "15", "--json"], f.deps)).toBe(0);
  const db = new Database(f.path, { readonly: true });
  try { expect(db.query("select text from messages").get()).toEqual({ text: "synthetic text" }); } finally { db.close(); }
  expect(JSON.parse(f.out[0]!).messages).toBe(1);
  expect(f.out.join("")).not.toContain(message.text);
  expect(f.err.join("")).toContain("plaintext");
  expect((await stat(f.path)).mode & 0o777).toBe(0o600);
});

test("media opt-in requires the download gate before collecting anything", async () => {
  const f = await fixture();
  expect(await runChatLog([chat.id, "--db", f.path, "--media"], f.deps)).toBe(4);
  expect(f.readCount()).toBe(0);
  expect(await stat(f.path).catch(() => null)).toBeNull();
});

test("follow rescans independently, stores actual media once, and stops on abort", async () => {
  const f = await fixture(); const ac = new AbortController(); let downloads = 0, sleeps = 0;
  const bytes = Buffer.from("synthetic binary payload");
  const mediaMessage = { ...message, attachment: { kind: "audio", size: bytes.length } };
  const deps = { ...f.deps, source: { ...f.source, history: async () => [mediaMessage] }, allowDownload: true, signal: ac.signal,
    fetchMedia: async () => { downloads++; return { bytes, mime: "audio/mpeg", kind: "audio" }; },
    sleep: async () => { if (++sleeps === 2) ac.abort(); },
  };
  expect(await runChatLog([chat.id, "--db", f.path, "--media", "--follow", "--interval", "1", "--json"], deps)).toBe(0);
  expect(f.out).toHaveLength(2); expect(downloads).toBe(1);
  const db = new Database(f.path, { readonly: true });
  try { const row = db.query("select bytes from media").get() as { bytes: Uint8Array }; expect(Buffer.from(row.bytes)).toEqual(bytes); expect(db.query("select count(*) as n from messages").get()).toEqual({ n: 1 }); } finally { db.close(); }
});

test("invalid args and pre-abort do not create an archive or contact source", async () => {
  for (const args of [[], [chat.id], [chat.id, "--db", "db", "--limit", "0"], [chat.id, "--db", "db", "--interval", "1"], [chat.id, "--db", "db", "--unknown"]]) {
    const f = await fixture(); expect(await runChatLog(args, f.deps)).toBe(64); expect(f.readCount()).toBe(0);
  }
  const f = await fixture(); const ac = new AbortController(); ac.abort();
  expect(await runChatLog([chat.id, "--db", f.path], { ...f.deps, signal: ac.signal })).toBe(0);
  expect(await stat(f.path).catch(() => null)).toBeNull(); expect(f.readCount()).toBe(0);
});
