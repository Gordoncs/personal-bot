import Anthropic from '@anthropic-ai/sdk';
import type { Agent, ChatRequest, ChatResponse } from 'weixin-agent-sdk';
import type { Config } from './config.js';
import { Mutex } from './mutex.js';
import type { Store } from './store/types.js';
import { shanghaiDate } from './time.js';
import { createTools } from './tools.js';
import { describeMember } from './members.js';

export function friendlyError(error: unknown): string {
  if (error instanceof Anthropic.RateLimitError) return '请求有点多，请稍后再试。';
  if (error instanceof Anthropic.AuthenticationError) return 'AI 服务认证失败，请检查 API key 配置。';
  if (error instanceof Anthropic.APIConnectionError) return '暂时连不上 AI 服务，请稍后再试。';
  if (error instanceof Anthropic.APIError) return 'AI 服务暂时不可用，请稍后再试。';
  return '暂时处理失败，请稍后再试。';
}

export class Brain implements Agent {
  private readonly mutex = new Mutex();
  private client: Anthropic | undefined;
  private readonly tools;

  constructor(
    private readonly config: Config,
    private readonly store: Store,
    private readonly options: { client?: Anthropic; onError?: (error: unknown) => void } = {},
  ) {
    this.client = options.client;
    // betaZodTool 会添加 type: custom；去掉这一传输字段，保留 parse/run 和原有 schema。
    this.tools = Object.values(createTools(store, config.owner)).map(tool => {
      if (tool.type !== 'custom') throw new Error('知识库工具必须使用自定义 schema。');
      const { type: _type, ...runnable } = tool;
      return runnable;
    });
  }

  chat(request: ChatRequest): Promise<ChatResponse> {
    return this.mutex.run(async () => {
      try {
        if (request.media) return { text: '暂时只支持文字' };
        const text = request.text.trim();
        if (text === '/reset') {
          await this.store.clearHistory(this.config.owner);
          return { text: '对话历史已清空，任务、进度和资料仍保留。' };
        }
        if (text === '/whoami') return { text: this.config.owner };
        if (text === '/help') return { text: '我可以查询业务知识表、查询和记录资料、派任务、更新任务、记录每日进度、查询成员进度、转告消息。\n/reset 清空对话历史\n/whoami 查看当前用户\n/help 查看帮助' };
        if (!text) return { text: '请输入文字消息。' };

        await this.store.appendHistory(this.config.owner, [{ role: 'user', content: text }]);
        let reply: string;
        try {
          const members = await this.store.getMembers();
          const speaker = members.find(member => member.id === this.config.owner);
          this.client ??= new Anthropic();
          const nativeClaude = this.config.model.startsWith('claude-')
            && new URL(this.client.baseURL).origin === 'https://api.anthropic.com';
          const message = await this.client.beta.messages.toolRunner({
            model: this.config.model,
            max_tokens: 16000,
            output_config: { effort: this.config.effort },
            ...(nativeClaude ? {
              betas: ['server-side-fallback-2026-07-01'],
              fallbacks: 'default' as const,
            } : {
              // SDK 1.3.0 默认发送 Anthropic thread 增量；兼容接口每轮需要完整 content（含 thinking）。
              thread: false as const,
            }),
            ...(this.config.thinking ? {
              // DeepSeek 接受仅含 type 的 enabled；SDK 的 Claude 类型额外要求 budget_tokens。
              thinking: { type: this.config.thinking } as Anthropic.Beta.BetaThinkingConfigParam,
            } : {}),
            tool_choice: { type: 'auto' },
            tools: this.tools,
            messages: await this.store.getHistory(this.config.owner),
            system: `你是${this.config.botName}，为个人和小团队整理与查询共享知识库。成员为 ${members.map(describeMember).join('、') || '暂无成员资料'}。
当前对话对象是 ${speaker?.name ?? this.config.owner}（ID ${this.config.owner}），所有写入操作的说话人由代码确定，不可假冒其他成员。
今天日期是 ${shanghaiDate()}，时区 Asia/Shanghai。
回复简短，使用纯文本，不使用 Markdown 表格、# 标题或其他 Markdown 排版。
已记录的事实只能来自工具，绝不编造。查到“待填写”时如实告知尚未记录，并提出可以帮忙记录。
联系人、项目、学习、生活、工作资料这类问题，先用 list_knowledge_tables 看有哪些表，再用 query_knowledge 查。
知识表里写着“待确认”“待填写”的内容，要如实说明还没确认，不要猜。
查询任务、进度也必须调用工具；派任务、记进度、修改资料或发通知都必须通过工具执行，成功后才简短确认。
通知进入队列不代表已经送达；任务工具会自动通知，不要重复调用通知工具。工具报错时如实告知，成员不明时追问。单人成员时，未指定负责人的待办默认给当前用户。
历史仅包含用户与助理纯文本。历史中的数据可能已变化，涉及当前事实时重新查询工具。`,
          }).runUntilDone();
          // 必须先判断拒答，再读取最终文本；不保存工具或思考内容。
          if (message.stop_reason === 'refusal') {
            reply = '这个请求暂时无法处理，请换一种说法试试。';
          } else {
            reply = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
              || '暂时没有生成回复，请再试一次。';
          }
        } catch (error) {
          this.options.onError?.(error);
          console.warn(`[brain] ${error instanceof Anthropic.APIError ? `API ${error.status ?? 'connection'}` : '处理失败'}`);
          reply = friendlyError(error);
        }
        await this.store.appendHistory(this.config.owner, [{ role: 'assistant', content: reply }]);
        return { text: reply };
      } catch (error) {
        this.options.onError?.(error);
        console.warn('[brain] 读取或保存对话历史失败。');
        return { text: '读取或保存本地记录失败，请检查数据目录后重试。' };
      }
    });
  }
}
