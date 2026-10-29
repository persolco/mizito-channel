import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChatService } from "../src/core/chats";
import { MizitoClient } from "../src/core/client";
import { ConfigError, DownloadDisabled, NetworkError } from "../src/core/errors";
import { downloadVoice, MAX_AUDIO_BYTES } from "../src/core/download";

const scratch = tmpdir();
const roots: string[] = [];
const messageId = "0123456789abcdef01234567";

function tempRoot(): string {
  const path = mkdtempSync(join(scratch, "mizito-audio-test-"));
  roots.push(path);
  return path;
}

function stream(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function fakeChats(body: ReadableStream<Uint8Array>, size: number, durationSeconds = 4) {
  const calls: [string, string, string][] = [];
  const chats = {
    async fetchVoiceAudio(chat: string, id: string, _client: MizitoClient) {
      calls.push([chat, id, "client"]);
      return { body, size, durationSeconds };
    },
  } as unknown as ChatService;
  return { chats, calls };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("downloads a voice note to a private deterministic path", async () => {
  const home = tempRoot();
  const bytes = Buffer.from("fake-mp3-bytes");
  const { chats, calls } = fakeChats(stream(bytes), bytes.length);
  if (process.platform !== "linux") {
    await expect(downloadVoice(chats, {} as MizitoClient, "معین سلیمانی", messageId, home, true)).rejects.toThrow("Secure media downloads require Linux procfs");
    expect(existsSync(join(home, "downloads"))).toBe(false);
    expect(calls).toEqual([["معین سلیمانی", messageId, "client"]]);
    return;
  }
  const result = await downloadVoice(chats, {} as MizitoClient, "معین سلیمانی", messageId, home, true);

  expect(result).toEqual({
    path: join(home, "downloads", `${messageId}.mp3`),
    size: bytes.length,
    mime: "audio/mpeg",
    duration_seconds: 4,
    downloaded: true,
  });
  expect(readFileSync(result.path)).toEqual(bytes);
  expect(statSync(join(home, "downloads")).mode & 0o777).toBe(0o700);
  expect(statSync(result.path).mode & 0o777).toBe(0o600);
  expect(calls).toEqual([["معین سلیمانی", messageId, "client"]]);
});

test("download gate and message id validation run before source access", async () => {
  const home = tempRoot();
  let fetched = false;
  const chats = {
    async fetchVoiceAudio() {
      fetched = true;
      return { body: stream(new Uint8Array([1])), size: 1 };
    },
  } as unknown as ChatService;

  await expect(downloadVoice(chats, {} as MizitoClient, "Chat", messageId, home, false)).rejects.toBeInstanceOf(DownloadDisabled);
  await expect(downloadVoice(chats, {} as MizitoClient, "Chat", "../escape", home, true)).rejects.toBeInstanceOf(ConfigError);
  expect(fetched).toBe(false);
  expect(existsSync(join(home, "downloads"))).toBe(false);
});

test("rejects a downloads symlink without changing its target permissions", async () => {
  const home = tempRoot();
  const outside = join(tempRoot(), "outside");
  mkdirSync(outside);
  chmodSync(outside, 0o755);
  symlinkSync(outside, join(home, "downloads"));
  const bytes = new Uint8Array([1, 2, 3]);
  const { chats } = fakeChats(stream(bytes), bytes.length);

  await expect(downloadVoice(chats, {} as MizitoClient, "Chat", messageId, home, true)).rejects.toBeInstanceOf(ConfigError);
  expect(statSync(outside).mode & 0o777).toBe(0o755);
  expect(existsSync(join(outside, `${messageId}.mp3`))).toBe(false);
});

test("refuses to overwrite an existing destination", async () => {
  const home = tempRoot();
  const dir = join(home, "downloads");
  mkdirSync(dir);
  const path = join(dir, `${messageId}.mp3`);
  await Bun.write(path, "keep existing");
  const { chats } = fakeChats(stream(new Uint8Array([1])), 1);

  await expect(downloadVoice(chats, {} as MizitoClient, "Chat", messageId, home, true)).rejects.toBeInstanceOf(ConfigError);
  expect(readFileSync(path, "utf8")).toBe("keep existing");
});

test("rejects oversized streams and removes the partial file", async () => {
  const home = tempRoot();
  const dir = join(home, "downloads");
  const { chats } = fakeChats(stream(new Uint8Array(MAX_AUDIO_BYTES), new Uint8Array([1])), 0);

  await expect(downloadVoice(chats, {} as MizitoClient, "Chat", messageId, home, true)).rejects.toBeInstanceOf(ConfigError);
  expect(existsSync(join(dir, `${messageId}.mp3`))).toBe(false);
});

test("rejects empty and truncated audio and removes incomplete files", async () => {
  const emptyHome = tempRoot();
  const empty = fakeChats(stream(), 0);
  await expect(downloadVoice(empty.chats, {} as MizitoClient, "Chat", messageId, emptyHome, true)).rejects.toBeInstanceOf(NetworkError);
  expect(existsSync(join(emptyHome, "downloads", `${messageId}.mp3`))).toBe(false);

  const truncatedHome = tempRoot();
  const truncated = fakeChats(stream(new Uint8Array([1, 2])), 3);
  await expect(downloadVoice(truncated.chats, {} as MizitoClient, "Chat", messageId, truncatedHome, true)).rejects.toBeInstanceOf(NetworkError);
  expect(existsSync(join(truncatedHome, "downloads", `${messageId}.mp3`))).toBe(false);
});
