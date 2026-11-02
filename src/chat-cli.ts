import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig, requireApiKey } from './config.js';
import { Brain } from './brain.js';
import { createStore, initializeStore } from './store/create-store.js';

async function main(): Promise<void> {
  const config = loadConfig();
  requireApiKey();
  const store = createStore(config);
  await initializeStore(config, store);
  const brain = new Brain(config, store);
  const terminal = createInterface({ input: stdin, output: stdout });
  console.log(`本地聊天（${config.owner}）：/help 查看帮助，/exit 退出。`);
  try {
    while (true) {
      let text: string;
      try { text = await terminal.question('你 > '); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ERR_USE_AFTER_CLOSE') break;
        throw error;
      }
      if (text.trim() === '/exit') break;
      const reply = await brain.chat({ conversationId: `cli-${config.owner}`, text });
      console.log(`助理 > ${reply.text ?? ''}`);
    }
  } finally { terminal.close(); }
}

main().catch(error => {
  const message = error instanceof Error && (error.message.startsWith('飞书') || error.message.startsWith('STORE '))
    ? error.message : '本地聊天启动或运行失败，请检查配置、API key 及数据目录。';
  console.error(message);
  process.exitCode = 1;
});
