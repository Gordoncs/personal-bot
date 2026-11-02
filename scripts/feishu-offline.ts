import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createTools } from '../src/tools.js';
import { FeishuStore } from '../src/store/feishu-store.js';
import type { Row } from '../src/store/feishu-api.js';
import { loadConfig, loadFeishuConfig } from '../src/config.js';
import { allPages, feishuRequest, FeishuApi, FeishuError } from '../src/store/feishu-api.js';
import { cellText, dateMillis, taskValue, taskFields, progressValue, notificationValue } from '../src/store/feishu-codec.js';

async function checkKnowledge(directory: string): Promise<void> {
  const store = new FeishuStore(join(directory, 'knowledge-history'), {
    appId: 'offline-id', appSecret: 'offline-secret', appToken: 'offline-token', tablePrefix: '',
  });
  const tableTokens: (string | undefined)[] = [];
  const recordTokens: (string | undefined)[] = [];
  const fieldTokens: (string | undefined)[] = [];
  store.api.client.bitable.appTable.list = async request => {
    const token = request?.params?.page_token;
    tableTokens.push(token);
    return { code: 0, data: token ? { items: [{ name: '客户', table_id: 'customers' }, { name: '产品', table_id: 'products' }], has_more: false }
      : { items: ['成员', '任务', '进度', '通知', '数据表', '测试_check_abcdef012345_成员',
        '测试_smoke_123456abcdef_任务', '测试_pb_abcdefabcdef_资料'].map(name => ({ name, table_id: name })), has_more: true, page_token: 'tables-next' } };
  };
  store.api.client.bitable.appTableField.list = async request => {
    const token = request?.params?.page_token;
    fieldTokens.push(token);
    assert.equal(request?.path.table_id, 'customers');
    return { code: 0, data: token ? { items: [{ field_name: '日期', type: 5 }, { field_name: '资料', type: 15 },
      { field_name: '富文本', type: 1 }, { field_name: '缺失字段', type: 1 }], has_more: false }
      : { items: [{ field_name: '客户', type: 1 }, { field_name: '状态', type: 3 }, { field_name: '金额', type: 2 },
        { field_name: '标签', type: 4 }], has_more: true, page_token: 'fields-next' } };
  };
  const first: Row = { record_id: 'one', fields: { 客户: [{ text: '示例' }, { text: '记录' }], 状态: '合同待寄', 金额: 3000,
    标签: ['试点', '女装'], 日期: Date.parse('2026-10-31T16:30:00Z'), 资料: { text: '合同', link: 'https://example.com/contract' },
    富文本: [{ text: '待确认：' }, { text: '日期' }] } };
  const second: Row = { record_id: 'two', fields: { 客户: 'Example-B', 状态: { name: '已接入' }, 金额: 0,
    日期: Date.parse('2026-11-01T15:59:59Z'), 富文本: [{ text: '图片' }, { text: '供应商' }] } };
  store.api.client.bitable.appTableRecord.list = async request => {
    const token = request?.params?.page_token;
    recordTokens.push(token);
    assert.equal(request?.path.table_id, 'customers');
    return { code: 0, data: token ? { items: [second], has_more: false }
      : { items: [first], has_more: true, page_token: 'records-next' } } as unknown as Awaited<ReturnType<typeof store.api.client.bitable.appTableRecord.list>>;
  };
  store.api.client.bitable.appTableRecord.create = async () => assert.fail('知识查询不应写入记录');
  store.api.client.bitable.appTableRecord.update = async () => assert.fail('知识查询不应修改记录');
  assert.deepEqual(await store.listKnowledgeTables(), ['客户', '产品']);
  assert.deepEqual(tableTokens, [undefined, 'tables-next']);
  const rows = await store.queryKnowledge('客户');
  assert.deepEqual(recordTokens, [undefined, 'records-next']);
  assert.deepEqual(fieldTokens, [undefined, 'fields-next']);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { 客户: '示例记录', 状态: '合同待寄', 金额: '3000', 标签: '试点、女装', 日期: '2026-11-01',
    资料: '合同（https://example.com/contract）', 富文本: '待确认：日期', 缺失字段: '' });
  assert.equal(rows[1]?.['金额'], '0');
  assert.equal(rows[1]?.['日期'], '2026-11-01');
  assert.deepEqual(await store.queryKnowledge('客户', 'example-b'), [rows[1]]);
  assert.deepEqual(await store.queryKnowledge('客户', '3000'), [rows[0]]);
  assert.deepEqual(await store.queryKnowledge('客户', 'CONTRACT'), [rows[0]]);
  assert.deepEqual(await store.queryKnowledge('客户', '图片供应商'), [rows[1]]);
  assert.deepEqual(await store.queryKnowledge('客户', '不存在'), []);
  for (const name of ['无此表', '成员', '测试_pb_abcdefabcdef_资料', '测试_check_abcdef012345_成员']) {
    await assert.rejects(store.queryKnowledge(name), /找不到知识表.*可用的知识表：客户、产品/);
  }
  const tools = createTools(store, 'm1');
  const error = JSON.parse(await tools.query_knowledge.run({ table: '无此表' }) as string) as { error: string };
  assert.match(error.error, /可用的知识表：客户、产品/);
  assert.deepEqual(JSON.parse(await tools.query_knowledge.run({ table: '客户', keyword: 'eXaMpLe-b' }) as string), [rows[1]]);
  first.fields.富文本 = [{ text: '长'.repeat(9000) }];
  const long = await tools.query_knowledge.run({ table: '客户' }) as string;
  assert.ok(long.length <= 8000);
  assert.match(long, /已截断.*keyword/);
  const narrowed = await tools.query_knowledge.run({ table: '客户', keyword: 'Example-B' }) as string;
  assert.deepEqual(JSON.parse(narrowed), [rows[1]]);
  store.api.listTables = async () => [{ name: '长'.repeat(9000), table_id: 'long' }];
  const longTables = await tools.list_knowledge_tables.run({}) as string;
  assert.ok(longTables.length <= 8000); assert.match(longTables, /已截断.*keyword/);
  console.log('PASS 知识表清单/字段/记录全量分页、系统/默认/测试表排除、文本/单选/数字/链接/富文本/上海日期转换、跨字段大小写过滤、中文错误、8000字符截断及关键词缩小');
}

export async function checkFeishuOffline(directory: string): Promise<void> {
  await checkKnowledge(directory);
  const scoped = new FeishuStore(join(directory, 'scoped-history'), {
    appId: 'offline-id', appSecret: 'offline-secret', appToken: 'offline-token', tablePrefix: 'scope_',
  });
  scoped.api.listTables = async () => ['资料', '联系人', 'scope_资料', 'scope_项目', 'scope_任务', 'scope_自建表']
    .map(name => ({ name, table_id: name }));
  assert.deepEqual(await scoped.listKnowledgeTables(), ['资料', '项目', '自建表']);
  scoped.api.fieldsById = async table => { assert.equal(table, 'scope_资料'); return [{ field_name: '标题', type: 1 }]; };
  scoped.api.recordsById = async table => { assert.equal(table, 'scope_资料'); return [{ record_id: 'fixture', fields: { 标题: '隔离内容' } }]; };
  assert.deepEqual(await scoped.searchInfo(), [{ 标题: '隔离内容' }]);
  await assert.rejects(scoped.queryKnowledge('联系人'), /找不到知识表/);
  const base = { OWNER: 'm1', OPENCLAW_STATE_DIR: './.tmp/wx-config', DATA_DIR: './.tmp/data-config' };
  assert.equal(loadConfig(base).store, 'json');
  assert.throws(() => loadConfig({ ...base, STORE: 'other' }), /STORE/);
  for (const missing of ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_BITABLE_APP_TOKEN']) {
    const env: NodeJS.ProcessEnv = { FEISHU_APP_ID: 'offline-id', FEISHU_APP_SECRET: 'offline-secret', FEISHU_BITABLE_APP_TOKEN: 'offline-token' };
    delete env[missing]; assert.throws(() => loadFeishuConfig(env), new RegExp(missing));
  }
  const config = loadFeishuConfig({ FEISHU_APP_ID: 'offline-id', FEISHU_APP_SECRET: 'offline-secret', FEISHU_BITABLE_APP_TOKEN: 'offline-token' });
  assert.equal(config.tablePrefix, '');
  await assert.rejects(new FeishuApi(config).cleanupTestTables(), /只允许删除/);
  const seen: (string | undefined)[] = [];
  assert.deepEqual(await allPages<number>(async token => {
    seen.push(token); return token ? { items: [3], has_more: false } : { items: [1, 2], has_more: true, page_token: 'next' };
  }), [1, 2, 3]);
  assert.deepEqual(seen, [undefined, 'next']);
  await assert.rejects(allPages(async () => ({ has_more: true, page_token: 'loop' })), /分页标记/);
  await assert.rejects(allPages(async () => undefined), /缺少数据/);
  for (const error of [{ response: { status: 429 } }, { response: { status: 503 } }, { code: 'ECONNRESET' }]) {
    let calls = 0;
    assert.equal(await feishuRequest('离线重试', async () => { if (++calls < 2) throw error; return { code: 0, data: 'ok' }; }), 'ok');
    assert.equal(calls, 2);
  }
  let exhausted = 0;
  await assert.rejects(feishuRequest('离线重试上限', async () => { exhausted++; throw { code: 'ETIMEDOUT' }; }), FeishuError);
  assert.equal(exhausted, 4);
  let attempts = 0;
  await assert.rejects(feishuRequest('离线权限错误', async () => { attempts++; throw { response: { status: 403, data: { code: 91403 } } }; }), /文档应用/);
  assert.equal(attempts, 1);
  const unknown = await feishuRequest('离线业务错误', async () => ({ code: 1254000 })).catch(error => error as Error);
  assert.ok(unknown instanceof FeishuError); assert.match(unknown.message, /1254000/);
  assert.equal(cellText([{ text: '富' }, { text: '文本' }]), '富文本');
  assert.equal(cellText({ unknown: true }), '');
  assert.equal(dateMillis('2026-11-01'), Date.parse('2026-10-31T16:00:00Z'));
  assert.throws(() => dateMillis('bad date'), /日期无效/);
  const members = [{ id: 'm1', name: '成员甲', aliases: ['甲别名'] }, { id: 'm2', name: '成员乙', aliases: ['乙别名'] }];
  const row = { record_id: 'offline-record', fields: { 编号: 'T-0001', 标题: [{ text: '手动编辑' }],
    负责人: '成员乙', 创建人: '甲别名', 状态: '已完成', 截止日期: dateMillis('2026-11-01'), 创建时间: 1, 更新时间: 2 } };
  const task = taskValue(row, members)!;
  assert.equal(task.status, 'done'); assert.equal(task.due, '2026-11-01'); assert.equal(task.title, '手动编辑');
  assert.equal(taskValue({ ...row, fields: { ...row.fields, 状态: '未知' } }, members)?.status, 'todo');
  assert.equal(taskValue({ ...row, fields: { ...row.fields, 负责人: '未知' } }, members), undefined);
  assert.equal(taskValue({ ...row, fields: { ...row.fields, 截止日期: 1e30 } }, members)?.due, undefined);
  task.notes = [{ at: '2026-11-01T00:00:00.000Z', by: 'm2', text: '备注\n第二行' }];
  const fields = taskFields(task, members);
  assert.match(String(fields['备注']), /2026-11-01T08:00:00.000\+08:00 成员乙：/);
  assert.deepEqual(taskValue({ ...row, fields }, members)?.notes, task.notes);
  assert.equal(progressValue({ record_id: 'r', fields: { 成员: '成员甲', 日期: '非法日期' } }, members), undefined);
  assert.ok(notificationValue({ record_id: 'r', fields: { 收件人: '成员甲', 发件人: '成员乙', 状态: '已送达' } }, members)?.deliveredAt);
  const remote = new FeishuStore(join(directory, 'unused-history'), config);
  remote.api.listTables = async () => { throw new FeishuError('读取记录', 91403, 403); };
  const output = await createTools(remote, 'm1').search_info.run({});
  assert.match(JSON.parse(output as string).error, /文档应用/);
  // 防止业务写入隐式创建单选项。
  const api = new FeishuApi(config);
  api.tableId = async () => 'offline-table';
  api.fieldsById = async () => [{ field_name: '负责人', type: 3, property: { options: [{ name: '成员甲' }] } }];
  api.client.bitable.appTableRecord.create = async () => assert.fail('非法单选不应写入');
  await assert.rejects(api.create('任务', { 负责人: '未知' }), /不添加选项/);
  console.log('PASS 飞书配置、分页、退避重试、权限脱敏、动态成员编解码、单选选项保护');
}
