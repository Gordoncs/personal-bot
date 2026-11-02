import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import * as lark from '@larksuiteoapi/node-sdk';
import type { FeishuConfig } from '../config.js';
import { TABLES, type TableName } from './feishu-schema.js';

export interface Row { record_id: string; fields: Record<string, unknown> }
export type WriteFields = Record<string, string | number>;
interface Page<T> { items?: T[]; has_more?: boolean; page_token?: string }
interface Response<T> { code?: number; data?: T }

/** 不保留原始 HTTP 错误（其中可能包含认证请求和 token）。 */
export class FeishuError extends Error {
  constructor(operation: string, readonly apiCode?: number, readonly httpStatus?: number) {
    const hint = httpStatus === 401 || apiCode === 99991663 || apiCode === 99991664
      ? '请检查应用凭证和应用发布状态。'
      : httpStatus === 403 || apiCode === 91403 || apiCode === 99991672
        ? '请检查多维表格权限，并把应用添加为文档应用。'
        : '请检查应用权限、表结构和网络后重试。';
    super(`飞书${operation}失败${apiCode ? `（错误码 ${apiCode}）` : ''}${httpStatus ? `（HTTP ${httpStatus}）` : ''}，${hint}`);
  }
}

export async function feishuRequest<T>(operation: string, call: () => Promise<Response<T>>): Promise<T | undefined> {
  for (let attempt = 0; ; attempt++) {
    let status: number | undefined;
    let code: number | undefined;
    let retry = false;
    try {
      const response = await call();
      code = response.code;
      if (code === 0) return response.data;
      retry = code === 99991400 || code === 99991401 || code === 1254290 || code === 1255040 || code === 1255001;
    } catch (error) {
      const failure = error as { response?: { status?: number; data?: { code?: number } }; code?: string };
      status = failure?.response?.status;
      code = failure?.response?.data?.code;
      retry = status === 429 || (status !== undefined && status >= 500 && status <= 599)
        || (status === undefined && ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_NETWORK', 'EPIPE'].includes(failure?.code ?? ''));
    }
    if (!retry || attempt >= 3) throw new FeishuError(operation, code, status);
    await delay(300 * 2 ** attempt + Math.floor(Math.random() * 100));
  }
}

export async function allPages<T>(fetchPage: (token?: string) => Promise<Page<T> | undefined>): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let token: string | undefined;
  do {
    const page = await fetchPage(token);
    if (!page) throw new Error('飞书分页响应缺少数据，请稍后重试。');
    items.push(...page.items ?? []);
    if (!page.has_more) break;
    token = page.page_token;
    if (!token || seen.has(token)) throw new Error('飞书分页标记无效，请稍后重试。');
    seen.add(token);
  } while (true);
  return items;
}

export class FeishuApi {
  readonly client: lark.Client;
  private readonly ids = new Map<TableName, string>();
  constructor(readonly config: FeishuConfig) {
    // 使用空 logger，包含获取 tenant_access_token 的 SDK 内部日志也不能输出凭证。
    const noop = () => {};
    this.client = new lark.Client({ appId: config.appId, appSecret: config.appSecret, appType: lark.AppType.SelfBuild,
      domain: lark.Domain.Feishu, logger: { error: noop, warn: noop, info: noop, debug: noop, trace: noop } });
  }
  private get path() { return { app_token: this.config.appToken }; }
  name(table: TableName) { return `${this.config.tablePrefix}${table}`; }

  listTables() {
    return allPages(token => feishuRequest('列出数据表', () => this.client.bitable.appTable.list({
      path: this.path, params: { page_size: 100, page_token: token },
    })));
  }
  async tableId(table: TableName): Promise<string> {
    const cached = this.ids.get(table);
    if (cached) return cached;
    const found = (await this.listTables()).find(item => item.name === this.name(table));
    if (!found?.table_id) throw new Error(`飞书缺少数据表「${this.name(table)}」，请先运行 python3 knowledge-base/kb.py init --name 你的称呼。`);
    this.ids.set(table, found.table_id);
    return found.table_id;
  }
  async records(table: TableName): Promise<Row[]> {
    const table_id = await this.tableId(table);
    return this.recordsById(table_id);
  }
  fieldsById(table_id: string) {
    return allPages(token => feishuRequest('列出字段', () => this.client.bitable.appTableField.list({
      path: { ...this.path, table_id }, params: { page_size: 100, page_token: token },
    })));
  }
  async recordsById(table_id: string): Promise<Row[]> {
    const records = await allPages(token => feishuRequest('读取记录', () => this.client.bitable.appTableRecord.list({
      path: { ...this.path, table_id }, params: { page_size: 500, page_token: token, automatic_fields: true },
    })));
    return records.flatMap(row => row.record_id ? [{ record_id: row.record_id, fields: row.fields }] : []);
  }
  async create(table: TableName, fields: WriteFields): Promise<Row> {
    const table_id = await this.tableId(table);
    await this.validateSelects(table_id, fields);
    const client_token = randomUUID();
    const data = await feishuRequest('新增记录', () => this.client.bitable.appTableRecord.create({
      path: { ...this.path, table_id }, data: { fields }, params: { client_token },
    }));
    if (!data?.record?.record_id) throw new Error('飞书新增记录响应无效，请重新查询数据。');
    return { record_id: data.record.record_id, fields: data.record.fields };
  }
  async update(table: TableName, record_id: string, fields: Record<string, string | number | null>): Promise<void> {
    const table_id = await this.tableId(table);
    await this.validateSelects(table_id, fields);
    await feishuRequest('更新记录', () => this.client.bitable.appTableRecord.update({
      // 飞书支持用 null 清空字段，SDK 1.76.0 的字段联合类型尚未包含 null。
      path: { ...this.path, table_id, record_id }, data: { fields: fields as WriteFields },
    }));
  }
  /** 飞书写入陌生单选值可能隐式加选项，业务路径必须在写入前拒绝。 */
  private async validateSelects(tableId: string, values: Record<string, unknown>): Promise<void> {
    const fields = await this.fieldsById(tableId);
    for (const [name, value] of Object.entries(values)) {
      const field = fields.find(field => field.field_name === name);
      if (!field) throw new Error('缺少字段，请先运行 kb.py doctor 和 init。');
      if (field.type === 3 && value !== null && !field.property?.options?.some(option => option.name === value)) {
        throw new Error('缺少单选选项，请先运行 kb.py init；业务命令不添加选项。');
      }
    }
  }
  /** 只接受本次随机生成的测试前缀；业务代码没有任意删表入口。 */
  async cleanupTestTables(): Promise<void> {
    const prefix = this.config.tablePrefix;
    if (!/^测试_pb_[0-9a-f]{12}_$/.test(prefix)) throw new Error('拒绝清理：只允许删除随机测试前缀的表。');
    const names = new Set((Object.keys(TABLES) as TableName[]).map(table => this.name(table)));
    const tables = await this.listTables();
    const failures: Error[] = [];
    for (const table of tables) {
      if (!table.name || !table.table_id || !names.has(table.name)) continue;
      try {
        await feishuRequest('清理测试表', () => this.client.bitable.appTable.delete({ path: { ...this.path, table_id: table.table_id! } }));
        console.log(`已清理：${table.name}`);
      } catch (error) { failures.push(error as Error); }
    }
    this.ids.clear();
    if (failures.length) throw new Error(`测试表清理失败：${failures.map(error => error.message).join('；')}`);
    if ((await this.listTables()).some(table => table.name && names.has(table.name))) throw new Error('测试表仍有残留，请检查清理权限。');
  }
}
