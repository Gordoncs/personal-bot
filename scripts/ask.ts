import Anthropic from '@anthropic-ai/sdk';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Brain } from '../src/brain.js';
import { loadConfig, requireApiKey } from '../src/config.js';
import { createStore, initializeStore } from '../src/store/create-store.js';
import { readOnlyStore } from '../src/store/read-only-store.js';

async function main(): Promise<void> {
  const question = process.argv.slice(2).join(' ').trim();
  if (!question) throw new Error('用法：npm run ask -- "问题"');
  requireApiKey();
  const directory = await mkdtemp(join(tmpdir(), 'personal-bot-ask-'));
  try {
    const config = loadConfig({ ...process.env,
      DATA_DIR: join(directory, 'store'), OPENCLAW_STATE_DIR: join(directory, 'wx-unused') });
    const store = readOnlyStore(createStore(config));
    await initializeStore(config, store);
    let failure: unknown;
    const brain = new Brain(config, store, {
      client: new Anthropic({ logLevel: 'off', maxRetries: 0, timeout: 60_000 }),
      onError: error => { failure = error; },
    });
    const reply = await brain.chat({ conversationId: 'ask', text: question });
    if (failure) throw failure;
    console.log(reply.text ?? '');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch(error => {
  const status = error instanceof Anthropic.APIError ? error.status ?? 'connection' : 'n/a';
  // 不打印原始 SDK 错误或模型内容，避免泄露配置及认证请求。
  console.error(`ASK FAILED HTTP ${status}：只读查询失败，请检查参数、配置、权限和网络。`);
  process.exitCode = 1;
});
