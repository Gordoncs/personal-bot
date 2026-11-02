import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, link } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { Mutex } from '../mutex.js';
import { validateMemberId } from '../members.js';
import { INFO_CATEGORIES } from './feishu-schema.js';
import { KnowledgeTableError } from './types.js';
import { recentDateRange, shanghaiDate } from '../time.js';
import type { HistoryTurn, MemberId, NewTask, Notification, Store, TaskUpdate } from './types.js';

const memberId = z.string().regex(/^[A-Za-z0-9_-]+$/);
const status = z.enum(['todo', 'doing', 'done', 'blocked']);
const memberSchema = z.object({ id: memberId, name: z.string(), aliases: z.array(z.string()) });
const taskSchema = z.object({
  id: z.string(), title: z.string(), detail: z.string().optional(), assignee: memberId, creator: memberId,
  status, due: z.string().optional(), notes: z.array(z.object({ at: z.string(), by: memberId, text: z.string() })),
  createdAt: z.string(), updatedAt: z.string(),
});
const progressSchema = z.object({
  id: z.string(), member: memberId, date: z.string(), text: z.string(), createdAt: z.string(),
});
const notificationSchema = z.object({
  id: z.string(), to: memberId, from: memberId, text: z.string(), createdAt: z.string(), deliveredAt: z.string().optional(),
});
const historySchema = z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() }));
const infoSchema = z.array(z.record(z.string(), z.string()));
const locks = new Map<string, Mutex>();
const defaults = {
  'info.json': [{ 标题: '欢迎使用', 内容: '在 Agent 中说「同步到知识库」，确认后保存。', 分类: '其他' }],
  'tasks.json': [], 'progress.json': [], 'outbox.json': [],
};

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function id(prefix: string): string { return `${prefix}-${randomUUID().replaceAll('-', '').slice(0, 12)}`; }

export class JsonStore implements Store {
  readonly directory: string;
  private readonly mutex: Mutex;

  constructor(directory: string, private readonly ownerName = process.env.OWNER_NAME?.trim() || '我', private readonly ownerId = 'm1') {
    this.directory = resolve(directory);
    if (!locks.has(this.directory)) locks.set(this.directory, new Mutex());
    this.mutex = locks.get(this.directory)!;
  }

  private async read<T>(file: string, schema: z.ZodType<T>): Promise<T> {
    try { return schema.parse(JSON.parse(await readFile(join(this.directory, file), 'utf8'))); }
    catch (error) { if (file.startsWith('history/') && missing(error)) return schema.parse([]); throw error; }
  }

  private async write(file: string, value: unknown, onlyIfMissing = false): Promise<void> {
    const destination = join(this.directory, file);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      if (onlyIfMissing) {
        // link 保证两个进程首次初始化时不覆盖已经生成的文件。
        try { await link(temporary, destination); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      } else {
        await rename(temporary, destination);
      }
    } finally { await rm(temporary, { force: true }); }
  }

  async initialize(): Promise<void> {
    await this.mutex.run(async () => {
      validateMemberId(this.ownerId);
      const initial = { ...defaults, 'members.json': [{ id: this.ownerId, name: this.ownerName, aliases: [] }] };
      for (const [file, value] of Object.entries(initial)) {
        try { await readFile(join(this.directory, file), 'utf8'); }
        catch (error) { if (!missing(error)) throw error; await this.write(file, value, true); }
      }
    });
  }

  getMembers() { return this.mutex.run(() => this.read('members.json', z.array(memberSchema))); }
  async listKnowledgeTables(): Promise<string[]> { return ['资料']; }
  async queryKnowledge(table: string, keyword?: string): Promise<Record<string, string>[]> {
    if (table === '资料') return this.searchInfo(keyword);
    throw new KnowledgeTableError(table, ['资料']);
  }
  searchInfo(keyword?: string) {
    return this.mutex.run(async () => (await this.read('info.json', infoSchema)).filter(row =>
      !keyword || Object.values(row).some(value => value.toLocaleLowerCase('en-US').includes(keyword.toLocaleLowerCase('en-US')))));
  }
  saveInfo(title: string, content: string, category?: string) {
    return this.mutex.run(async () => {
      if (category && !INFO_CATEGORIES.includes(category as typeof INFO_CATEGORIES[number])) throw new Error('分类无效。');
      const rows = await this.read('info.json', infoSchema);
      const matches = rows.filter(row => row['标题'] === title);
      if (matches.length > 1) throw new Error('资料标题重复，请先在知识库中核实。');
      const row = matches[0] ?? { 标题: title };
      Object.assign(row, { 内容: content, 更新时间: new Date().toISOString(), ...(category ? { 分类: category } : {}) });
      if (!matches.length) rows.push(row);
      await this.write('info.json', rows);
      return rows;
    });
  }

  listTasks(filter: { assignee?: MemberId; status?: z.infer<typeof status> } = {}) {
    return this.mutex.run(async () => (await this.read('tasks.json', z.array(taskSchema))).filter(
      task => (!filter.assignee || task.assignee === filter.assignee) && (!filter.status || task.status === filter.status),
    ));
  }

  private async enqueue(from: MemberId, to: MemberId, text: string): Promise<Notification> {
    const outbox = await this.read('outbox.json', z.array(notificationSchema));
    const notification = { id: id('N'), to, from, text, createdAt: new Date().toISOString() };
    outbox.push(notification);
    await this.write('outbox.json', outbox);
    return notification;
  }

  createTask(owner: MemberId, input: NewTask) {
    return this.mutex.run(async () => {
      const tasks = await this.read('tasks.json', z.array(taskSchema));
      const now = new Date().toISOString();
      const task = { ...input, id: id('T'), creator: owner, status: 'todo' as const, notes: [], createdAt: now, updatedAt: now };
      tasks.push(task);
      await this.write('tasks.json', tasks);
      if (input.assignee !== owner) {
        await this.enqueue(owner, input.assignee,
          `新任务 ${task.id}：${task.title}${task.detail ? `；${task.detail}` : ''}${task.due ? `；截止：${task.due}` : ''}`);
      }
      return task;
    });
  }

  updateTask(owner: MemberId, taskId: string, update: TaskUpdate) {
    return this.mutex.run(async () => {
      const tasks = await this.read('tasks.json', z.array(taskSchema));
      const task = tasks.find(item => item.id === taskId);
      if (!task) throw new Error(`找不到任务 ${taskId}，请先查询任务列表。`);
      if (!update.status && !update.note) throw new Error('请提供任务状态或备注。');
      if (update.status) task.status = update.status;
      if (update.note) task.notes.push({ at: new Date().toISOString(), by: owner, text: update.note });
      task.updatedAt = new Date().toISOString();
      await this.write('tasks.json', tasks);
      if (owner !== task.creator) {
        await this.enqueue(owner, task.creator, `任务 ${task.id}「${task.title}」已更新：${task.status}${update.note ? `；${update.note}` : ''}`);
      }
      return task;
    });
  }

  logProgress(owner: MemberId, text: string) {
    return this.mutex.run(async () => {
      const records = await this.read('progress.json', z.array(progressSchema));
      const record = { id: id('P'), member: owner, date: shanghaiDate(), text, createdAt: new Date().toISOString() };
      records.push(record);
      await this.write('progress.json', records);
      return record;
    });
  }

  getProgress(member: MemberId, days: number) {
    return this.mutex.run(async () => {
      if (!Number.isSafeInteger(days) || days < 1) throw new Error('days 必须是正整数。');
      const range = recentDateRange(days);
      return {
        progress: (await this.read('progress.json', z.array(progressSchema)))
          .filter(record => record.member === member && record.date >= range.first && record.date <= range.last),
        tasks: (await this.read('tasks.json', z.array(taskSchema))).filter(task => task.assignee === member && task.status !== 'done'),
      };
    });
  }

  notifyMember(from: MemberId, to: MemberId, text: string) {
    return this.mutex.run(() => this.enqueue(from, to, text));
  }
  pendingNotifications(to: MemberId) {
    return this.mutex.run(async () => (await this.read('outbox.json', z.array(notificationSchema)))
      .filter(item => item.to === to && !item.deliveredAt));
  }
  markDelivered(notificationId: string) {
    return this.mutex.run(async () => {
      const outbox = await this.read('outbox.json', z.array(notificationSchema));
      const notification = outbox.find(item => item.id === notificationId);
      if (!notification) throw new Error('找不到通知。');
      notification.deliveredAt ??= new Date().toISOString();
      await this.write('outbox.json', outbox);
    });
  }

  getHistory(owner: MemberId) {
    return this.mutex.run(async () => {
      validateMemberId(owner);
      const history = await this.read(`history/${owner}.json`, historySchema);
      while (history[0]?.role === 'assistant') history.shift();
      return history;
    });
  }
  appendHistory(owner: MemberId, turns: HistoryTurn[]) {
    return this.mutex.run(async () => {
      validateMemberId(owner);
      const history = [
        ...await this.read(`history/${owner}.json`, historySchema), ...historySchema.parse(turns),
      ].slice(-20);
      while (history[0]?.role === 'assistant') history.shift();
      await this.write(`history/${owner}.json`, history);
    });
  }
  clearHistory(owner: MemberId) { validateMemberId(owner); return this.mutex.run(() => this.write(`history/${owner}.json`, [])); }
}
