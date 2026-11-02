import { loadConfig, configureWeixin, requireApiKey } from './config.js';
import { createStore, initializeStore } from './store/create-store.js';
import { startOutbox } from './outbox.js';

async function main(): Promise<void> {
  const config = loadConfig();
  configureWeixin(config);
  const { isLoggedIn, start } = await import('weixin-agent-sdk');
  if (!isLoggedIn()) {
    console.error('请先运行 npm run login');
    process.exitCode = 1;
    return;
  }
  requireApiKey();
  const { Brain } = await import('./brain.js');
  const store = createStore(config);
  await initializeStore(config, store);
  const controller = new AbortController();
  const shutdown = () => controller.abort();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  let stopOutbox: (() => Promise<void>) | undefined;
  try {
    const bot = start(new Brain(config, store), { abortSignal: controller.signal });
    stopOutbox = startOutbox(store, config.owner, bot, config.outboxPollSeconds);
    console.log(`知识库助理已启动，当前用户：${config.owner}`);
    await bot.wait();
  } finally {
    controller.abort();
    await stopOutbox?.();
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
  }
}

main().catch(error => {
  console.error(error instanceof Error && !('status' in error) ? `启动失败：${error.message.split('\n')[0]}` : '启动失败，请检查配置和网络。');
  process.exitCode = 1;
});
