import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  baseUrl: string;
  home: string;
  allowSend: boolean;
  allowDownload: boolean;
  allowTaskWrite: boolean;
  userId?: string;
  pollIntervalMs: number;
  pushChats: string[];
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const poll = Number(env.MIZITO_POLL_MS);
  return {
    baseUrl: env.MIZITO_BASE_URL ?? "https://app.mizito.ir",
    home: env.MIZITO_HOME ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "mizito"),
    allowSend: env.MIZITO_ALLOW_SEND === "1",
    allowDownload: env.MIZITO_ALLOW_DOWNLOAD === "1",
    allowTaskWrite: env.MIZITO_ALLOW_TASK_WRITE === "1",
    userId: env.MIZITO_USER_ID || undefined,
    pollIntervalMs: poll > 0 ? Math.max(1000, poll) : 10_000,
    pushChats: (env.MIZITO_PUSH_CHATS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  };
}
