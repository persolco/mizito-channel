#!/usr/bin/env bun
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { login as doLogin } from "../core/auth";
import { ChatService } from "../core/chats";
import { TaskService } from "../core/tasks";
import { MizitoClient } from "../core/client";
import { loadConfig } from "../core/config";
import { PidLock } from "../core/lock";
import { ConfigError } from "../core/errors";
import { CursorStore } from "../core/cursor";
import { sendFiles, sendMessage } from "../core/send";
import { downloadImage, downloadVoice } from "../core/download";
import { createChatLogMediaProvider } from "../core/log-media";
import { runChatLog } from "./log";
import { FileCredentialStore, FileNameCache, FileTokenStore, LoginThrottle, loadCredentials } from "../core/stores";
import { Watcher } from "../core/watcher";
import { type McpDeps, createMcpServer, startPush } from "../mcp/server";
import { runCli } from "./run";

async function readLine(prompt: string, hidden: boolean): Promise<string> {
  process.stderr.write(prompt);
  const stdin = process.stdin;
  if (hidden && stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  let line = "";
  return new Promise((resolve) => {
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          if (hidden && stdin.isTTY) stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stderr.write("\n");
          return resolve(line);
        }
        if (ch === "\u0003") {
          if (hidden && stdin.isTTY) stdin.setRawMode(false);
          process.exit(130);
        }
        if (ch === "\u007f") line = line.slice(0, -1);
        else line += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function main(): Promise<number> {
  const config = loadConfig(process.env);
  const credStore = new FileCredentialStore(join(config.home, "credentials.json"));
  const tokenStore = new FileTokenStore(join(config.home, "session.json"));

  // A cached token works without credentials; credentials are only needed if a
  // login happens. Missing credentials surface as the original AuthError then.
  const throttle = new LoginThrottle(join(config.home, "logins.json"));
  let credError: unknown;
  const credentials = await loadCredentials(process.env, credStore).catch((e) => {
    credError = e;
    return { username: "", password: "" };
  });
  const client = new MizitoClient({
    baseUrl: config.baseUrl,
    credentials,
    token: await tokenStore.get(),
    onToken: (t) => tokenStore.set(t),
    beforeLogin: () => throttle.check(),
    fetch: (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (credError && String(url).endsWith("/capi/session/create")) throw credError;
      return fetch(url, init);
    }) as typeof fetch,
  });

  const names = await FileNameCache.open(join(config.home, "names.json"));
  const chats = new ChatService(client, { userId: config.userId, names });
  const tasks = new TaskService(client, config.allowTaskWrite);
  const lock = new PidLock(join(config.home, "watcher.lock"));
  process.on("exit", () => lock.release());
  const watcher = new Watcher({ chats, cursors: await CursorStore.open(join(config.home, "cursors.json")), lock });
  const send = (chatId: string, text: string) =>
    sendMessage(client, chatId, text, { allowSend: config.allowSend, userId: config.userId });
  const sendLocalFiles = (chatId: string, paths: string[], text?: string) =>
    sendFiles(client, chatId, paths, text, { allowSend: config.allowSend, userId: config.userId });

  const mcpDeps: McpDeps = {
    chats,
    tasks,
    allowTaskWrite: config.allowTaskWrite,
    watcher,
    send,
    sendFiles: sendLocalFiles,
    allowSend: config.allowSend,
    allowDownload: config.allowDownload,
    downloadAudio: (chat, id) => downloadVoice(chats, client, chat, id, config.home, config.allowDownload),
    downloadImage: (chat, id) => downloadImage(chats, client, chat, id, config.home, config.allowDownload),
    push: process.env.MIZITO_PUSH === "1",
    pollIntervalMs: config.pollIntervalMs,
  };

  const ac = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => ac.abort());

  return runCli(process.argv.slice(2), {
    chats,
    tasks,
    allowTaskWrite: config.allowTaskWrite,
    log: (args, io) => runChatLog(args, {
      source: chats, allowDownload: config.allowDownload,
      fetchMedia: createChatLogMediaProvider(chats, client, config.allowDownload),
      signal: io.signal, out: io.out, err: io.err,
    }),
    watcher: () => watcher,
    send,
    sendFiles: sendLocalFiles,
    allowDownload: config.allowDownload,
    downloadAudio: (chat, id) => downloadVoice(chats, client, chat, id, config.home, config.allowDownload),
    downloadImage: (chat, id) => downloadImage(chats, client, chat, id, config.home, config.allowDownload),
    pollIntervalMs: config.pollIntervalMs,
    hermesWebhookUrl: process.env.HERMES_WEBHOOK_URL,
    hermesWebhookSecret: process.env.HERMES_WEBHOOK_SECRET,
    login: async () => {
      const username = process.env.MIZITO_USERNAME ?? (await readLine("Mizito username: ", false));
      const password = process.env.MIZITO_PASSWORD ?? (await readLine("Mizito password: ", true));
      await throttle.check();
      const token = await doLogin(fetch, config.baseUrl, { username, password });
      await credStore.set({ username, password });
      await tokenStore.set(token);
      console.error(`Logged in. Credentials saved to ${config.home} (mode 0600).`);
    },
    startMcp: async () => {
      if (mcpDeps.push) {
        if (config.pushChats.length === 0) {
          throw new ConfigError("MIZITO_PUSH=1 requires MIZITO_PUSH_CHATS (comma-separated chat ids or exact names to push)");
        }
        mcpDeps.pushChatIds = new Set((await Promise.all(config.pushChats.map((c) => chats.resolveChat(c, { exact: true })))).map((c) => c.id));
      }
      const server = createMcpServer(mcpDeps);
      server.server.onclose = () => ac.abort(); // client disconnected: shut down cleanly so exit handlers run
      await server.connect(new StdioServerTransport());
      if (mcpDeps.push) await startPush(server, mcpDeps, ac.signal);
      await new Promise<void>((r) => ac.signal.addEventListener("abort", () => r()));
    },
  }, { out: (s) => console.log(s), err: (s) => console.error(s), signal: ac.signal });
}

process.exit(await main());
