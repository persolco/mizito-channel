import { expect, test } from "bun:test";
import type { Chat, Message } from "../src/core/models";
import { ChatService } from "../src/core/chats";
import { MizitoClient } from "../src/core/client";
import { createChatLogMediaProvider } from "../src/core/log-media";
import { ChatLogger } from "../src/core/chat-log";
import { runChatLog } from "../src/cli/log";
import { runCli, type CliDeps } from "../src/cli/run";
import { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const chatId = "a".repeat(24), photoId = "b".repeat(24), audioId = "c".repeat(24);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4ZkAAAAASUVORK5CYII=", "base64");
const audio = Buffer.from("synthetic voice bytes");
function fixtures(nonVoice = false) {
  let downloads = 0;
  const raw = [
    { _id: photoId, _: "message", from: "d".repeat(24), date: 1, msg_index: 2, message: "Synthetic image", media: { _: "messageMediaPhoto", photo: { _id: "f".repeat(24), name: "test.png", photo_large: { content: "synthetic-photo", w: 1, h: 1, size: png.length } } } },
    { _id: audioId, _: "message", from: "d".repeat(24), date: 1, msg_index: 1, message: "", media: { _: "messageMediaAudio", audio: { content: "synthetic-audio", duration: 1, size: audio.length, is_voice: !nonVoice } } },
  ];
  const client = new MizitoClient({ credentials: { username: "", password: "" }, token: "synthetic-session", fetch: (async (url: any) => {
    downloads++; const image = String(url).endsWith("synthetic-photo");
    return new Response(new Uint8Array(image ? png : audio), { headers: { "content-type": image ? "image/png" : "audio/mpeg" } });
  }) as typeof fetch });
  const chats = new ChatService({ post: async (path, body: any) => {
    if (path.endsWith("getDialogs")) return { dialogs: [{ _id: chatId, title: "Synthetic team", is_group: true }] };
    if (path.endsWith("getHistory")) return raw.slice(body.offset, body.offset + 15);
    if (path.endsWith("userId")) return { uid: "e".repeat(24) };
    if (path.endsWith("getUsers")) return { users: [] };
    throw new Error("Unexpected synthetic source call");
  } });
  return { chats, client, downloads: () => downloads };
}

test("complete CLI dispatch to native media adapter stores actual image and voice BLOBs", async () => {
  const f = fixtures(), root = await mkdtemp(join(realpathSync(tmpdir()), "mizito-log-media-"));
  const path = join(root, "archive.sqlite"), output: string[] = [];
  const deps: CliDeps = {
    chats: f.chats, watcher: () => ({ poll: async () => [] }), send: async () => {}, sendFiles: async () => {}, login: async () => {}, startMcp: async () => {}, pollIntervalMs: 1000,
    log: (args, io) => runChatLog(args, { source: f.chats, allowDownload: true, fetchMedia: createChatLogMediaProvider(f.chats, f.client, true), out: io.out, err: io.err }),
  };
  try {
    const code = await runCli(["log", chatId, "--db", path, "--media", "--limit", "15", "--json"], deps, { out: s => output.push(s), err: () => {} });
    expect(code).toBe(0); expect(JSON.parse(output[0]!).mediaDownloaded).toBe(2); expect(f.downloads()).toBe(2);
    const db = new Database(path, { readonly: true });
    try {
      const rows = db.query("select message_id,mime,bytes from media order by message_id").all() as { message_id: string; mime: string; bytes: Uint8Array }[];
      expect(rows).toHaveLength(2); expect(Buffer.from(rows[0]!.bytes)).toEqual(png); expect(Buffer.from(rows[1]!.bytes)).toEqual(audio);
      expect(JSON.stringify(db.query("select normalized_json from messages").all())).not.toContain("synthetic-session");
    } finally { db.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("logger adapter honors disabled gate, service/deletion scope, and supplied byte budget", async () => {
  const f = fixtures();
  const chat: Chat = { id: chatId, name: "Synthetic team", isGroup: true, unread: 0, messagesCount: 2 };
  const message = (await f.chats.history(chat, 0))[0]!;
  await expect(createChatLogMediaProvider(f.chats, f.client, false)(chat, message, { maxBytes: 1024 })).rejects.toThrow("disabled");
  const provider = createChatLogMediaProvider(f.chats, f.client, true);
  for (const bad of [{ ...message, deleted: true }, { ...message, service: true }, { ...message, chatId: "f".repeat(24) }]) {
    await expect(provider(chat, bad, { maxBytes: 1024 })).rejects.toThrow("unavailable");
  }
  expect(f.downloads()).toBe(0);
  await expect(provider(chat, message, { maxBytes: 1 })).rejects.toThrow();
});

test("native non-voice audio is classified unsupported, not retried as a failed download", async () => {
  const f = fixtures(true), root = await mkdtemp(join(realpathSync(tmpdir()), "mizito-log-nonvoice-"));
  const logger = new ChatLogger({ path: join(root, "history.sqlite"), source: f.chats, fetchMedia: createChatLogMediaProvider(f.chats, f.client, true) });
  try {
    const first = await logger.run({ chats: chatId, perChatLimit: 15, includeMedia: true });
    expect(first.mediaUnsupported).toBe(1); expect(first.mediaFailed).toBe(0); expect(first.mediaDownloaded).toBe(1);
    const second = await logger.run({ chats: chatId, perChatLimit: 15, includeMedia: true });
    expect(second.mediaFailed).toBe(0); expect(second.mediaDownloaded).toBe(0); expect(f.downloads()).toBe(1);
  } finally { logger.close(); await rm(root, { recursive: true, force: true }); }
});

test("logger cancellation reaches the native CDN request and prevents partial page persistence", async () => {
  const f = fixtures(), root = await mkdtemp(join(realpathSync(tmpdir()), "mizito-log-cdn-abort-"));
  const ac = new AbortController(); let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  let networkSignal: AbortSignal | undefined;
  const client = new MizitoClient({ credentials: { username: "", password: "" }, token: "synthetic-session", fetch: (async (_url: any, init?: RequestInit) => {
    networkSignal = init?.signal ?? undefined; started(); return new Promise<Response>(() => {});
  }) as typeof fetch });
  const path = join(root, "history.sqlite");
  const logger = new ChatLogger({ path, source: f.chats, fetchMedia: createChatLogMediaProvider(f.chats, client, true) });
  try {
    const pending = logger.run({ chats: chatId, perChatLimit: 15, includeMedia: true, signal: ac.signal });
    const result = pending.catch(error => error.code);
    await ready; ac.abort(); expect(await result).toBe("CANCELLED"); expect(networkSignal?.aborted).toBe(true);
    const db = new Database(path, { readonly: true });
    try { expect(db.query("SELECT count(*) AS n FROM messages").get()).toEqual({ n: 0 }); } finally { db.close(); }
  } finally { logger.close(); await rm(root, { recursive: true, force: true }); }
});
