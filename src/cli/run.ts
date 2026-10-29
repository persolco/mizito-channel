import { parseArgs } from "node:util";
import type { ChatService } from "../core/chats";
import type { TaskService, UpdateTask } from "../core/tasks";
import { type Batch, nextBatch } from "../core/watcher";
import { Backoff } from "../core/backoff";
import { ConfigError, DownloadDisabled, MizitoError, NetworkError, RateLimited, TaskWriteDisabled } from "../core/errors";
import { type HermesFetch, runHermesWatch } from "../core/hermes";
import { describeMessage, type Message } from "../core/models";

export interface CliDeps {
  tasks?: Pick<TaskService, "listProjects" | "listTasks" | "getTask" | "createTask" | "updateTask" | "deleteTask" | "setTaskCompleted" | "commentOnTask">;
  allowTaskWrite?: boolean;
  chats: Pick<ChatService, "listChats" | "resolveChat" | "readMessages" | "search">;
  watcher: () => { poll(): Promise<Message[]>; pollBatch?(): Promise<Batch> };
  send: (chatId: string, text: string) => Promise<void>;
  sendFiles: (chatId: string, paths: string[], text?: string) => Promise<void>;
  allowDownload?: boolean;
  downloadAudio?: (chat: string, messageId: string) => Promise<unknown>;
  downloadImage?: (chat: string, messageId: string) => Promise<unknown>;
  log?: (args: string[], io: CliIo) => Promise<number>;
  login: () => Promise<void>;
  startMcp: () => Promise<void>;
  pollIntervalMs: number;
  sleep?: (ms: number) => Promise<void>;
  hermesWebhookUrl?: string;
  hermesWebhookSecret?: string;
  hermesFetch?: HermesFetch;
}

export interface CliIo {
  out(s: string): void;
  err(s: string): void;
  signal?: AbortSignal;
}

class Usage extends Error {}

const EXIT: Record<string, number> = { AUTH: 2, SEND_DISABLED: 3, DOWNLOAD_DISABLED: 4, TASK_WRITE_DISABLED: 5 };

const fmt = (m: Message) =>
  `[${new Date(m.date).toISOString()}] ${m.chatName} / ${m.sender}: ${describeMessage(m)}`;

export async function runCli(argv: string[], deps: CliDeps, io: CliIo): Promise<number> {
  try {
    if (argv[0] === "log") {
      if (!deps.log) throw new ConfigError("Chat logger is unavailable in this build");
      return await deps.log(argv.slice(1), io);
    }
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: "boolean" }, limit: { type: "string" }, offset: { type: "string" },
        project: { type: "string" }, text: { type: "string" }, title: { type: "string" },
        notes: { type: "string" }, deadline: { type: "string" },
        assignee: { type: "string", multiple: true }, moveTo: { type: "string" },
      },
    });
    const [cmd, ...rest] = positionals;
    const json = values.json === true;
    const need = (n: number, usage: string) => {
      if (rest.length < n) throw new Usage(`usage: mizito ${usage}`);
    };
    const printMessages = (msgs: Message[]) =>
      json ? io.out(JSON.stringify(msgs, null, 2)) : [...msgs].reverse().forEach((m) => io.out(fmt(m)));
    const taskWrite = () => {
      if (!deps.allowTaskWrite) throw new TaskWriteDisabled();
      if (!deps.tasks) throw new ConfigError("Task integration is unavailable in this build");
      return deps.tasks;
    };

    switch (cmd) {
      case "projects": {
        if (!deps.tasks) throw new ConfigError("Task integration is unavailable in this build");
        const projects = await deps.tasks.listProjects();
        if (json) io.out(JSON.stringify(projects, null, 2));
        else for (const project of projects) io.out(`${project.id}\t${project.title}`);
        return 0;
      }
      case "tasks": {
        if (!deps.tasks) throw new ConfigError("Task integration is unavailable in this build");
        if (rest.length > 1 || (rest[0] && !["mine", "following", "project", "done"].includes(rest[0]))) {
          throw new Usage("usage: mizito tasks [mine|following|project|done] [--project ID] [--offset N] [--json]");
        }
        const scope = (rest[0] ?? "mine") as "mine" | "following" | "project" | "done";
        const rawOffset = values.offset;
        const offset = rawOffset === undefined ? 0 : Number(rawOffset);
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Usage("--offset must be a non-negative whole number");
        const tasks = await deps.tasks.listTasks(scope, offset, values.project);
        if (json) io.out(JSON.stringify(tasks, null, 2));
        else for (const task of tasks) io.out(`${task.id}\t${task.completed ? "done" : "open"}\t${task.title}`);
        return 0;
      }
      case "task-get": {
        need(1, "task-get <task-id> [--project ID] [--json]");
        if (!deps.tasks) throw new ConfigError("Task integration is unavailable in this build");
        const task = await deps.tasks.getTask(rest[0]!, values.project);
        io.out(json ? JSON.stringify(task, null, 2) : `${task.id}\t${task.title}\n${task.notes}`);
        return 0;
      }
      case "task-create": {
        need(2, "task-create <project-id> <title> [--notes TEXT] [--assignee ID] [--deadline ISO]");
        const task = await taskWrite().createTask({ projectId: rest[0]!, title: rest.slice(1).join(" "), notes: values.notes, assigneeIds: values.assignee, deadline: values.deadline });
        io.out(json ? JSON.stringify(task, null, 2) : `${task.id}\t${task.title}`);
        return 0;
      }
      case "task-update": {
        need(1, "task-update <task-id> [--title TEXT] [--notes TEXT] [--deadline ISO|empty] [--assignee ID] [--project ID] [--moveTo ID]");
        const changes: UpdateTask = {};
        if (values.title !== undefined) changes.title = values.title;
        if (values.notes !== undefined) changes.notes = values.notes;
        if (values.deadline !== undefined) changes.deadline = values.deadline || null;
        if (values.assignee !== undefined) changes.assigneeIds = values.assignee;
        if (values.moveTo !== undefined) changes.projectId = values.moveTo;
        const task = await taskWrite().updateTask(rest[0]!, changes, values.project);
        io.out(json ? JSON.stringify(task, null, 2) : `${task.id}\t${task.title}`);
        return 0;
      }
      case "task-delete": {
        need(1, "task-delete <task-id> [--project ID]");
        const result = await taskWrite().deleteTask(rest[0]!, values.project);
        io.out(json ? JSON.stringify(result, null, 2) : `Moved ${result.taskId} to trash`);
        return 0;
      }
      case "task-complete":
      case "task-reopen": {
        need(1, `${cmd} <task-id> [--project ID]`);
        const task = await taskWrite().setTaskCompleted(rest[0]!, cmd === "task-complete", values.project);
        io.out(json ? JSON.stringify(task, null, 2) : `${task.id}\t${task.completed ? "done" : "open"}\t${task.title}`);
        return 0;
      }
      case "task-comment": {
        need(2, "task-comment <task-id> <text> [--project ID]");
        const result = await taskWrite().commentOnTask(rest[0]!, rest.slice(1).join(" "), values.project);
        io.out(json ? JSON.stringify(result, null, 2) : `Commented on ${result.taskId}`);
        return 0;
      }
      case "chats": {
        const chats = await deps.chats.listChats();
        if (json) io.out(JSON.stringify(chats, null, 2));
        else for (const c of chats) io.out(`${c.id}\t${c.isGroup ? "group" : "dm"}\t${c.unread}\t${c.name}`);
        return 0;
      }
      case "read": {
        need(1, "read <chat> [--limit N] [--json]");
        const limit = values.limit !== undefined ? Number(values.limit) : undefined;
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
          throw new Usage("--limit must be a positive whole number");
        }
        printMessages(await deps.chats.readMessages(rest[0]!, limit ? { limit } : {}));
        return 0;
      }
      case "search": {
        need(2, "search <chat> <query> [--json]");
        printMessages(await deps.chats.search(rest[0]!, rest.slice(1).join(" ")));
        return 0;
      }
      case "watch": {
        const watcher = deps.watcher();
        const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
        const backoff = new Backoff({ baseMs: deps.pollIntervalMs });
        while (!io.signal?.aborted) {
          let delay: number;
          try {
            const batch = await nextBatch(watcher);
            for (const m of batch.messages) io.out(json ? JSON.stringify(m) : fmt(m));
            await batch.commit();
            delay = backoff.next(batch.messages.length > 0 ? "messages" : "idle");
          } catch (e) {
            if (!(e instanceof RateLimited || e instanceof NetworkError)) throw e;
            io.err(`${e.message} (retrying)`);
            delay = backoff.next(e instanceof RateLimited ? "rateLimited" : "error");
          }
          if (io.signal?.aborted) break;
          await sleep(delay);
        }
        return 0;
      }
      case "hermes-watch": {
        const missing = [
          !deps.hermesWebhookUrl ? "HERMES_WEBHOOK_URL" : undefined,
          !deps.hermesWebhookSecret ? "HERMES_WEBHOOK_SECRET" : undefined,
        ].filter((v): v is string => v !== undefined);
        if (missing.length > 0) {
          throw new ConfigError(`Missing required Hermes webhook configuration: ${missing.join(", ")}`);
        }
        await runHermesWatch(deps.watcher(), {
          url: deps.hermesWebhookUrl!,
          secret: deps.hermesWebhookSecret!,
          pollIntervalMs: deps.pollIntervalMs,
          fetch: deps.hermesFetch,
          sleep: deps.sleep,
          signal: io.signal,
          onRetry: (message) => io.err(message),
        });
        return 0;
      }
      case "send": {
        need(2, "send <chat> <text>");
        const chat = await deps.chats.resolveChat(rest[0]!, { exact: true });
        await deps.send(chat.id, rest.slice(1).join(" "));
        return 0;
      }
      case "send-files": {
        need(2, "send-files <chat> <path...> [--text <caption>]");
        const chat = await deps.chats.resolveChat(rest[0]!, { exact: true });
        const caption = values.text;
        await deps.sendFiles(chat.id, rest.slice(1), caption);
        return 0;
      }
      case "download-audio":
      case "download-image": {
        const download = cmd === "download-image" ? deps.downloadImage : deps.downloadAudio;
        if (!deps.allowDownload || !download) throw new DownloadDisabled();
        if (rest.length !== 2) throw new Usage(`usage: mizito ${cmd} <exact-chat> <24-lowerhex-message-id> [--json]`);
        if (!/^[a-f0-9]{24}$/.test(rest[1]!)) {
          throw new Usage("message id must be exactly 24 hexadecimal characters");
        }
        const result = await download(rest[0]!, rest[1]!);
        io.out(json ? JSON.stringify(result, null, 2) : String((result as { path: string }).path));
        return 0;
      }
      case "login":
        await deps.login();
        return 0;
      case "mcp":
        await deps.startMcp();
        return 0;
      default:
        throw new Usage("usage: mizito <chats|projects|tasks|task-get|task-create|task-update|task-delete|task-complete|task-reopen|task-comment|read|search|watch|hermes-watch|send|send-files|download-audio|download-image|log|login|mcp> ...");
    }
  } catch (e) {
    if (e instanceof Usage) {
      io.err(e.message);
      return 64;
    }
    io.err(e instanceof Error ? e.message : String(e));
    return e instanceof MizitoError ? (EXIT[e.code] ?? 1) : 1;
  }
}
