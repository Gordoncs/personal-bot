import { readFileSync } from 'node:fs';
import type { TaskStatus } from './types.js';

export interface FieldSpec {
  field_name: string;
  type: number;
  member_options?: boolean;
  property?: { options?: { name: string; id?: string; color?: number }[]; date_formatter?: string; auto_fill?: boolean };
}
/** Python CLI 与 BOT 直接读取同一份模板，避免两份定义漂移。 */
export const TABLES = JSON.parse(readFileSync(new URL('../../knowledge-base/schema.json', import.meta.url), 'utf8')) as Record<string, FieldSpec[]>;
export type TableName = string;
export const SYSTEM_TABLES = ['成员', '任务', '进度', '通知'];
export const INFO_CATEGORIES = ['个人信息', '工作', '学习', '生活', '其他'] as const;
export const STATUS_LABEL: Record<TaskStatus, string> = { todo: '待办', doing: '进行中', done: '已完成', blocked: '受阻' };
