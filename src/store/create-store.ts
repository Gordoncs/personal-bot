import type { Config } from '../config.js';
import { FeishuStore } from './feishu-store.js';
import { JsonStore } from './json-store.js';
import type { Store } from './types.js';

export function createStore(config: Config): Store {
  if (config.store === 'feishu') {
    if (!config.feishu) throw new Error('飞书存储配置缺失，请检查 FEISHU 环境变量。');
    return new FeishuStore(config.dataDir, config.feishu);
  }
  return new JsonStore(config.dataDir, config.ownerName, config.owner || undefined);
}

/** initialize 后解析默认成员；显式 OWNER 必须存在，防止实例冒用未知身份。 */
export async function initializeStore(config: Config, store: Store): Promise<void> {
  await store.initialize();
  const members = await store.getMembers();
  const owner = config.owner || members[0]?.id;
  if (!owner || !members.some(member => member.id === owner)) throw new Error('OWNER 不在成员表中，请运行 kb.py init 或检查 OWNER。');
  config.owner = owner;
}
