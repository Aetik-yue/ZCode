import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { projectStorage } from "#src/project-storage/index.js";

const ROOT = "/work/repo";
const OTHER_ROOT = "/work/other";

const opened: DatabaseSync[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

/**
 * 两个项目共享同一 root：`shared` 是主根目录，`extra` 只是附加目录。
 * 这正是 fork 会话丢失归属的现场——uniqueRootProject 匹配到 2 个项目后返回 NULL。
 */
function fixture() {
  const db = new DatabaseSync(":memory:");
  opened.push(db);
  db.exec(`
    CREATE TABLE hosts(host_id TEXT PRIMARY KEY, kind TEXT, position INTEGER);
    CREATE TABLE projects(
      project_id TEXT PRIMARY KEY, host_id TEXT NOT NULL, name TEXT NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE project_roots(
      project_id TEXT NOT NULL, root_path TEXT NOT NULL, position INTEGER NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(project_id,root_path));
    CREATE TABLE tasks(
      workspace_key TEXT NOT NULL, workspace_path TEXT NOT NULL, workspace_identity TEXT,
      task_id TEXT NOT NULL, host_id TEXT, root_path TEXT, project_id TEXT,
      handoff_pending INTEGER NOT NULL DEFAULT 0, forked_from_task_id TEXT,
      PRIMARY KEY(workspace_key,task_id));
  `);
  db.prepare("INSERT INTO hosts(host_id,kind,position) VALUES('local','local',0)").run();
  addProject(db, "shared", ROOT, 1);
  addProject(db, "extra", ROOT, 0);
  return db;
}

function addProject(db: DatabaseSync, id: string, rootPath: string, isPrimary: number): void {
  db.prepare("INSERT INTO projects(project_id,host_id,name) VALUES(?,?,'')").run(id, "local");
  db.prepare("INSERT INTO project_roots VALUES(?,?,0,?)").run(id, rootPath, isPrimary);
}

interface TaskRowInput {
  path?: string;
  /** 已归位的历史行带 host；待首次归位的行留 NULL，admitTaskIdentity 只处理后者。 */
  hostId?: string | null;
  projectId?: string | null;
  forkedFrom?: string | null;
}

function insertTask(db: DatabaseSync, taskId: string, input: TaskRowInput = {}): void {
  const path = input.path ?? ROOT;
  db.prepare(
    `INSERT INTO tasks(workspace_key,workspace_path,task_id,host_id,root_path,project_id,forked_from_task_id)
     VALUES(?,?,?,?,?,?,?)`,
  ).run(path, path, taskId, input.hostId ?? null, path, input.projectId ?? null, input.forkedFrom ?? null);
}

function taskProject(db: DatabaseSync, taskId: string) {
  return db
    .prepare("SELECT project_id, host_id FROM tasks WHERE task_id=?")
    .get(taskId) as { project_id: string | null; host_id: string | null };
}

describe("admitTaskIdentity：fork 继承父会话的项目归属", () => {
  it("共享 root 无法唯一归位时，fork 继承父任务的 project_id", () => {
    const db = fixture();
    insertTask(db, "parent", { hostId: "local", projectId: "shared" });
    insertTask(db, "fork", { forkedFrom: "parent" });

    projectStorage.admitTaskIdentity(db, {
      workspacePath: ROOT,
      taskId: "fork",
      forkedFromTaskId: "parent",
    });

    expect(taskProject(db, "fork")).toMatchObject({ project_id: "shared", host_id: "local" });
  });

  it("非 fork 任务保持既有契约：共享 root 时 project_id 仍为 NULL", () => {
    const db = fixture();
    insertTask(db, "plain");

    projectStorage.admitTaskIdentity(db, { workspacePath: ROOT, taskId: "plain" });

    expect(taskProject(db, "plain")).toMatchObject({ project_id: null, host_id: "local" });
  });

  it("唯一 root 匹配优先于父任务归属", () => {
    const db = fixture();
    addProject(db, "solo", OTHER_ROOT, 1);
    insertTask(db, "parent", { hostId: "local", projectId: "shared" });
    insertTask(db, "fork", { path: OTHER_ROOT, forkedFrom: "parent" });

    projectStorage.admitTaskIdentity(db, {
      workspacePath: OTHER_ROOT,
      taskId: "fork",
      forkedFromTaskId: "parent",
    });

    expect(taskProject(db, "fork")).toMatchObject({ project_id: "solo" });
  });

  it("父任务本身无项目归属时 fork 仍为 NULL", () => {
    const db = fixture();
    insertTask(db, "parent", { hostId: "local", projectId: null });
    insertTask(db, "fork", { forkedFrom: "parent" });

    projectStorage.admitTaskIdentity(db, {
      workspacePath: ROOT,
      taskId: "fork",
      forkedFromTaskId: "parent",
    });

    expect(taskProject(db, "fork")).toMatchObject({ project_id: null });
  });

  it("只读同一 host 的父任务，避免跨 host 继承", () => {
    const db = fixture();
    db.prepare("INSERT INTO hosts(host_id,kind,position) VALUES('remote','server',1)").run();
    insertTask(db, "parent", { hostId: "remote", projectId: "shared" });
    insertTask(db, "fork", { forkedFrom: "parent" });

    projectStorage.admitTaskIdentity(db, {
      workspacePath: ROOT,
      taskId: "fork",
      forkedFromTaskId: "parent",
    });

    expect(taskProject(db, "fork")).toMatchObject({ project_id: null, host_id: "local" });
  });
});
