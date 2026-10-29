import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, startPush, type McpDeps } from "../src/mcp/server";
import { AmbiguousChat, RateLimited } from "../src/core/errors";
import type { Chat } from "../src/core/models";
import { msg } from "./helpers";

const chat: Chat = { id: "c1", name: "Ata", isGroup: false, unread: 1, messagesCount: 3 };

function deps(over: Partial<McpDeps> = {}): McpDeps & {
  sent: [string, string][];
  filesSent: [string, string[], string | undefined][];
} {
  const sent: [string, string][] = [];
  const filesSent: [string, string[], string | undefined][] = [];
  return {
    chats: {
      listChats: async () => [chat],
      resolveChat: async () => chat,
      readMessages: async () => [msg(2, { text: "two" }), msg(1, { text: "one" })],
      search: async () => [msg(1, { text: "one" })],
    },
    watcher: { poll: async () => [msg(9, { text: "fresh" })] },
    send: async (id, text) => { sent.push([id, text]); },
    sendFiles: async (id, paths, text) => { filesSent.push([id, paths, text]); },
    allowSend: false,
    allowDownload: false,
    downloadAudio: async () => { throw new Error("unexpected download"); },
    push: false,
    pollIntervalMs: 1,
    sent,
    filesSent,
    ...over,
  };
}

async function connect(d: McpDeps) {
  const server = createMcpServer(d);
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { server, client };
}

const textOf = (r: any) => r.content[0].text as string;

test("registers read tools and hides send by default", async () => {
  const { client } = await connect(deps());
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  expect(names).toEqual(["list_chats", "read_messages", "search_chat", "wait_for_messages"]);
});

test("download_audio is hidden unless enabled and requires explicit exact inputs", async () => {
  const called: string[] = [];
  const d = deps({
    allowDownload: true,
    downloadAudio: async (name, id) => {
      called.push(name, id);
      return { downloaded: true, path: `/private/${id}.mp3`, size: 3, mime: "audio/mpeg" };
    },
  });
  const { client } = await connect(d);
  const tool = (await client.listTools()).tools.find((item) => item.name === "download_audio");
  expect(tool).toBeDefined();
  expect(tool!.description).toContain("explicitly requests it");
  expect(tool!.annotations?.readOnlyHint).toBe(false);
  expect(tool!.annotations?.destructiveHint).toBe(false);
  const id = "0123456789abcdef01234567";
  const result: any = await client.callTool({ name: "download_audio", arguments: { chat: "Ata", message_id: id } });
  expect(result.isError).toBeFalsy();
  expect(JSON.parse(textOf(result))).toEqual({ downloaded: true, path: `/private/${id}.mp3`, size: 3, mime: "audio/mpeg" });
  expect(called).toEqual(["Ata", id]);
});

test("download_audio tool validates message ids", async () => {
  const { client } = await connect(deps({ allowDownload: true, downloadAudio: async () => ({ ok: true }) }));
  const result: any = await client.callTool({ name: "download_audio", arguments: { chat: "Ata", message_id: "not-an-id" } });
  expect(result.isError).toBe(true);
});

test("send_message appears only when allowed, annotated as destructive", async () => {
  const { client } = await connect(deps({ allowSend: true }));
  const tools = (await client.listTools()).tools;
  const send = tools.find((t) => t.name === "send_message");
  expect(send).toBeDefined();
  expect(send!.annotations?.destructiveHint).toBe(true);
  expect(send!.annotations?.readOnlyHint).toBe(false);
  const files = tools.find((t) => t.name === "send_files");
  expect(files).toBeDefined();
  expect(files!.annotations?.destructiveHint).toBe(true);
  expect(files!.description).toContain("explicit approval");
});

test("read tools are annotated read-only", async () => {
  const { client } = await connect(deps());
  const tools = (await client.listTools()).tools;
  for (const n of ["list_chats", "read_messages", "search_chat", "wait_for_messages"]) {
    expect(tools.find((t) => t.name === n)!.annotations?.readOnlyHint).toBe(true);
  }
});

test("list_chats returns JSON", async () => {
  const { client } = await connect(deps());
  const r = await client.callTool({ name: "list_chats", arguments: {} });
  expect(JSON.parse(textOf(r))[0].id).toBe("c1");
});

test("list_tasks is read-only and forwards scope, offset, and project id", async () => {
  let seen: unknown;
  const { client } = await connect(deps({ tasks: { listProjects: async () => [], listTasks: async (...args) => {
    seen = args;
    return [{ id: "t1", title: "Review", assigneeIds: [], completed: false }];
  }, getTask: async () => { throw new Error("unexpected"); }, createTask: async () => { throw new Error("unexpected"); },
  updateTask: async () => { throw new Error("unexpected"); }, deleteTask: async () => { throw new Error("unexpected"); },
  setTaskCompleted: async () => { throw new Error("unexpected"); },
  commentOnTask: async () => { throw new Error("unexpected"); } } }));
  const tool = (await client.listTools()).tools.find((t) => t.name === "list_tasks");
  expect(tool?.annotations?.readOnlyHint).toBe(true);
  const result = await client.callTool({ name: "list_tasks", arguments: { scope: "project", offset: 15, project_id: "p1" } });
  expect(seen).toEqual(["project", 15, "p1"]);
  expect(JSON.parse(textOf(result))[0].id).toBe("t1");
});

test("task write tools are gated, annotated, and forward exact arguments", async () => {
  const calls: unknown[] = [];
  const tasks = {
    listProjects: async () => [],
    listTasks: async () => [],
    getTask: async (id: string, project?: string) => { calls.push(["get", id, project]); return { id, title: "Task", notes: "", assigneeIds: [], completed: false, checklist: [], labelIds: [], deleted: false }; },
    createTask: async (input: unknown) => { calls.push(["create", input]); return { id: "t1", title: "Task", assigneeIds: [], completed: false }; },
    updateTask: async (id: string, changes: unknown, project?: string) => { calls.push(["update", id, changes, project]); return { id, title: "Task", notes: "", assigneeIds: [], completed: false, checklist: [], labelIds: [], deleted: false }; },
    deleteTask: async (id: string, project?: string) => { calls.push(["delete", id, project]); return { deleted: true as const, taskId: id }; },
    setTaskCompleted: async (id: string, completed: boolean, project?: string) => { calls.push(["complete", id, completed, project]); return { id, title: "Task", notes: "", assigneeIds: [], completed, checklist: [], labelIds: [], deleted: false }; },
    commentOnTask: async (id: string, value: string, project?: string) => { calls.push(["comment", id, value, project]); return { commented: true as const, taskId: id }; },
  } as McpDeps["tasks"];
  const off = await connect(deps({ tasks }));
  expect((await off.client.listTools()).tools.map((t) => t.name)).toContain("get_task");
  expect((await off.client.listTools()).tools.map((t) => t.name)).not.toContain("create_task");
  const { client } = await connect(deps({ tasks, allowTaskWrite: true }));
  const tools = (await client.listTools()).tools;
  for (const name of ["create_task", "update_task", "delete_task", "set_task_completed", "comment_on_task"]) {
    expect(tools.find((t) => t.name === name)?.annotations?.destructiveHint).toBe(true);
  }
  await client.callTool({ name: "create_task", arguments: { title: "New", project_id: "p1" } });
  await client.callTool({ name: "update_task", arguments: { task_id: "t1", title: "Changed", deadline: null, project_id: "p1" } });
  await client.callTool({ name: "delete_task", arguments: { task_id: "t1", project_id: "p1" } });
  await client.callTool({ name: "set_task_completed", arguments: { task_id: "t1", completed: true, project_id: "p1" } });
  await client.callTool({ name: "comment_on_task", arguments: { task_id: "t1", text: "Hello", project_id: "p1" } });
  expect(calls).toEqual([
    ["create", { title: "New", projectId: "p1", notes: undefined, assigneeIds: undefined, deadline: undefined }],
    ["update", "t1", { title: "Changed", deadline: null }, "p1"],
    ["delete", "t1", "p1"],
    ["complete", "t1", true, "p1"],
    ["comment", "t1", "Hello", "p1"],
  ]);
});

test("read_messages returns messages and passes the limit", async () => {
  let seen: unknown;
  const d = deps();
  d.chats.readMessages = async (_c: string, o: any) => { seen = o; return [msg(1, { text: "one" })]; };
  const { client } = await connect(d);
  const r = await client.callTool({ name: "read_messages", arguments: { chat: "Ata", limit: 5 } });
  expect(JSON.parse(textOf(r))[0].text).toBe("one");
  expect(seen).toEqual({ limit: 5 });
});

test("search_chat returns matches", async () => {
  const { client } = await connect(deps());
  const r = await client.callTool({ name: "search_chat", arguments: { chat: "Ata", query: "one" } });
  expect(JSON.parse(textOf(r))).toHaveLength(1);
});

test("wait_for_messages returns new messages", async () => {
  const { client } = await connect(deps());
  const r = await client.callTool({ name: "wait_for_messages", arguments: { timeout_seconds: 1 } });
  expect(JSON.parse(textOf(r))[0].text).toBe("fresh");
});

test("wait_for_messages returns an empty list on timeout", async () => {
  const { client } = await connect(deps({ watcher: { poll: async () => [] } }));
  const r = await client.callTool({ name: "wait_for_messages", arguments: { timeout_seconds: 1 } });
  expect(JSON.parse(textOf(r))).toEqual([]);
});

test("domain errors become isError results with the message", async () => {
  const d = deps();
  d.chats.readMessages = async () => { throw new AmbiguousChat("a", ["A1", "A2"]); };
  const { client } = await connect(d);
  const r: any = await client.callTool({ name: "read_messages", arguments: { chat: "a" } });
  expect(r.isError).toBe(true);
  expect(textOf(r)).toContain("A1");
});

test("send_message sends when allowed", async () => {
  const d = deps({ allowSend: true });
  const { client } = await connect(d);
  const r: any = await client.callTool({ name: "send_message", arguments: { chat: "Ata", text: "hi" } });
  expect(r.isError).toBeFalsy();
  expect(d.sent).toEqual([["c1", "hi"]]);
});

test("send_files uses exact chat matching and passes paths and optional caption", async () => {
  let seen: unknown;
  const d = deps({ allowSend: true });
  d.chats.resolveChat = async (_ref: string, o?: unknown) => { seen = o; return chat; };
  const { client } = await connect(d);
  const r: any = await client.callTool({
    name: "send_files",
    arguments: { chat: "Ata", paths: ["/tmp/a.pdf", "/tmp/b.pptx"], text: "caption" },
  });
  expect(r.isError).toBeFalsy();
  expect(seen).toEqual({ exact: true });
  expect(d.filesSent).toEqual([["c1", ["/tmp/a.pdf", "/tmp/b.pptx"], "caption"]]);
});

test("push mode drops wait_for_messages and pushes channel notifications", async () => {
  const d = deps({ push: true });
  const { server, client } = await connect(d);
  expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("wait_for_messages");

  const got: any[] = [];
  client.fallbackNotificationHandler = async (n) => { got.push(n); };
  const ac = new AbortController();
  let polls = 0;
  d.watcher.poll = async () => (++polls === 1 ? [msg(5, { text: "pushed", chatName: "Ata" })] : (ac.abort(), []));
  await startPush(server, d, ac.signal);
  await new Promise((r) => setTimeout(r, 10));
  expect(got).toHaveLength(1);
  expect(got[0].params.content).toBe("pushed");
  expect(got[0].params.meta.chat_name).toBe("Ata");
});

test("send_message resolves the chat with exact matching only", async () => {
  let seen: unknown;
  const d = deps({ allowSend: true });
  d.chats.resolveChat = async (_ref: string, o?: unknown) => { seen = o; return chat; };
  const { client } = await connect(d);
  await client.callTool({ name: "send_message", arguments: { chat: "At", text: "hi" } });
  expect(seen).toEqual({ exact: true });
});

test("push content falls back to an attachment description when there is no text", async () => {
  const d = deps({ push: true });
  const { server, client } = await connect(d);
  const got: any[] = [];
  client.fallbackNotificationHandler = async (n) => { got.push(n); };
  const ac = new AbortController();
  let polls = 0;
  d.watcher.poll = async () =>
    ++polls === 1 ? [msg(6, { text: "", attachment: { kind: "photo", name: "a.jpg" } })] : (ac.abort(), []);
  await startPush(server, d, ac.signal);
  await new Promise((r) => setTimeout(r, 10));
  expect(got[0].params.content).toBe("[photo: a.jpg]");
});

test("push only forwards allowlisted chats and never my own messages", async () => {
  const d = deps({ push: true, pushChatIds: new Set(["c1"]) });
  const { server, client } = await connect(d);
  const got: any[] = [];
  client.fallbackNotificationHandler = async (n) => { got.push(n); };
  const ac = new AbortController();
  let polls = 0;
  d.watcher.poll = async () =>
    ++polls === 1
      ? [
          msg(1, { chatId: "c1", text: "keep" }),
          msg(2, { chatId: "c2", text: "other chat" }),
          msg(3, { chatId: "c1", text: "mine", fromMe: true }),
        ]
      : (ac.abort(), []);
  await startPush(server, d, ac.signal);
  await new Promise((r) => setTimeout(r, 10));
  expect(got.map((n) => n.params.content)).toEqual(["keep"]);
});

test("wait_for_messages uses the leased poll when the watcher offers one", async () => {
  let leased = 0;
  const d = deps({ watcher: { poll: async () => [], pollLeased: async () => { leased++; return [msg(7, { text: "leased" })]; } } });
  const { client } = await connect(d);
  const r = await client.callTool({ name: "wait_for_messages", arguments: { timeout_seconds: 1 } });
  expect(JSON.parse(textOf(r))[0].text).toBe("leased");
  expect(leased).toBe(1);
});

test("push commits the batch only after every notification was delivered", async () => {
  const d = deps({ push: true });
  const { server } = await connect(d);
  const ac = new AbortController();
  let commits = 0;
  let polls = 0;
  d.watcher.pollBatch = async () =>
    ++polls === 1 ? { messages: [msg(1, { text: "a" })], commit: async () => { commits++; } } : (ac.abort(), { messages: [], commit: async () => {} });
  await startPush(server, d, ac.signal);
  await new Promise((r) => setTimeout(r, 30));
  ac.abort();
  expect(commits).toBe(1);
});

test("push does not commit when a notification fails, so the batch is retried", async () => {
  const d = deps({ push: true });
  const { server } = await connect(d);
  (server.server as any).notification = async () => { throw new Error("transport closed"); };
  const ac = new AbortController();
  let commits = 0;
  let polls = 0;
  d.watcher.pollBatch = async () =>
    ++polls <= 2 ? { messages: [msg(1, { text: "a" })], commit: async () => { commits++; } } : (ac.abort(), { messages: [], commit: async () => {} });
  const orig = console.error;
  console.error = () => {};
  await startPush(server, d, ac.signal);
  await new Promise((r) => setTimeout(r, 30));
  console.error = orig;
  ac.abort();
  expect(commits).toBe(0);
  expect(polls).toBeGreaterThanOrEqual(2); // retried
});

test("push backs off while idle and after errors, using the injected sleep", async () => {
  const delays: number[] = [];
  const ac = new AbortController();
  let polls = 0;
  const d = deps({
    push: true,
    pollIntervalMs: 1000,
    sleep: async (ms: number) => { delays.push(ms); },
    watcher: {
      poll: async () => {
        polls++;
        if (polls === 1) return [];
        if (polls === 2) throw new RateLimited();
        if (polls === 3) return [msg(1, { text: "x" })];
        ac.abort();
        return [];
      },
    },
  });
  const { server } = await connect(d);
  const orig = console.error;
  console.error = () => {};
  await startPush(server, d, ac.signal);
  await new Promise((r) => setTimeout(r, 30));
  console.error = orig;
  expect(delays).toEqual([1500, 3000, 1000]);
});

test("download_image is hidden independently of send and exposes only safe result metadata", async () => {
  let calls=0;
  const provider=async()=>{calls++;return {path:"/private/image.png",mime:"image/png",size:4,width:1,height:1,downloaded:true};};
  const hidden=await connect(deps({allowSend:true,downloadImage:provider}));
  expect((await hidden.client.listTools()).tools.map(t=>t.name)).not.toContain("download_image"); expect(calls).toBe(0);
  const enabled=await connect(deps({allowDownload:true,downloadImage:provider}));
  const tool=(await enabled.client.listTools()).tools.find(t=>t.name==="download_image");
  expect(tool?.annotations?.readOnlyHint).toBe(false); expect(tool?.description).toContain("not semantic vision");
  const bad:any=await enabled.client.callTool({name:"download_image",arguments:{chat:"Ata",message_id:"0123456789ABCDEF01234567"}});
  expect(bad.isError).toBe(true); expect(calls).toBe(0);
  const result:any=await enabled.client.callTool({name:"download_image",arguments:{chat:"Ata",message_id:"0123456789abcdef01234567"}});
  expect(JSON.parse(textOf(result)).path).toBe("/private/image.png"); expect(calls).toBe(1);
});
