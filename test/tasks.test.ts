import { expect, test } from "bun:test";
import { TaskService } from "../src/core/tasks";
import { ConfigError, NetworkError, SchemaError, TaskWriteDisabled } from "../src/core/errors";

const raw = { _id: "t1", title: "Review", project: "p1", assignee: ["u1"], access_token: "private-token", notes: "<b>Details</b>", completed: false };

test("project listing returns ids and member ids without extra response fields", async () => {
  const tasks = new TaskService({ post: async () => ({ projects: [{ _id: "p1", title: "Team", members: ["u1"], secret: "hidden" }] }) });
  expect(await tasks.listProjects()).toEqual([{ id: "p1", title: "Team", memberIds: ["u1"] }]);
});

test("project listing gets members from the linked project group when the project has no members field", async () => {
  const calls: [string, unknown][] = [];
  const tasks = new TaskService({ post: async (path, body) => {
    calls.push([path, body]);
    if (path === "/api/projects/getList") return { projects: [{ _id: "p1", title: "Team", dialog: "chat1" }] };
    if (path === "/api/chat/getFullChat") return {
      is_project_group: true, project_entity: "p1", participants: ["owner", "member"],
    };
    throw new Error(`Unexpected request: ${path}`);
  } });
  expect(await tasks.listProjects()).toEqual([{ id: "p1", title: "Team", memberIds: ["owner", "member"] }]);
  expect(calls).toEqual([
    ["/api/projects/getList", {}],
    ["/api/chat/getFullChat", { dialog: "chat1" }],
  ]);
});

test("project listing rejects participants from an unrelated group", async () => {
  const tasks = new TaskService({ post: async (path) => path === "/api/projects/getList"
    ? { projects: [{ _id: "p1", title: "Team", dialog: "chat1" }] }
    : { is_project_group: true, project_entity: "other", participants: ["u1"] } });
  await expect(tasks.listProjects()).rejects.toBeInstanceOf(SchemaError);
});

test("task scopes use the Mizito upcoming request shapes", async () => {
  const calls: [string, unknown][] = [];
  const tasks = new TaskService({ post: async (path, body) => {
    calls.push([path, body]);
    return [];
  } });
  await tasks.listTasks();
  await tasks.listTasks("following", 10);
  await tasks.listTasks("project", 20, "p1");
  await tasks.listTasks("done", 30);
  expect(calls).toEqual([
    ["/api/tasks/upcoming", { inbox: true, sort_type: "default", filter: null, from: 0 }],
    ["/api/tasks/upcoming", { outbox: true, sort_type: "default", filter: null, from: 10 }],
    ["/api/tasks/upcoming", { project_id: "p1", all: true, sort_type: "default", filter: null, from: 20 }],
    ["/api/tasks/upcoming", { done_timeline: true, filter: {}, from: 30 }],
  ]);
});

test("task summaries allowlist fields and never expose access tokens", async () => {
  const secret = "session-embedded-task-token";
  const tasks = new TaskService({ post: async () => [{
    _id: "t1", title: "Review", project: "p1", assignee: ["u1"],
    completed: false, progress: 25, deadline: "2026-11-01T00:00:00Z",
    alarm_at: "2026-10-30T00:00:00Z", access_token: secret,
    extra: { access_token: secret },
  }] });
  const result = await tasks.listTasks();
  expect(result).toEqual([{
    id: "t1", title: "Review", projectId: "p1", assigneeIds: ["u1"],
    completed: false, progress: 25, deadline: "2026-11-01T00:00:00Z",
    reminderAt: "2026-10-30T00:00:00Z",
  }]);
  expect(JSON.stringify(result)).not.toContain(secret);
});

test("task listing rejects invalid inputs before API calls and malformed responses", async () => {
  let calls = 0;
  const tasks = new TaskService({ post: async () => { calls++; return { tasks: [] }; } });
  await expect(tasks.listTasks("project")).rejects.toBeInstanceOf(ConfigError);
  await expect(tasks.listTasks("mine", -1)).rejects.toBeInstanceOf(ConfigError);
  await expect(tasks.listTasks("mine", 0, "p1")).rejects.toBeInstanceOf(ConfigError);
  expect(calls).toBe(0);
  await expect(tasks.listTasks()).rejects.toBeInstanceOf(SchemaError);
});

test("task writes are disabled before any API request", async () => {
  let calls = 0;
  const tasks = new TaskService({ post: async () => { calls++; return raw; } });
  await expect(tasks.createTask({ title: "New", projectId: "p1" })).rejects.toBeInstanceOf(TaskWriteDisabled);
  await expect(tasks.updateTask("t1", { title: "Changed" })).rejects.toBeInstanceOf(TaskWriteDisabled);
  await expect(tasks.deleteTask("t1")).rejects.toBeInstanceOf(TaskWriteDisabled);
  await expect(tasks.commentOnTask("t1", "Hello")).rejects.toBeInstanceOf(TaskWriteDisabled);
  expect(calls).toBe(0);
});

test("create task sends the web form shape and returns no token", async () => {
  const calls: [string, any][] = [];
  const tasks = new TaskService({ post: async (path, body) => {
    calls.push([path, body]);
    if (path === "/api/workspace/userId") return { uid: "me" };
    return raw;
  } }, true);
  const result = await tasks.createTask({ title: " Review ", projectId: "p1", notes: "Details" });
  expect(calls[0]![0]).toBe("/api/workspace/userId");
  expect(calls[1]![1]).toMatchObject({ title: "Review", project: "p1", assignee: ["me"], notes: "Details", checklist: [], insert_to_chat_group: false });
  expect(result.id).toBe("t1");
  expect(JSON.stringify(result)).not.toContain("private-token");
});

test("update sends the whole editable task and only changes requested fields", async () => {
  const calls: [string, any][] = [];
  let saved = false;
  const tasks = new TaskService({ post: async (path, body) => {
    calls.push([path, body]);
    if (path === "/api/tasks/upcoming") return [raw];
    if (path === "/api/tasks/get") return { ...raw, title: saved ? "Changed" : raw.title, checklist: [{ _id: "c1", title: "Check", checked: true }], labels: ["l1"], weight: 2 };
    if (path === "/api/tasks/save") saved = true;
    return true;
  } }, true);
  const result = await tasks.updateTask("t1", { title: "Changed", deadline: null });
  const save = calls.find(([path]) => path === "/api/tasks/save")![1];
  expect(save).toMatchObject({ task_id: "t1", token: "private-token", title: "Changed", notes: "<b>Details</b>", assignee: ["u1"], project: "p1", labels: ["l1"], weight: 2, deadline: null });
  expect(result.notes).toBe("Details");
  expect(result.checklist[0]).toEqual({ id: "c1", title: "Check", checked: true });
  expect(JSON.stringify(result)).not.toContain("private-token");
});

test("an ignored task edit is reported instead of claiming success", async () => {
  const tasks = new TaskService({ post: async (path) => {
    if (path === "/api/tasks/upcoming") return [raw];
    if (path === "/api/tasks/get") return raw;
    return true;
  } }, true);
  await expect(tasks.updateTask("t1", { title: "Changed" })).rejects.toBeInstanceOf(SchemaError);
});

test("updated HTML notes are verified as the text returned by getTask", async () => {
  let stored = raw.notes;
  const tasks = new TaskService({ post: async (path, body) => {
    if (path === "/api/tasks/upcoming") return [raw];
    if (path === "/api/tasks/get") return { ...raw, notes: stored };
    if (path === "/api/tasks/save") stored = (body as { notes: string }).notes;
    return true;
  } }, true);
  expect((await tasks.updateTask("t1", { notes: "<b>Updated</b>" })).notes).toBe("Updated");
  expect((await tasks.updateTask("t1", { notes: "  Plain text  " })).notes).toBe("Plain text");
});

test("an ignored deadline update is reported instead of claiming success", async () => {
  const withDeadline = { ...raw, deadline: "2026-11-01T00:00:00Z" };
  const tasks = new TaskService({ post: async (path) => {
    if (path === "/api/tasks/upcoming") return [withDeadline];
    if (path === "/api/tasks/get") return withDeadline;
    return true;
  } }, true);
  await expect(tasks.updateTask("t1", { deadline: "2026-12-01T00:00:00Z" })).rejects.toBeInstanceOf(SchemaError);
});

test("a deadline returned with an equivalent ISO offset verifies successfully", async () => {
  const withDeadline = { ...raw, deadline: "2026-11-01T00:00:00Z" };
  const tasks = new TaskService({ post: async (path) => {
    if (path === "/api/tasks/upcoming") return [withDeadline];
    if (path === "/api/tasks/get") return withDeadline;
    return true;
  } }, true);
  expect((await tasks.updateTask("t1", { deadline: "2026-11-01T03:30:00+03:30" })).deadline).toBe(withDeadline.deadline);
});

test("task lookup reaches pages beyond the former ten-page limit", async () => {
  const offsets: number[] = [];
  const tasks = new TaskService({ post: async (path, body) => {
    if (path === "/api/tasks/upcoming") {
      const offset = (body as { from: number }).from;
      offsets.push(offset);
      return Array.from({ length: 15 }, (_, index) => ({
        _id: `t${offset + index}`, title: `Task ${offset + index}`, access_token: `token${offset + index}`,
      }));
    }
    if (path === "/api/tasks/get") return { _id: "t150", title: "Task 150", access_token: "token150" };
    throw new Error(`Unexpected request: ${path}`);
  } });
  expect((await tasks.getTask("t150")).id).toBe("t150");
  expect(offsets).toEqual(Array.from({ length: 11 }, (_, page) => page * 15));
});

test("task lookup stops when an endpoint repeats a previous page", async () => {
  const offsets: number[] = [];
  const tasks = new TaskService({ post: async (path, body) => {
    if (path !== "/api/tasks/upcoming") throw new Error(`Unexpected request: ${path}`);
    const offset = (body as { from: number }).from;
    offsets.push(offset);
    return [{ _id: offset % 2 === 0 ? "a" : "b", title: "Repeated", access_token: "token" }];
  } });
  await expect(tasks.getTask("missing")).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  expect(offsets).toHaveLength(9);
});

test("an expired task token is refreshed from the list once", async () => {
  let listed = 0;
  const tokens: string[] = [];
  const tasks = new TaskService({ post: async (path, body) => {
    if (path === "/api/tasks/upcoming") return [{ ...raw, access_token: ++listed === 1 ? "old" : "fresh" }];
    if (path === "/api/tasks/get") {
      const token = (body as { token: string }).token;
      tokens.push(token);
      if (token === "old") throw new NetworkError("HTTP 400 from /api/tasks/get");
      return { ...raw, access_token: "fresh" };
    }
    return true;
  } });
  expect((await tasks.getTask("t1")).id).toBe("t1");
  expect(tokens).toEqual(["old", "fresh"]);
});

test("delete and comment use private task tokens and safe output", async () => {
  const calls: [string, any][] = [];
  const tasks = new TaskService({ post: async (path, body) => {
    calls.push([path, body]);
    if (path === "/api/tasks/upcoming") return [raw];
    if (path === "/api/tasks/get") return raw;
    return true;
  } }, true);
  const comment = await tasks.commentOnTask("t1", "<hello> & bye");
  expect(calls.find(([path]) => path === "/api/tasks/newComment")![1]).toMatchObject({ token: "private-token", comment: "&lt;hello&gt; &amp; bye", attachments: [], mention: [], reply_id: null });
  const deleted = await tasks.deleteTask("t1");
  expect(calls.find(([path]) => path === "/api/tasks/removeTask")![1]).toEqual({ token: "private-token" });
  expect(JSON.stringify([comment, deleted])).not.toContain("private-token");
});

test("complete and reopen send the exact task state and verify it", async () => {
  let completed = false;
  const calls: [string, any][] = [];
  const tasks = new TaskService({ post: async (path, body) => {
    calls.push([path, body]);
    if (path === "/api/tasks/upcoming") return [raw];
    if (path === "/api/tasks/get") return { ...raw, completed };
    if (path === "/api/tasks/setCompleted") { completed = (body as { completed: boolean }).completed; return true; }
    return true;
  } }, true);
  expect((await tasks.setTaskCompleted("t1", true)).completed).toBe(true);
  expect((await tasks.setTaskCompleted("t1", false)).completed).toBe(false);
  expect(calls.filter(([path]) => path === "/api/tasks/setCompleted").map(([, body]) => body)).toEqual([
    { token: "private-token", completed: true, project: "p1" },
    { token: "private-token", completed: false, project: "p1" },
  ]);
});
