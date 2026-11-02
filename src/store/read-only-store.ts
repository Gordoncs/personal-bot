import type { Store } from './types.js';

/** 查询脚本保留临时历史能力；业务写入即便被模型请求也会在此拦截。 */
export function readOnlyStore(store: Store): Store {
  const writes = new Set<keyof Store>([
    'saveInfo', 'createTask', 'updateTask', 'logProgress', 'notifyMember', 'markDelivered',
  ]);
  return new Proxy(store, {
    get(target, key: keyof Store) {
      if (writes.has(key)) return async () => { throw new Error('只读查询不允许修改业务数据。'); };
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
