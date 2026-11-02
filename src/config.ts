import { homedir } from 'node:os';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { z } from 'zod';
import { validateMemberId } from './members.js';
import type { MemberId } from './store/types.js';

const effortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
const compatibleEffortSchema = z.enum(['low', 'high', 'max']);
const thinkingSchema = z.enum(['enabled', 'disabled']);
export interface Config {
  store: 'json' | 'feishu';
  feishu?: FeishuConfig;
  owner: MemberId;
  ownerName: string;
  botName: string;
  stateDir: string;
  dataDir: string;
  model: string;
  thinking?: z.infer<typeof thinkingSchema>;
  effort: z.infer<typeof effortSchema>;
  outboxPollSeconds: number;
}

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  appToken: string;
  tablePrefix: string;
}

/** 仅从已经加载的环境获取配置，不读取环境文件，也不输出配置值。 */
export function loadFeishuConfig(env = process.env): FeishuConfig {
  const required = ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_BITABLE_APP_TOKEN'] as const;
  const missing = required.filter(key => !env[key]?.trim());
  if (missing.length) throw new Error(`飞书存储缺少配置：${missing.join('、')}，请填写环境变量。`);
  return {
    appId: env.FEISHU_APP_ID!.trim(), appSecret: env.FEISHU_APP_SECRET!.trim(),
    appToken: env.FEISHU_BITABLE_APP_TOKEN!.trim(), tablePrefix: env.FEISHU_TABLE_PREFIX ?? '',
  };
}

// 解析已存在的祖先目录，防止符号链接绕过默认凭证目录保护。
function canonicalPath(path: string): string {
  try { return realpathSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = resolve(path, '..');
    if (parent === path) return path;
    return resolve(canonicalPath(parent), relative(parent, path));
  }
}

function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function loadConfig(env = process.env): Config {
  const store = env.STORE?.trim() || 'json';
  if (store !== 'json' && store !== 'feishu') throw new Error('STORE 必须是 json 或 feishu。');
  const feishu = store === 'feishu' ? loadFeishuConfig(env) : undefined;
  const owner = env.OWNER?.trim() ? validateMemberId(env.OWNER.trim()) : '';
  const ownerName = env.OWNER_NAME?.trim() || '我';
  const botName = env.BOT_NAME?.trim() || '知识库助理';
  if (!env.OPENCLAW_STATE_DIR?.trim()) throw new Error('请显式设置本实例独立的 OPENCLAW_STATE_DIR。');
  const protectedDir = resolve(homedir(), '.openclaw');
  const rawStateDir = resolve(env.OPENCLAW_STATE_DIR);
  if (contains(protectedDir, rawStateDir) || contains(rawStateDir, protectedDir)) {
    throw new Error('OPENCLAW_STATE_DIR 不能指向 ~/.openclaw、其子目录或祖先目录。');
  }
  const stateDir = canonicalPath(rawStateDir);
  if (contains(protectedDir, stateDir) || contains(stateDir, protectedDir)) {
    throw new Error('OPENCLAW_STATE_DIR 不能指向 ~/.openclaw、其子目录或祖先目录。');
  }
  const rawDataDir = resolve(env.DATA_DIR?.trim() || './data/store');
  if (contains(protectedDir, rawDataDir) || contains(rawDataDir, protectedDir)) {
    throw new Error('DATA_DIR 不能指向 ~/.openclaw、其子目录或祖先目录。');
  }
  const dataDir = canonicalPath(rawDataDir);
  if (contains(protectedDir, dataDir) || contains(dataDir, protectedDir)) {
    throw new Error('DATA_DIR 不能指向 ~/.openclaw、其子目录或祖先目录。');
  }
  if (contains(stateDir, dataDir) || contains(dataDir, stateDir)) {
    throw new Error('OPENCLAW_STATE_DIR 与 DATA_DIR 必须使用互不嵌套的目录。');
  }
  const model = env.LLM_MODEL?.trim() || 'deepseek-flash';
  const thinking = thinkingSchema.optional().safeParse(env.LLM_THINKING);
  if (!thinking.success) throw new Error('LLM_THINKING 必须是 enabled 或 disabled；不设置则省略 thinking。');
  // 兼容服务不支持 medium：保守映射到 low；xhigh 仍拒绝，避免静默改变高强度请求。
  const rawEffort = !model.startsWith('claude-') && env.CLAUDE_EFFORT === 'medium' ? 'low' : env.CLAUDE_EFFORT ?? 'low';
  const effort = (model.startsWith('claude-') ? effortSchema : compatibleEffortSchema).safeParse(rawEffort);
  if (!effort.success) throw new Error(model.startsWith('claude-')
    ? 'CLAUDE_EFFORT 必须是 low、medium、high、xhigh 或 max。'
    : '兼容模型的 CLAUDE_EFFORT 必须是 low、high 或 max（medium 自动映射为 low）。');
  const interval = Number(env.OUTBOX_POLL_SECONDS ?? '30');
  if (!Number.isFinite(interval) || interval <= 0 || interval > 2_147_483) {
    throw new Error('OUTBOX_POLL_SECONDS 必须是有效的正数秒数。');
  }
  return { store, feishu, owner, ownerName, botName, stateDir, dataDir, model, thinking: thinking.data, effort: effort.data, outboxPollSeconds: interval };
}

/** 必须先于动态 import 微信 SDK 调用，以免模块初始化时读取默认目录。 */
export function configureWeixin(config: Config): void {
  process.env.OPENCLAW_STATE_DIR = config.stateDir;
}

export function requireApiKey(): void {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) throw new Error('请配置 AI 服务的 API key（环境变量 ANTHROPIC_API_KEY）。');
}
