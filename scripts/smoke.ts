import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { Brain } from '../src/brain.js';
import { loadConfig, requireApiKey } from '../src/config.js';
import { createStore, initializeStore } from '../src/store/create-store.js';
import { testStore, withFeishuTest } from './feishu-test-scope.js';

async function main() {
  requireApiKey();
  const directory = await mkdtemp(join(tmpdir(), 'personal-bot-smoke-'));
  let requests = 0;
  try {
    const config = loadConfig({ ...process.env, OWNER: 'm1',
      OPENCLAW_STATE_DIR: join(directory, 'wx-unused'), DATA_DIR: join(directory, 'store') });
    const isolated = config.store === 'feishu' ? testStore(config, 'smoke') : undefined;
    const store = isolated ?? createStore(config);
    const run = async () => {
      await initializeStore(config, store);
      let queries = 0;
      const search = store.searchInfo.bind(store);
      store.searchInfo = async keyword => { queries++; return search(keyword); };
      let failure: unknown;
      const brain = new Brain(config, store, {
        client: new Anthropic({ logLevel: 'off', maxRetries: 0, timeout: 60_000,
          fetch: async (url, init) => {
            if (++requests > 2) throw new Error('Smoke 最多允许两次模型请求');
            return fetch(url, init);
          } }),
        onError: error => { failure = error; },
      });
      const reply = await brain.chat({ conversationId: 'smoke', text: '请只调用一次 search_info，关键词为「欢迎使用」，然后用一句话告诉我知识库的用法。不要调用其他工具。' });
      if (failure) throw new Error('模型 Smoke 请求失败，请检查兼容接口配置。');
      assert.ok(queries > 0, '应实际读取资料');
      assert.match(reply.text ?? '', /同步|知识库/);
      console.log(`PASS STORE=${config.store} 模型 → search_info → 飞书资料 → 回复；模型 HTTP 请求 ${requests} 次`);
    };
    if (isolated) await withFeishuTest(isolated, run); else await run();
    console.log('SMOKE OK');
  } finally { await rm(directory, { recursive: true, force: true }); }
}
main().catch(() => { console.error('SMOKE FAILED：请检查模型配置、飞书权限或测试断言。'); process.exitCode = 1; });
