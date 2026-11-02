export type MemberId = string;
export interface Member { id: MemberId; name: string; aliases: string[] }
export type TaskStatus = 'todo' | 'doing' | 'done' | 'blocked';
export interface Task {
  id: string;
  title: string;
  detail?: string;
  assignee: MemberId;
  creator: MemberId;
  status: TaskStatus;
  due?: string;
  notes: { at: string; by: MemberId; text: string }[];
  createdAt: string;
  updatedAt: string;
}
export interface Progress { id: string; member: MemberId; date: string; text: string; createdAt: string }
export interface Notification {
  id: string; to: MemberId; from: MemberId; text: string; createdAt: string; deliveredAt?: string;
}
export interface HistoryTurn { role: 'user' | 'assistant'; content: string }
export class KnowledgeTableError extends Error {
  constructor(table: string, available: string[]) {
    super(`找不到知识表「${table}」。可用的知识表：${available.length ? available.join('、') : '无'}。`);
  }
}
export interface NewTask { title: string; assignee: MemberId; detail?: string; due?: string }
export interface TaskUpdate { status?: TaskStatus; note?: string }

/** JSON 与飞书存储共用接口；调用方不依赖底层存储。 */
export interface Store {
  initialize(): Promise<void>;
  getMembers(): Promise<Member[]>;
  listKnowledgeTables(): Promise<string[]>;
  queryKnowledge(table: string, keyword?: string): Promise<Record<string, string>[]>;
  searchInfo(keyword?: string): Promise<Record<string, string>[]>;
  saveInfo(title: string, content: string, category?: string): Promise<Record<string, string>[]>;
  listTasks(filter?: { assignee?: MemberId; status?: TaskStatus }): Promise<Task[]>;
  createTask(owner: MemberId, input: NewTask): Promise<Task>;
  updateTask(owner: MemberId, id: string, update: TaskUpdate): Promise<Task>;
  logProgress(owner: MemberId, text: string): Promise<Progress>;
  getProgress(member: MemberId, days: number): Promise<{ progress: Progress[]; tasks: Task[] }>;
  notifyMember(from: MemberId, to: MemberId, text: string): Promise<Notification>;
  pendingNotifications(to: MemberId): Promise<Notification[]>;
  markDelivered(id: string): Promise<void>;
  getHistory(owner: MemberId): Promise<HistoryTurn[]>;
  appendHistory(owner: MemberId, turns: HistoryTurn[]): Promise<void>;
  clearHistory(owner: MemberId): Promise<void>;
}
