import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Mutex } from '../mutex.js';
import { recentDateRange, shanghaiDate } from '../time.js';
import type { FeishuConfig } from '../config.js';
import { JsonStore } from './json-store.js';
import { FeishuApi } from './feishu-api.js';
import { INFO_CATEGORIES, SYSTEM_TABLES, STATUS_LABEL, TABLES } from './feishu-schema.js';
import { validateMemberId } from '../members.js';
import { KnowledgeTableError } from './types.js';
import { cellText, knowledgeCellText, memberValue, taskValue, taskFields, progressValue, progressFields,
  notificationValue, notificationFields, notesText } from './feishu-codec.js';
import type { HistoryTurn, MemberId, NewTask, Notification, Store, Task, TaskUpdate, TaskStatus } from './types.js';

const locks = new Map<string, Mutex>();
export class FeishuStore implements Store {
  readonly api: FeishuApi;
  private readonly history: JsonStore;
  private readonly mutex: Mutex;
  constructor(directory: string, config: FeishuConfig) {
    this.api = new FeishuApi(config);
    this.history = new JsonStore(directory);
    const key = `${config.appToken}:${config.tablePrefix}`;
    if (!locks.has(key)) locks.set(key, new Mutex());
    this.mutex = locks.get(key)!;
  }
  async initialize(): Promise<void> {
    // 只准备历史文件，飞书模式不创建或改写本地业务 JSON。
    const directory = join(resolve(this.history.directory), 'history');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // 结构仅由 kb.py init 维护，启动不建表、不补字段或单选选项。
    for (const table of Object.keys(TABLES)) await this.api.tableId(table);
  }
  async getMembers() {
    return (await this.api.records('成员')).flatMap(row => {
      const id = cellText(row.fields['ID']);
      if (id) validateMemberId(id);
      return id ? [{ id, name: cellText(row.fields['名称']) || id,
        aliases: cellText(row.fields['别名']).split(/[,，]/).map(text => text.trim()).filter(Boolean) }] : [];
    });
  }
  searchInfo(keyword?: string) { return this.queryKnowledge('资料', keyword); }
  private async knowledgeTables() {
    const prefix = this.api.config.tablePrefix;
    return (await this.api.listTables()).filter(table => {
      if (!table.name || !table.table_id) return false;
      if (prefix && !table.name.startsWith(prefix)) return false;
      const logical = prefix ? table.name.slice(prefix.length) : table.name;
      return !SYSTEM_TABLES.includes(logical) && logical !== '数据表' && !logical.startsWith('测试_');
    }).map(table => ({ ...table, name: prefix ? table.name!.slice(prefix.length) : table.name! }));
  }
  async listKnowledgeTables(): Promise<string[]> {
    return (await this.knowledgeTables()).map(table => table.name!);
  }
  async queryKnowledge(table: string, keyword?: string): Promise<Record<string, string>[]> {
    const tables = await this.knowledgeTables();
    const found = tables.find(item => item.name === table);
    if (!found) throw new KnowledgeTableError(table, tables.map(item => item.name!));
    const [fields, rows] = await Promise.all([
      this.api.fieldsById(found.table_id!), this.api.recordsById(found.table_id!),
    ]);
    const fieldTypes = new Map(fields.map(field => [field.field_name, field.type]));
    const needle = keyword?.toLocaleLowerCase('en-US');
    return rows.map(row => Object.fromEntries(
      [...new Set([...fieldTypes.keys(), ...Object.keys(row.fields)])].flatMap(name => name
        ? [[name, knowledgeCellText(row.fields[name], fieldTypes.get(name))]] : []),
    )).filter(row => !needle || Object.values(row).some(value => value.toLocaleLowerCase('en-US').includes(needle)));
  }
  saveInfo(title: string, content: string, category?: string) {
    return this.mutex.run(async () => {
      const fields = await this.api.fieldsById(await this.api.tableId('资料'));
      if (category) {
        const options = fields.find(field => field.field_name === '分类')?.property?.options ?? [];
        if (!INFO_CATEGORIES.includes(category as typeof INFO_CATEGORIES[number]) || !options.some(o => o.name === category)) throw new Error('分类不存在，请运行 kb.py init 补充。');
      }
      const matches = (await this.api.records('资料')).filter(row => cellText(row.fields['标题']) === title);
      if (matches.length > 1) throw new Error('资料标题重复，请先在飞书中核实。');
      const value = { 标题: title, 内容: content, ...(category ? { 分类: category } : {}),
        ...(fields.some(field => field.field_name === '更新时间') ? { 更新时间: Date.now() } : {}) };
      if (matches[0]) await this.api.update('资料', matches[0].record_id, value);
      else await this.api.create('资料', value);
      return this.searchInfo(title);
    });
  }
  async listTasks(filter: { assignee?: MemberId; status?: TaskStatus } = {}): Promise<Task[]> {
    const members = await this.getMembers();
    return (await this.api.records('任务')).flatMap(row => {
      const task = taskValue(row, members);
      return task && (!filter.assignee || task.assignee === filter.assignee) && (!filter.status || task.status === filter.status) ? [task] : [];
    });
  }
  private async enqueue(from: MemberId, to: MemberId, text: string): Promise<Notification> {
    const members = await this.getMembers();
    const row = await this.api.create('通知', notificationFields({ id: '', from, to, text, createdAt: new Date().toISOString() }, members));
    return notificationValue(row, members)!;
  }
  createTask(owner: MemberId, input: NewTask) {
    return this.mutex.run(async () => {
      const numbers = (await this.api.records('任务')).map(row => /^T-(\d+)$/.exec(cellText(row.fields['编号'])))
        .flatMap(match => match ? [Number(match[1])] : []).filter(Number.isSafeInteger);
      const max = Math.max(0, ...numbers);
      if (!Number.isSafeInteger(max + 1)) throw new Error('任务编号已超出安全范围，请检查任务表。');
      const now = new Date().toISOString();
      const task: Task = { ...input, id: `T-${String(max + 1).padStart(4, '0')}`, creator: owner,
        status: 'todo', notes: [], createdAt: now, updatedAt: now };
      await this.api.create('任务', taskFields(task, await this.getMembers()));
      if (input.assignee !== owner) await this.enqueue(owner, input.assignee,
        `新任务 ${task.id}：${task.title}${task.detail ? `；${task.detail}` : ''}${task.due ? `；截止：${task.due}` : ''}`);
      return task;
    });
  }
  updateTask(owner: MemberId, taskId: string, update: TaskUpdate) {
    return this.mutex.run(async () => {
      const row = (await this.api.records('任务')).find(row => cellText(row.fields['编号']) === taskId);
      const members = await this.getMembers();
      const task = row && taskValue(row, members);
      if (!row || !task) throw new Error(`找不到任务 ${taskId}，请先查询任务列表。`);
      if (!update.status && !update.note) throw new Error('请提供任务状态或备注。');
      const now = new Date().toISOString();
      if (update.status) task.status = update.status;
      if (update.note) task.notes.push({ at: now, by: owner, text: update.note });
      task.updatedAt = now;
      await this.api.update('任务', row.record_id, { 更新时间: Date.parse(now),
        ...(update.status ? { 状态: STATUS_LABEL[update.status] } : {}),
        // 保留飞书中无法解析的手写备注，避免追加时吞掉原文。
        ...(update.note ? { 备注: [cellText(row.fields['备注']), notesText([{ at: now, by: owner, text: update.note }], members)].filter(Boolean).join('\n') } : {}) });
      if (owner !== task.creator) await this.enqueue(owner, task.creator,
        `任务 ${task.id}「${task.title}」已更新：${task.status}${update.note ? `；${update.note}` : ''}`);
      return task;
    });
  }
  logProgress(owner: MemberId, text: string) {
    return this.mutex.run(async () => {
      const members = await this.getMembers();
      const row = await this.api.create('进度', progressFields({ id: '', member: owner, text,
        date: shanghaiDate(), createdAt: new Date().toISOString() }, members));
      return progressValue(row, members)!;
    });
  }
  async getProgress(member: MemberId, days: number) {
    if (!Number.isSafeInteger(days) || days < 1) throw new Error('days 必须是正整数。');
    const range = recentDateRange(days);
    const members = await this.getMembers();
    const progress = (await this.api.records('进度')).flatMap(row => {
      const record = progressValue(row, members);
      return record && record.member === member && record.date >= range.first && record.date <= range.last ? [record] : [];
    });
    return { progress, tasks: (await this.listTasks({ assignee: member })).filter(task => task.status !== 'done') };
  }
  notifyMember(from: MemberId, to: MemberId, text: string) { return this.mutex.run(() => this.enqueue(from, to, text)); }
  async pendingNotifications(to: MemberId) {
    const members = await this.getMembers();
    return (await this.api.records('通知')).flatMap(row => {
      const notification = notificationValue(row, members);
      return notification && notification.to === to && !notification.deliveredAt ? [notification] : [];
    });
  }
  markDelivered(id: string) {
    return this.mutex.run(async () => {
      const row = (await this.api.records('通知')).find(row => row.record_id === id);
      if (!row) throw new Error('找不到通知。');
      if (!notificationValue(row, await this.getMembers())?.deliveredAt) await this.api.update('通知', id, { 送达时间: Date.now(), 状态: '已送达' });
    });
  }
  getHistory(owner: MemberId) { return this.history.getHistory(owner); }
  appendHistory(owner: MemberId, turns: HistoryTurn[]) { return this.history.appendHistory(owner, turns); }
  clearHistory(owner: MemberId) { return this.history.clearHistory(owner); }
}
