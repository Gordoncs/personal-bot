import { shanghaiDate } from '../time.js';
import type { Member, MemberId, Notification, Progress, Task, TaskStatus } from './types.js';
import type { Row, WriteFields } from './feishu-api.js';
import { resolveMember } from '../members.js';
import { STATUS_LABEL } from './feishu-schema.js';

/** 文本字段可能返回纯文本或富文本数组；未知值视为空。 */
export function cellText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(cellText).join('');
  if (value && typeof value === 'object' && 'text' in value) return cellText(value.text);
  return '';
}

/** 知识字段依照字段类型解码；金额等普通数字不能按时间戳猜测。 */
export function knowledgeCellText(value: unknown, fieldType?: number): string {
  if (value === null || value === undefined) return '';
  if ([5, 1001, 1002].includes(fieldType ?? 0)) {
    const iso = isoValue(value);
    if (iso) return shanghaiDate(new Date(iso));
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const richText = value.every(item => item && typeof item === 'object' && 'text' in item);
    return value.map(item => knowledgeCellText(item)).join(richText ? '' : '、');
  }
  if (typeof value === 'object') {
    const cell = value as Record<string, unknown>;
    const label = knowledgeCellText(cell.text ?? cell.name);
    const url = knowledgeCellText(cell.link ?? cell.url);
    if (url) return label && label !== url ? `${label}（${url}）` : url;
    if (label) return label;
    if ('value' in cell) return knowledgeCellText(cell.value, fieldType);
  }
  return '';
}
export function memberValue(value: unknown, members: Member[]): MemberId | undefined {
  return resolveMember(cellText(value), members)?.id;
}
function memberLabel(id: MemberId, members: Member[]): string {
  const member = members.find(member => member.id === id);
  if (!member) throw new Error('成员不存在，请核实成员表。');
  return member.name;
}
export function statusValue(value: unknown): TaskStatus {
  const text = cellText(value);
  return (Object.keys(STATUS_LABEL) as TaskStatus[]).find(key => key === text || STATUS_LABEL[key] === text) ?? 'todo';
}
export function dateMillis(value: string): number {
  const timestamp = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00+08:00` : value);
  if (!Number.isFinite(timestamp)) throw new Error('日期无效，请使用有效的上海日期或 ISO 时间。');
  return timestamp;
}
export function isoValue(value: unknown): string | undefined {
  const timestamp = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(timestamp) || Math.abs(timestamp) > 8.64e15) return undefined;
  return new Date(timestamp).toISOString();
}
function dayValue(value: unknown): string | undefined {
  const iso = isoValue(value);
  return iso ? shanghaiDate(new Date(iso)) : undefined;
}
const EPOCH = new Date(0).toISOString();
export function notesText(notes: Task['notes'], members: Member[]): string {
  return notes.map(note => `${new Date(dateMillis(note.at) + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00')} ${memberLabel(note.by, members)}：${note.text}`).join('\n');
}
function parseNotes(text: string, members: Member[]): Task['notes'] {
  const notes: Task['notes'] = [];
  for (const line of text.split('\n')) {
    const match = /^(\S+) (.+?)：(.*)$/.exec(line);
    const by = match && memberValue(match[2], members);
    const timestamp = match && Date.parse(match[1]!);
    if (match && by && Number.isFinite(timestamp)) notes.push({ at: new Date(timestamp as number).toISOString(), by, text: match[3]! });
    else if (notes.length) notes[notes.length - 1]!.text += `\n${line}`;
  }
  return notes;
}
export function taskValue(row: Row, members: Member[]): Task | undefined {
  const f = row.fields;
  const id = cellText(f['编号']);
  const assignee = memberValue(f['负责人'], members);
  const creator = memberValue(f['创建人'], members);
  if (!id || !assignee || !creator) return undefined;
  return { id, title: cellText(f['标题']), detail: cellText(f['详情']) || undefined, assignee, creator,
    status: statusValue(f['状态']), due: dayValue(f['截止日期']), notes: parseNotes(cellText(f['备注']), members),
    createdAt: isoValue(f['创建时间']) ?? EPOCH, updatedAt: isoValue(f['更新时间']) ?? EPOCH };
}
export function taskFields(task: Task, members: Member[]): WriteFields {
  return { 编号: task.id, 标题: task.title, 详情: task.detail ?? '', 负责人: memberLabel(task.assignee, members),
    创建人: memberLabel(task.creator, members), 状态: STATUS_LABEL[task.status], 备注: notesText(task.notes, members),
    创建时间: dateMillis(task.createdAt), 更新时间: dateMillis(task.updatedAt),
    ...(task.due ? { 截止日期: dateMillis(task.due) } : {}) };
}
export function progressValue(row: Row, members: Member[]): Progress | undefined {
  const f = row.fields;
  const member = memberValue(f['成员'], members);
  const date = dayValue(f['日期']);
  if (!member || !date) return undefined;
  return { id: row.record_id, member, date, text: cellText(f['内容']), createdAt: isoValue(f['记录时间']) ?? EPOCH };
}
export function progressFields(record: Progress, members: Member[]): WriteFields {
  return { 成员: memberLabel(record.member, members), 日期: dateMillis(record.date), 内容: record.text, 记录时间: dateMillis(record.createdAt) };
}
export function notificationValue(row: Row, members: Member[]): Notification | undefined {
  const f = row.fields;
  const to = memberValue(f['收件人'], members);
  const from = memberValue(f['发件人'], members);
  if (!to || !from) return undefined;
  const createdAt = isoValue(f['创建时间']) ?? EPOCH;
  const deliveredAt = isoValue(f['送达时间']) ?? (cellText(f['状态']) === '已送达' ? createdAt : undefined);
  return { id: row.record_id, to, from, text: cellText(f['内容']), createdAt, deliveredAt };
}
export function notificationFields(record: Notification, members: Member[]): WriteFields {
  return { 收件人: memberLabel(record.to, members), 发件人: memberLabel(record.from, members), 内容: record.text,
    创建时间: dateMillis(record.createdAt), 状态: record.deliveredAt ? '已送达' : '待发送',
    ...(record.deliveredAt ? { 送达时间: dateMillis(record.deliveredAt) } : {}) };
}
