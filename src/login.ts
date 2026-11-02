import { loadConfig, configureWeixin } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  configureWeixin(config);
  const { login } = await import('weixin-agent-sdk');
  await login();
  console.log(`${config.owner} 登录成功，可运行 npm start。`);
}

main().catch(() => {
  console.error('登录失败，请检查 OWNER、独立的 OPENCLAW_STATE_DIR 配置及网络后重试。');
  process.exitCode = 1;
});
