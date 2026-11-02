import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createTools } from '../src/tools.js';
import { FeishuStore } from '../src/store/feishu-store.js';
import { cellText } from '../src/store/feishu-codec.js';
import { deliverOutbox } from '../src/outbox.js';
import { shanghaiDate } from '../src/time.js';
import { testStore, withFeishuTest } from './feishu-test-scope.js';
import type { Task, Progress } from '../src/store/types.js';

async function result<T>(pending: unknown): Promise<T> { return JSON.parse(await pending as string) as T; }
async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'personal-bot-check-'));
  try {
    const config = loadConfig({ ...process.env, STORE: 'feishu', OWNER: 'm1',
      OPENCLAW_STATE_DIR: join(directory, 'wx-unused'), DATA_DIR: join(directory, 'store') });
    const store = testStore(config, 'check');
    await withFeishuTest(store, async () => {
      const list = store.api.client.bitable.appTableRecord.list;
      store.api.client.bitable.appTableRecord.list = (payload, options) => list({
        ...payload!, params: { ...payload?.params, page_size: 2 },
      }, options);
      const other = new FeishuStore(config.dataDir, store.api.config);
      await other.initialize();
      // 通过成员表实时补入别名；人员字段仍写名称。
      const memberRow = (await store.api.records('成员')).find(row => cellText(row.fields['ID']) === 'm2')!;
      await store.api.update('成员', memberRow.record_id, { 别名: '测试别名,SECOND' });
      const primary = createTools(store, 'm1');
      const secondary = createTools(other, 'm2');
      assert.deepEqual(await store.listKnowledgeTables(), ['资料', '联系人', '项目']);
      await assert.rejects(store.queryKnowledge('任务'), /找不到知识表/);
      await primary.save_info.run({ title: '在线测试资料', content: '内容初稿', 分类: '学习' });
      await primary.save_info.run({ title: '在线测试资料', content: '内容更新' });
      const info = await other.searchInfo('内容更新');
      assert.equal(info.length, 1); assert.equal(info[0]?.['分类'], '学习');
      assert.equal((await other.searchInfo('欢迎使用')).length, 1);
      console.log('PASS 资料 upsert/分类保留/跨实例回读、知识表清单及系统表保护、真实分页');

      const task = await result<Task>(primary.create_task.run({ title: '在线测试任务', assignee: 'second', due: '2026-11-30' }));
      assert.equal(task.id, 'T-0001'); assert.equal(task.assignee, 'm2');
      const taskRow = (await store.api.records('任务'))[0]!;
      assert.equal(cellText(taskRow.fields['负责人']), '测试成员乙'); assert.equal(cellText(taskRow.fields['创建人']), '测试成员甲');
      assert.equal((await store.pendingNotifications('m2')).length, 1);
      await secondary.update_task.run({ id: task.id, status: 'doing', note: '已经开始\n继续处理' });
      assert.equal((await store.listTasks())[0]?.notes[0]?.text, '已经开始\n继续处理');
      assert.equal((await store.pendingNotifications('m1')).length, 1);
      const self = await result<Task>(primary.create_task.run({ title: '自己待办', assignee: 'm1' }));
      assert.equal(self.id, 'T-0002'); assert.equal((await store.pendingNotifications('m2')).length, 1);
      console.log('PASS 动态成员 ID/名称/别名映射、人员单选写名称、任务编号/日期/备注回读、自派无通知');

      const progress = await result<Progress>(secondary.log_progress.run({ text: '完成在线准备' }));
      assert.equal(progress.member, 'm2'); assert.equal(progress.date, shanghaiDate());
      assert.equal((await other.getProgress('m2', 3)).progress.length, 1);
      await secondary.update_task.run({ id: task.id, status: 'done' });
      assert.equal((await other.getProgress('m2', 3)).tasks.length, 0);
      await primary.notify_member.run({ to: '测试别名', text: '请查看资料' });
      const pending = await store.pendingNotifications('m2');
      const warnings: string[] = [];
      await deliverOutbox(store, 'm2', { sendMessage: async () => { throw new Error('模拟发送失败'); } }, text => warnings.push(text));
      assert.equal(warnings.length, pending.length);
      assert.equal((await store.pendingNotifications('m2')).length, pending.length);
      const sent: string[] = [];
      await deliverOutbox(store, 'm2', { sendMessage: async text => { sent.push(text); } });
      assert.equal(sent.length, pending.length); assert.equal((await other.pendingNotifications('m2')).length, 0);
      await deliverOutbox(store, 'm2', { sendMessage: async () => assert.fail('已送达不应重发') });
      console.log('PASS 进度回读、完成任务排除、通知失败保留/成功送达/不重发');

      await store.appendHistory('m1', [{ role: 'user', content: '本地历史' }]);
      await store.appendHistory('m2', [{ role: 'user', content: '另一成员历史' }]);
      await store.clearHistory('m1');
      assert.deepEqual(await other.getHistory('m1'), []); assert.equal((await other.getHistory('m2')).length, 1);
      console.log('PASS 飞书模式本地历史按成员隔离');
    });
    console.log('FEISHU CHECK OK');
  } finally { await rm(directory, { recursive: true, force: true }); }
}
main().catch(error => {
  let message = error instanceof Error ? error.message : '飞书契约检查失败';
  for (const key of ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_BITABLE_APP_TOKEN', 'ANTHROPIC_API_KEY']) {
    if (process.env[key]) message = message.replaceAll(process.env[key]!, '[已隐藏]');
  }
  console.error(message); process.exitCode = 1;
});
