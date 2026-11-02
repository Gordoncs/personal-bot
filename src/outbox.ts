import type { MemberId, Store } from './store/types.js';

export interface Sender { sendMessage(text: string): Promise<void> }

/** 单次轮询也可供离线测试；失败项保持未送达。 */
export async function deliverOutbox(store: Store, owner: MemberId, bot: Sender, warn = console.warn): Promise<void> {
  const pending = await store.pendingNotifications(owner);
  if (!pending.length) return;
  const members = await store.getMembers();
  for (const item of pending) {
    const name = members.find(member => member.id === item.from)?.name ?? item.from;
    try {
      await bot.sendMessage(`📌 来自 ${name}：${item.text}`);
      await store.markDelivered(item.id);
    } catch {
      warn(`[outbox] 通知 ${item.id} 发送或确认失败，保留待重试。`);
    }
  }
}

export function startOutbox(store: Store, owner: MemberId, bot: Sender, seconds: number): () => Promise<void> {
  let running: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (running) return;
    running = deliverOutbox(store, owner, bot)
      .catch(() => { console.warn('[outbox] 读取通知队列失败，下次重试。'); })
      .finally(() => { running = undefined; });
  }, seconds * 1000);
  return async () => { clearInterval(timer); await running; };
}
