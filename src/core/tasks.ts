import { z } from "zod";
import type { Poster } from "./client";
import { ConfigError, NetworkError, SchemaError, TaskNotFound, TaskWriteDisabled } from "./errors";
import { htmlToText } from "./text";

export type TaskScope = "mine" | "following" | "project" | "done";

export interface TaskSummary {
  id: string;
  title: string;
  projectId?: string;
  assigneeIds: string[];
  completed: boolean;
  progress?: number;
  deadline?: string;
  reminderAt?: string;
}

export interface TaskDetail extends TaskSummary {
  notes: string;
  boardId?: string;
  checklist: { id?: string; title: string; checked: boolean }[];
  labelIds: string[];
  deleted: boolean;
}

export interface TaskProject {
  id: string;
  title: string;
  memberIds: string[];
}

export interface CreateTask {
  title: string;
  projectId: string;
  notes?: string;
  assigneeIds?: string[];
  deadline?: string;
}

export interface UpdateTask {
  title?: string;
  notes?: string;
  assigneeIds?: string[];
  deadline?: string | null;
  projectId?: string;
  boardId?: string | null;
  labelIds?: string[];
}

const RawTask = z.object({
  _id: z.string().min(1),
  title: z.string(),
  access_token: z.string().min(1).optional(),
  project: z.string().nullish(),
  assignee: z.array(z.string()).nullish(),
  completed: z.boolean().nullish(),
  progress: z.number().nullish(),
  deadline: z.string().nullish(),
  alarm_at: z.string().nullish(),
  notes: z.string().nullish(),
  kanban_board: z.string().nullish(),
  checklist: z.array(z.object({ _id: z.string().optional(), title: z.string(), checked: z.boolean().optional() }).loose()).nullish(),
  labels: z.array(z.string()).nullish(),
  deleted: z.boolean().nullish(),
}).loose();
type RawTask = z.infer<typeof RawTask>;

const EDIT_FIELDS = ["title", "notes", "assignee", "project", "kanban_board", "labels", "attachments",
  "deleted", "alarm_options", "progress", "weight", "deadline_start", "deadline", "checklist", "copy_users"] as const;

function required(value: string, name: string): string {
  if (!value.trim()) throw new ConfigError(`${name} is required`);
  return value.trim();
}

function checkedResult(value: unknown, endpoint: string): void {
  if (value === false ||
      (typeof value === "object" && value !== null && "error" in value)) {
    throw new SchemaError(endpoint, "Mizito did not confirm the change");
  }
}

function sameDeadline(actual: string | undefined, requested: string): boolean {
  if (actual === requested) return true;
  if (!actual) return false;
  const actualTime = Date.parse(actual);
  const requestedTime = Date.parse(requested);
  return Number.isFinite(actualTime) && Number.isFinite(requestedTime) && actualTime === requestedTime;
}

export class TaskService {
  private readonly tokens = new Map<string, string>();

  constructor(private readonly client: Poster, private readonly allowWrite = false) {}

  private assertWrite(): void {
    if (!this.allowWrite) throw new TaskWriteDisabled();
  }

  async listProjects(): Promise<TaskProject[]> {
    const raw = await this.client.post("/api/projects/getList", {});
    const parsed = z.object({ projects: z.array(z.object({
      _id: z.string().min(1), title: z.string(), members: z.array(z.string()).nullish(),
      dialog: z.string().nullish(),
    }).loose()) }).safeParse(raw);
    if (!parsed.success) throw new SchemaError("projects/getList", "expected a list of projects");
    const projects: TaskProject[] = [];
    for (const project of parsed.data.projects) {
      let memberIds = project.members;
      if (!memberIds && project.dialog) {
        const chat = await this.client.post("/api/chat/getFullChat", { dialog: project.dialog });
        const detail = z.object({
          is_project_group: z.literal(true), project_entity: z.literal(project._id),
          participants: z.array(z.string()),
        }).safeParse(chat);
        if (!detail.success) throw new SchemaError("chat/getFullChat", "expected the linked project group and its participants");
        memberIds = detail.data.participants;
      }
      projects.push({ id: project._id, title: project.title, memberIds: memberIds ?? [] });
    }
    return projects;
  }

  private async page(scope: TaskScope, offset: number, projectId?: string): Promise<RawTask[]> {
    if (!["mine", "following", "project", "done"].includes(scope)) throw new ConfigError("Unknown task scope");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new ConfigError("Task offset must be a non-negative whole number");
    if (scope === "project" && !projectId?.trim()) throw new ConfigError("project_id is required for project tasks");
    if (scope !== "project" && projectId !== undefined) throw new ConfigError("project_id is only valid for project tasks");
    const payload = scope === "project"
      ? { project_id: projectId, all: true, sort_type: "default", filter: null, from: offset }
      : scope === "done"
        ? { done_timeline: true, filter: {}, from: offset }
        : { [scope === "mine" ? "inbox" : "outbox"]: true, sort_type: "default", filter: null, from: offset };
    const raw = await this.client.post("/api/tasks/upcoming", payload);
    const parsed = z.array(RawTask).safeParse(raw);
    if (!parsed.success) throw new SchemaError("tasks/upcoming", "expected a list of tasks with ids and titles");
    for (const task of parsed.data) if (task.access_token) this.tokens.set(task._id, task.access_token);
    return parsed.data;
  }

  async listTasks(scope: TaskScope = "mine", offset = 0, projectId?: string): Promise<TaskSummary[]> {
    return (await this.page(scope, offset, projectId)).map((task) => ({
      id: task._id,
      title: task.title,
      ...(task.project ? { projectId: task.project } : {}),
      assigneeIds: task.assignee ?? [],
      completed: task.completed ?? false,
      ...(task.progress != null ? { progress: task.progress } : {}),
      ...(task.deadline ? { deadline: task.deadline } : {}),
      ...(task.alarm_at ? { reminderAt: task.alarm_at } : {}),
    }));
  }

  private async tokenFor(id: string, projectId?: string): Promise<string> {
    required(id, "Task id");
    if (projectId !== undefined) required(projectId, "Project id");
    const cached = this.tokens.get(id);
    if (cached) return cached;
    const scopes: { scope: TaskScope; projectId?: string }[] = [
      { scope: "mine" }, { scope: "following" }, { scope: "done" },
      ...(projectId ? [{ scope: "project" as const, projectId }] : []),
    ];
    for (const { scope, projectId: project } of scopes) {
      let offset = 0;
      const seenFirstIds = new Set<string>();
      while (true) {
        const rows = await this.page(scope, offset, project);
        if (this.tokens.has(id)) return this.tokens.get(id)!;
        if (!rows.length || seenFirstIds.has(rows[0]!._id)) break;
        seenFirstIds.add(rows[0]!._id);
        offset += rows.length;
      }
    }
    throw new TaskNotFound(id);
  }

  private async rawTask(id: string, projectId?: string): Promise<RawTask> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.tokenFor(id, projectId);
      let raw: unknown;
      try {
        raw = await this.client.post("/api/tasks/get", { token });
      } catch (error) {
        if (attempt === 0 && error instanceof NetworkError && error.message.startsWith("HTTP 400 from /api/tasks/get")) {
          this.tokens.delete(id);
          continue;
        }
        throw error;
      }
      const parsed = RawTask.safeParse(raw);
      if (!parsed.success || parsed.data._id !== id || !parsed.data.access_token) {
        throw new SchemaError("tasks/get", "expected the requested task and an access token");
      }
      this.tokens.set(id, parsed.data.access_token);
      return parsed.data;
    }
    throw new TaskNotFound(id);
  }

  async getTask(id: string, projectId?: string): Promise<TaskDetail> {
    const task = await this.rawTask(id, projectId);
    return {
      id: task._id, title: task.title,
      ...(task.project ? { projectId: task.project } : {}),
      assigneeIds: task.assignee ?? [], completed: task.completed ?? false,
      ...(task.progress != null ? { progress: task.progress } : {}),
      ...(task.deadline ? { deadline: task.deadline } : {}),
      ...(task.alarm_at ? { reminderAt: task.alarm_at } : {}),
      notes: htmlToText(task.notes ?? ""),
      ...(task.kanban_board ? { boardId: task.kanban_board } : {}),
      checklist: (task.checklist ?? []).map((item) => ({
        ...(item._id ? { id: item._id } : {}), title: item.title, checked: item.checked ?? false,
      })),
      labelIds: task.labels ?? [], deleted: task.deleted ?? false,
    };
  }

  async createTask(input: CreateTask): Promise<TaskSummary> {
    this.assertWrite();
    const title = required(input.title, "Task title");
    const project = required(input.projectId, "Project id");
    const assignees = input.assigneeIds?.length ? input.assigneeIds.map((id) => required(id, "Assignee id")) : undefined;
    let userId: string | undefined;
    if (!assignees) {
      const me = await this.client.post("/api/workspace/userId", {});
      userId = z.object({ uid: z.string().min(1) }).safeParse(me).data?.uid;
      if (!userId) throw new SchemaError("workspace/userId", "could not determine the task assignee");
    }
    const payload = {
      title, notes: input.notes ?? "", assignee: assignees ?? [userId!], project,
      kanban_board: null, labels: [], attachments: [], deleted: false,
      alarm_options: null, progress: 0, weight: 1, responsible: null,
      checklist: [], from_chat: false, from_minute: false, insert_to_chat_group: false,
      ...(input.deadline ? { deadline: input.deadline } : {}),
    };
    const raw = await this.client.post("/api/tasks/add", payload);
    const parsed = RawTask.safeParse(raw);
    if (!parsed.success) throw new SchemaError("tasks/add", "task creation did not return a task id and title");
    if (parsed.data.access_token) this.tokens.set(parsed.data._id, parsed.data.access_token);
    return {
      id: parsed.data._id, title: parsed.data.title,
      ...(parsed.data.project ? { projectId: parsed.data.project } : {}),
      assigneeIds: parsed.data.assignee ?? [], completed: parsed.data.completed ?? false,
      ...(parsed.data.progress != null ? { progress: parsed.data.progress } : {}),
      ...(parsed.data.deadline ? { deadline: parsed.data.deadline } : {}),
      ...(parsed.data.alarm_at ? { reminderAt: parsed.data.alarm_at } : {}),
    };
  }

  async updateTask(id: string, changes: UpdateTask, projectId?: string): Promise<TaskDetail> {
    this.assertWrite();
    if (!Object.keys(changes).length) throw new ConfigError("At least one task change is required");
    if (changes.title !== undefined) required(changes.title, "Task title");
    if (changes.projectId !== undefined) required(changes.projectId, "Project id");
    if (changes.assigneeIds) changes.assigneeIds.forEach((value) => required(value, "Assignee id"));
    const task = await this.rawTask(id, projectId);
    if (task.completed) throw new ConfigError("Completed tasks must be reopened before editing");
    const payload: Record<string, unknown> = {};
    for (const field of EDIT_FIELDS) if (field in task) payload[field] = task[field];
    payload.responsible = task.responsible ?? null;
    payload.task_id = task._id;
    payload.token = task.access_token;
    if (changes.title !== undefined) payload.title = changes.title.trim();
    if (changes.notes !== undefined) payload.notes = changes.notes;
    if (changes.assigneeIds !== undefined) payload.assignee = changes.assigneeIds;
    if (changes.deadline !== undefined) payload.deadline = changes.deadline;
    if (changes.projectId !== undefined) { payload.project = changes.projectId; payload.kanban_board = null; }
    if (changes.boardId !== undefined) payload.kanban_board = changes.boardId;
    if (changes.labelIds !== undefined) payload.labels = changes.labelIds;
    checkedResult(await this.client.post("/api/tasks/save", payload), "tasks/save");
    const after = await this.getTask(id, changes.projectId ?? projectId);
    const sameIds = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
    if ((changes.title !== undefined && after.title !== changes.title.trim()) ||
        (changes.notes !== undefined && after.notes !== htmlToText(changes.notes)) ||
        (changes.assigneeIds !== undefined && !sameIds(after.assigneeIds, changes.assigneeIds)) ||
        (changes.projectId !== undefined && after.projectId !== changes.projectId) ||
        (changes.boardId !== undefined && (after.boardId ?? null) !== changes.boardId) ||
        (changes.labelIds !== undefined && !sameIds(after.labelIds, changes.labelIds)) ||
        (changes.deadline === null && after.deadline !== undefined) ||
        (typeof changes.deadline === "string" && !sameDeadline(after.deadline, changes.deadline))) {
      throw new SchemaError("tasks/save", "saved task did not match the requested changes");
    }
    return after;
  }

  async deleteTask(id: string, projectId?: string): Promise<{ deleted: true; taskId: string }> {
    this.assertWrite();
    const task = await this.rawTask(id, projectId);
    checkedResult(await this.client.post("/api/tasks/removeTask", { token: task.access_token }), "tasks/removeTask");
    this.tokens.delete(id);
    return { deleted: true, taskId: id };
  }

  async setTaskCompleted(id: string, completed: boolean, projectId?: string): Promise<TaskDetail> {
    this.assertWrite();
    const task = await this.rawTask(id, projectId);
    if (!task.project) throw new SchemaError("tasks/get", "task has no project id");
    checkedResult(await this.client.post("/api/tasks/setCompleted", {
      token: task.access_token, completed, project: task.project,
    }), "tasks/setCompleted");
    const after = await this.getTask(id, projectId);
    if (after.completed !== completed) throw new SchemaError("tasks/setCompleted", "task completion state did not change");
    return after;
  }

  async commentOnTask(id: string, text: string, projectId?: string): Promise<{ commented: true; taskId: string }> {
    this.assertWrite();
    required(text, "Comment text");
    const task = await this.rawTask(id, projectId);
    const endpoint = task.is_form_request ? "/api/formRequestTemplate/newComment" : "/api/tasks/newComment";
    checkedResult(await this.client.post(endpoint, {
      token: task.access_token,
      comment: text.trim().replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;").replaceAll("'", "&#x27;").replaceAll("\n", "<br>"),
      attachments: [], mention: [], reply_id: null,
    }), endpoint.slice(5));
    return { commented: true, taskId: id };
  }
}
