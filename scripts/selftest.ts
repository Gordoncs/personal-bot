import assert from 'node:assert/strict';
import { checkFeishuOffline } from './feishu-offline.js';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { JsonStore } from '../src/store/json-store.js';
import { readOnlyStore } from '../src/store/read-only-store.js';
import type { Notification, Progress, Task } from '../src/store/types.js';
import { createTools } from '../src/tools.js';
import { Brain, friendlyError } from '../src/brain.js';
import { initializeStore } from '../src/store/create-store.js';
import { spawnSync } from 'node:child_process';
import { TABLES } from '../src/store/feishu-schema.js';
import { loadConfig } from '../src/config.js';
import { deliverOutbox } from '../src/outbox.js';
import { recentDateRange, shanghaiDate } from '../src/time.js';
import Anthropic from '@anthropic-ai/sdk';

async function result<T>(pending: unknown): Promise<T> {
  const output = await pending;
  assert.equal(typeof output, 'string');
  return JSON.parse(output as string) as T;
}

async function checkProviderRequests(directory: string): Promise<void> {
  const base = { OWNER: 'm1', OPENCLAW_STATE_DIR: join(directory, 'wx-config'), DATA_DIR: join(directory, 'config-store') };
  assert.equal(loadConfig(base).model, 'deepseek-flash');
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    assert.equal(loadConfig({ ...base, LLM_MODEL: 'claude-test', CLAUDE_EFFORT: effort }).effort, effort);
  }
  assert.equal(loadConfig({ ...base, LLM_MODEL: 'deepseek-flash', CLAUDE_EFFORT: 'medium' }).effort, 'low');
  assert.throws(() => loadConfig({ ...base, LLM_MODEL: 'deepseek-flash', CLAUDE_EFFORT: 'xhigh' }), /兼容模型/);
  assert.throws(() => loadConfig({ ...base, LLM_THINKING: 'adaptive' }), /LLM_THINKING/);
  const cases = [
    { model: 'claude-opus-5-5', baseURL: 'https://api.anthropic.com', native: true },
    { model: 'claude-opus-5-5', baseURL: 'https://api.deepseek.com/anthropic', native: false },
    { model: 'deepseek-flash', baseURL: 'https://api.anthropic.com', native: false },
    { model: 'deepseek-flash', baseURL: 'https://api.deepseek.com/anthropic', native: false, thinking: 'disabled' },
    { model: 'deepseek-flash', baseURL: 'https://api.deepseek.com/anthropic', native: false, thinking: 'enabled' },
  ];
  for (const [index, test] of cases.entries()) {
    const store = new JsonStore(join(directory, `provider-${index}`));
    await store.initialize();
    const config = loadConfig({ ...base, DATA_DIR: store.directory, LLM_MODEL: test.model, LLM_THINKING: test.thinking });
    const bodies: Anthropic.Beta.MessageCreateParamsNonStreaming[] = [];
    const content = [
      { type: 'thinking', thinking: 'offline thought', signature: 'offline-signature' },
      { type: 'tool_use', id: 'offline-tool', name: 'search_info', input: {} },
    ];
    let failure: unknown;
    const client = new Anthropic({ apiKey: 'offline-placeholder', baseURL: test.baseURL, logLevel: 'off', maxRetries: 0,
      fetch: async (url, init) => {
        assert.equal(String(url), `${test.baseURL}/v1/messages`);
        const body = JSON.parse(String(init?.body)) as Anthropic.Beta.MessageCreateParamsNonStreaming;
        bodies.push(body);
        if (bodies.length === 1) {
          assert.equal(body.model, test.model);
          assert.equal(body.fallbacks, test.native ? 'default' : undefined);
          assert.equal(body.thinking?.type, test.thinking);
          assert.equal('thinking' in body, test.thinking !== undefined);
          assert.deepEqual(body.tool_choice, { type: 'auto' });
          assert.equal(new Headers(init?.headers).get('anthropic-beta')?.includes('server-side-fallback-2026-07-01') ?? false, test.native);
        }
        if (!test.native) {
          assert.ok(!('thread' in body));
          assert.equal(new Headers(init?.headers).get('anthropic-beta'), null);
          assert.equal(body.tools?.length, 10);
        }
        assert.ok(body.tools?.every(tool => !('type' in tool)) ?? test.native);
        if (bodies.length === 2 && !test.native) {
          assert.deepEqual(body.messages.find(message => message.role === 'assistant')?.content, content);
          assert.match(JSON.stringify(body.messages.at(-1)), /欢迎使用/);
        }
        assert.ok(bodies.length <= 2);
        return new Response(JSON.stringify({ id: `offline-${bodies.length}`, type: 'message', role: 'assistant', model: test.model,
          content: bodies.length === 1 ? content : [{ type: 'text', text: '离线回复' }],
          stop_reason: bodies.length === 1 ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
        }), { headers: { 'content-type': 'application/json' } });
      },
    });
    const brain = new Brain(config, store, { client, onError: error => { failure = error; } });
    assert.equal((await brain.chat({ conversationId: 'offline', text: '发票抬头是什么' })).text, '离线回复');
    if (failure) throw failure;
    assert.equal(bodies.length, 2);
    assert.deepEqual(await store.getHistory('m1'), [
      { role: 'user', content: '发票抬头是什么' }, { role: 'assistant', content: '离线回复' },
    ]);
  }
  console.log('PASS 模型配置、分服务商effort、thinking校验、请求URL、工具无type、beta与fallback条件、完整thinking续轮');
}

async function checkDynamicMembers(directory: string): Promise<void> {
  const store = new JsonStore(join(directory, 'dynamic-members'));
  await store.initialize();
  const members = [
    { id: 'alpha', name: '成员甲', aliases: ['甲别名', '成员甲'] },
    { id: 'writer_2', name: '成员乙', aliases: ['乙别名', '成员乙', '别称乙'] },
  ];
  const saveMembers = () => writeFile(join(store.directory, 'members.json'), JSON.stringify(members));
  await saveMembers();
  const prompts: string[] = [];
  const client = new Anthropic({ apiKey: 'offline-placeholder', logLevel: 'off', maxRetries: 0,
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { system: string };
      prompts.push(body.system);
      return new Response(JSON.stringify({ id: 'dynamic-members', type: 'message', role: 'assistant', model: 'offline',
        content: [{ type: 'text', text: '成员已读取' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { 'content-type': 'application/json' } });
    },
  });
  const config = loadConfig({ OWNER: 'alpha', BOT_NAME: '测试助手', OPENCLAW_STATE_DIR: join(directory, 'dynamic-wx'), DATA_DIR: store.directory });
  const brain = new Brain(config, store, { client, onError: error => { throw error; } });
  assert.equal((await brain.chat({ conversationId: 'members', text: '你好' })).text, '成员已读取');
  assert.match(prompts[0]!, /你是测试助手/);
  assert.match(prompts[0]!, /当前对话对象是 成员甲（ID alpha）/);
  assert.match(prompts[0]!, /别名：甲别名、成员甲/);
  assert.match(prompts[0]!, /成员乙（ID writer_2；别名：乙别名、成员乙、别称乙）/);
  assert.match(prompts[0]!, /待确认.*待填写.*不要猜/);
  members[0]!.name = '新名称'; members[0]!.aliases = ['新别名'];
  await saveMembers();
  await brain.chat({ conversationId: 'members', text: '再查一次' });
  assert.match(prompts[1]!, /当前对话对象是 新名称（ID alpha）/);
  assert.ok(!prompts[1]!.includes('成员甲'));
  const tools = createTools(store, 'alpha');
  const unknown = await result<{ error: string }>(tools.list_tasks.run({ assignee: '不存在' }));
  assert.match(unknown.error, /新名称（ID alpha；别名：新别名）/);
  assert.match(unknown.error, /成员乙.*乙别名/);
  assert.deepEqual(await result(tools.list_tasks.run({ assignee: '新别名' })), []);
  assert.deepEqual(await result(tools.list_tasks.run({ assignee: '乙别名' })), []);
  const guarded = readOnlyStore(store);
  const before = await store.searchInfo();
  await assert.rejects(guarded.saveInfo('测试', '禁止'), /只读/);
  await assert.rejects(guarded.createTask('m1', { title: '禁止', assignee: 'm1' }), /只读/);
  await assert.rejects(guarded.updateTask('m1', 'missing', { status: 'done' }), /只读/);
  await assert.rejects(guarded.logProgress('m1', '禁止'), /只读/);
  await assert.rejects(guarded.notifyMember('m1', 'm2', '禁止'), /只读/);
  await assert.rejects(guarded.markDelivered('missing'), /只读/);
  assert.deepEqual(await guarded.searchInfo(), before);
  assert.deepEqual(await store.listTasks(), []);
  console.log('PASS 成员名称/别名动态注入提示、同一 Brain 每轮刷新、未知成员动态报错、ask 六种业务写入拦截');
}

async function main(): Promise<void> {
  // 所有临时数据限定在项目内，既不加载 .env，也不依赖 key 或网络。
  await mkdir(resolve('.tmp'), { recursive: true });
  const directory = await mkdtemp(resolve('.tmp/selftest-'));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('离线自测禁止网络请求'); };
  try {
    const store = new JsonStore(join(directory, 'store'));
    await Promise.all([store.initialize(), new JsonStore(store.directory).initialize()]);
    const primary = createTools(store, 'm1');
    const m2 = createTools(new JsonStore(store.directory), 'm2');
    assert.deepEqual(await store.getMembers(), [{ id: 'm1', name: '我', aliases: [] }]);
    const configDefault = loadConfig({ OPENCLAW_STATE_DIR: join(directory, 'default-wx'), DATA_DIR: store.directory });
    await initializeStore(configDefault, store);
    assert.equal(configDefault.owner, 'm1');
    await assert.rejects(initializeStore({ ...configDefault, owner: 'unknown' }, store), /OWNER/);
    const single = await result<Task>(primary.create_task.run({ title: '单人默认任务' }));
    assert.equal(single.assignee, 'm1');
    assert.deepEqual(await store.pendingNotifications('m1'), []);
    const members = [{ id: 'm1', name: '我', aliases: [] }, { id: 'm2', name: '成员乙', aliases: ['乙别名', 'M2'] }];
    await writeFile(join(store.directory, 'members.json'), JSON.stringify(members));
    assert.match((await result<{ error: string }>(primary.create_task.run({ title: '多人不猜负责人' }))).error, /无法识别成员/);
    assert.deepEqual(await store.listKnowledgeTables(), ['资料']);
    assert.deepEqual(await result(primary.list_knowledge_tables.run({})), ['资料']);
    await assert.rejects(store.queryKnowledge('未知表'), /找不到知识表/);
    await primary.save_info.run({ title: '测试资料', content: '自测内容', 分类: '工作' });
    await primary.save_info.run({ title: '测试资料', content: '更新内容' });
    const info = await result<Record<string, string>[]>(m2.search_info.run({ keyword: '更新内容' }));
    assert.equal(info.length, 1); assert.equal(info[0]?.['分类'], '工作');
    await store.initialize();
    assert.equal((await store.searchInfo('测试资料')).length, 1);
    console.log('PASS 动态单人成员、默认 OWNER、未知 OWNER 拒绝、自派无通知、多人负责人必填、资料 upsert 和分类保留');

    const task = await result<Task>(primary.create_task.run({ title: '测试派任务', assignee: '成员乙', detail: '自测详情', due: '2026-11-30' }));
    assert.equal(task.creator, 'm1');
    assert.equal(task.assignee, 'm2');
    assert.equal(task.status, 'todo');
    assert.equal(task.due, '2026-11-30');
    assert.equal((await store.pendingNotifications('m2')).length, 1);
    assert.match((await store.pendingNotifications('m2'))[0]!.text, new RegExp(task.id));
    assert.equal((await result<Task[]>(m2.list_tasks.run({ assignee: '成员乙', status: 'todo' })))[0]?.id, task.id);
    const updated = await result<Task>(m2.update_task.run({ id: task.id, status: 'doing', note: '已经开始' }));
    assert.equal(updated.status, 'doing');
    assert.equal(updated.notes[0]?.by, 'm2');
    assert.equal((await store.pendingNotifications('m1')).length, 1);
    assert.match((await store.pendingNotifications('m1'))[0]!.text, /已经开始/);
    await primary.update_task.run({ id: task.id, note: '创建者补充' });
    assert.equal((await store.pendingNotifications('m1')).length, 1);
    const selfTask = await result<Task>(primary.create_task.run({ title: '自己待办', assignee: 'm1' }));
    assert.equal(selfTask.assignee, 'm1');
    assert.equal((await store.pendingNotifications('m2')).length, 1);
    console.log('PASS 建任务通知、更新通知、本人操作不重复通知、成员别名');

    const progress = await result<Progress>(m2.log_progress.run({ text: '今天完成自测准备' }));
    assert.equal(progress.member, 'm2');
    assert.equal(progress.date, shanghaiDate());
    const summary = await result<{ progress: Progress[]; tasks: Task[] }>(primary.get_progress.run(primary.get_progress.parse({ member: '乙别名' })));
    assert.equal(summary.progress[0]?.id, progress.id);
    assert.equal(summary.tasks[0]?.id, task.id);
    await m2.update_task.run({ id: task.id, status: 'done' });
    const done = await result<{ progress: Progress[]; tasks: Task[] }>(primary.get_progress.run({ member: 'M2', days: 3 }));
    assert.equal(done.tasks.length, 0);
    assert.equal(shanghaiDate(new Date('2026-10-31T16:01:00Z')), '2026-11-01');
    assert.deepEqual(recentDateRange(3, new Date('2026-10-31T16:01:00Z')), { first: '2026-10-30', last: '2026-11-01' });
    console.log('PASS 今日进度、默认三天、未完成任务、上海跨日');

    assert.match((await result<{ error: string }>(primary.notify_member.run({ to: '陌生人', text: '测试' }))).error, /无法识别成员/);
    assert.match((await result<{ error: string }>(primary.create_task.run({ title: '未知成员任务', assignee: '陌生人' }))).error, /无法识别成员/);
    assert.match((await result<{ error: string }>(primary.update_task.run({ id: 'T-missing', status: 'done' }))).error, /找不到任务/);
    assert.match((await result<{ error: string }>(primary.update_task.run({ id: selfTask.id }))).error, /请提供/);
    assert.match((await result<{ error: string }>(primary.get_progress.run({ member: 'm1', days: 0 }))).error, /参数无效/);
    console.log('PASS 未知成员、无效任务和参数返回可追问错误');

    await primary.notify_member.run({ to: '成员乙', text: '请查看任务' });
    const pendingBefore = await store.pendingNotifications('m2');
    const warnings: string[] = [];
    await deliverOutbox(store, 'm2', { sendMessage: async () => { throw new Error('no context token'); } }, warning => warnings.push(warning));
    assert.equal(warnings.length, pendingBefore.length);
    assert.equal((await store.pendingNotifications('m2')).length, pendingBefore.length);
    const sent: string[] = [];
    await deliverOutbox(store, 'm2', { sendMessage: async text => { sent.push(text); } });
    assert.ok(sent.every(text => text.startsWith('📌 来自 我：')));
    assert.equal((await store.pendingNotifications('m2')).length, 0);
    const outbox = JSON.parse(await readFile(join(store.directory, 'outbox.json'), 'utf8')) as Notification[];
    assert.ok(outbox.filter(item => item.to === 'm2').every(item => Boolean(item.deliveredAt)));
    await deliverOutbox(store, 'm2', { sendMessage: async () => { assert.fail('已送达通知不应再次推送'); } });
    console.log('PASS 通知失败保留、重试成功才确认、不重复推送');

    await Promise.all(Array.from({ length: 12 }, (_, index) =>
      new JsonStore(store.directory).saveInfo(`并发${index}`, String(index))));
    const reread = await new JsonStore(store.directory).searchInfo('并发');
    assert.equal(reread.length, 12);
    assert.ok(!(await readdir(store.directory)).some(file => file.endsWith('.tmp')));
    console.log('PASS 原子写入回读、进程内串行、无临时残留');

    const config = loadConfig({ OWNER: 'm1', OPENCLAW_STATE_DIR: join(directory, 'wx-m1'), DATA_DIR: store.directory });
    const brain = new Brain(config, store);
    await store.appendHistory('m2', [{ role: 'user', content: '成员乙历史' }]);
    await store.appendHistory('m1', Array.from({ length: 26 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `消息${index}` })));
    assert.equal((await store.getHistory('m1')).length, 20);
    assert.equal((await store.getHistory('m1'))[0]?.content, '消息6');
    assert.equal((await brain.chat({ conversationId: 'test', text: '/whoami' })).text, 'm1');
    assert.match((await brain.chat({ conversationId: 'test', text: '/help' })).text!, /查询成员进度/);
    assert.equal((await brain.chat({ conversationId: 'test', text: '', media: { type: 'image', filePath: '/unused', mimeType: 'image/png' } })).text, '暂时只支持文字');
    assert.equal((await store.getHistory('m1')).length, 20);
    await brain.chat({ conversationId: 'test', text: '/reset' });
    assert.deepEqual(await store.getHistory('m1'), []);
    assert.equal((await store.getHistory('m2')).length, 1);
    assert.equal((await store.listTasks()).length, 3);
    console.log('PASS 历史保留20条、按用户隔离、命令和媒体不调用模型、reset保留业务数据');

    for (let index = 0; index < 25; index++) {
      await store.appendHistory('m1', [{ role: 'user', content: `问题${index}` }]);
      await store.appendHistory('m1', [{ role: 'assistant', content: `回答${index}` }]);
    }
    await store.appendHistory('m1', [{ role: 'user', content: '下一轮问题' }]);
    const history = await store.getHistory('m1');
    assert.equal(history[0]?.role, 'user');
    assert.ok(history.length <= 20);
    assert.deepEqual(JSON.parse(await readFile(join(store.directory, 'history/m1.json'), 'utf8')), history);
    const legacyHistory = [
      { role: 'assistant', content: '旧回答1' },
      { role: 'assistant', content: '旧回答2' },
      { role: 'user', content: '旧问题' },
      { role: 'assistant', content: '旧回答3' },
    ];
    await writeFile(join(store.directory, 'history/m1.json'), JSON.stringify(legacyHistory));
    assert.deepEqual(await store.getHistory('m1'), legacyHistory.slice(2));
    await writeFile(join(store.directory, 'history/m1.json'), JSON.stringify(legacyHistory.slice(0, 2)));
    assert.deepEqual(await store.getHistory('m1'), []);
    console.log('PASS 连续25轮后追加user仍以user开头且不超过20条、旧历史丢弃开头连续assistant');

    assert.throws(() => loadConfig({ OWNER: 'm1' }), /OPENCLAW_STATE_DIR/);
    assert.throws(() => loadConfig({ OWNER: 'm1', OPENCLAW_STATE_DIR: join(homedir(), '.openclaw') }), /不能指向/);
    assert.throws(() => loadConfig({ OWNER: 'm1', OPENCLAW_STATE_DIR: join(directory, 'wx'), DATA_DIR: join(homedir(), '.openclaw', 'store') }), /不能指向/);
    const aliasPath = join(directory, 'alias-store');
    await symlink(store.directory, aliasPath);
    assert.throws(() => loadConfig({ OWNER: 'm1', OPENCLAW_STATE_DIR: aliasPath, DATA_DIR: store.directory }), /互不嵌套/);
    assert.throws(() => loadConfig({ OWNER: 'm1', OPENCLAW_STATE_DIR: join(directory, 'wx'), OUTBOX_POLL_SECONDS: '0' }), /正数/);
    assert.match(friendlyError(new Anthropic.RateLimitError(429, undefined, 'rate', new Headers())), /请求有点多/);
    assert.match(friendlyError(new Anthropic.APIConnectionError({ message: 'test' })), /连不上/);
    assert.match(friendlyError(new Anthropic.APIError(500, undefined, 'test', new Headers())), /暂时不可用/);
    console.log('PASS 凭证路径保护、符号链接目录冲突、配置验证、SDK具体错误分类');
    const python = spawnSync('python3', ['-I', '-c', "import importlib.util,json; s=importlib.util.spec_from_file_location('kb','knowledge-base/kb.py'); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(json.dumps(m.TEMPLATE,ensure_ascii=False))"], { encoding: 'utf8' });
    assert.equal(python.status, 0, python.stderr);
    assert.deepEqual(TABLES, JSON.parse(python.stdout));
    console.log('PASS Python 与 TypeScript 实际加载的 schema 完全一致');
    await checkProviderRequests(directory);
    await checkDynamicMembers(directory);
    await checkFeishuOffline(directory);
    console.log('SELFTEST OK');
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error('SELFTEST FAILED', error);
  process.exitCode = 1;
});
