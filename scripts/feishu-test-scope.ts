import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Config } from '../src/config.js';
import { FeishuStore } from '../src/store/feishu-store.js';

export function testStore(config: Config, _purpose: 'check' | 'smoke'): FeishuStore {
  if (!config.feishu) throw new Error('飞书测试缺少配置。');
  return new FeishuStore(config.dataDir, { ...config.feishu, tablePrefix: `测试_pb_${randomBytes(6).toString('hex')}_` });
}
export async function withFeishuTest<T>(store: FeishuStore, run: () => Promise<T>): Promise<T> {
  const prefix = store.api.config.tablePrefix;
  if (!/^测试_pb_[a-f0-9]{12}_$/.test(prefix)) throw new Error('必须使用本轮随机前缀。');
  const original = await store.api.listTables();
  const names = (tables: typeof original) => tables.map(t => [t.table_id, t.name]).sort();
  const fingerprint = async () => {
    const hashes: Record<string, string> = {};
    for (const table of original) {
      const fields = await store.api.fieldsById(table.table_id!);
      const rows = await store.api.recordsById(table.table_id!);
      // 只保留摘要，正式业务内容不落盘或输出。
      hashes[table.table_id!] = createHash('sha256').update(JSON.stringify([fields, rows.sort((a, b) => a.record_id.localeCompare(b.record_id))])).digest('hex');
    }
    return hashes;
  };
  const before = await fingerprint();
  try {
    const { stdout } = await promisify(execFile)('python3', ['-I', 'knowledge-base/kb.py', 'init', '--name', '测试成员甲', '--member', '测试成员乙', '--yes'], {
      env: { ...process.env, KB_TABLE_PREFIX: prefix }, maxBuffer: 1024 * 1024,
    });
    assert.match(stdout, /初始化完成/);
    console.log('PASS 隔离模板通过 kb.py init 创建');
    await store.initialize();
    return await run();
  } finally {
    await store.api.cleanupTestTables();
    const remaining = await store.api.listTables();
    console.log(`清理后剩余表名：${remaining.map(table => table.name).join('、')}`);
    assert.deepEqual(names(remaining), names(original), '正式表清单应保持一致');
    assert.deepEqual(await fingerprint(), before, '正式表结构与数据指纹应保持一致');
    console.log('PASS 正式表清单、结构和数据指纹一致；本轮测试表零残留');
  }
}
