import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { FeishuError } from './store/feishu-api.js';
import { KnowledgeTableError } from './store/types.js';
import { INFO_CATEGORIES } from './store/feishu-schema.js';
import { describeMember, resolveMember } from './members.js';
import type { MemberId, Store } from './store/types.js';

const text = z.string().trim().min(1);
const status = z.enum(['todo', 'doing', 'done', 'blocked']);
const due = z.iso.date().describe('截止日期，YYYY-MM-DD；用户没有说明时省略');

export function createTools(store: Store, owner: MemberId) {
  async function member(name: string): Promise<MemberId> {
    const members = await store.getMembers();
    const found = resolveMember(name, members);
    if (!found) throw new Error(`无法识别成员「${name}」，请向用户确认。可用成员：${members.map(describeMember).join('、') || '暂无成员'}。`);
    return found.id;
  }
  // Tool Runner 及离线自测共用同一批 run；验证失败也作为工具结果交给模型追问。
  function run<S extends z.ZodType, R>(schema: S, action: (input: z.output<S>) => Promise<R>, limit?: number) {
    function encode(value: unknown): string {
      const output = JSON.stringify(value);
      const hint = '\n结果已截断，请使用 keyword 缩小范围后重新查询。';
      return limit && output.length > limit ? output.slice(0, limit - hint.length) + hint : output;
    }
    return async (input: z.input<S>): Promise<string> => {
      const parsed = schema.safeParse(input);
      if (!parsed.success) return JSON.stringify({ error: `参数无效：${parsed.error.issues.map(issue => issue.message).join('；')}` });
      try { return encode(await action(parsed.data)); }
      catch (error) {
        const message = error instanceof Error ? error.message : '';
        const expected = error instanceof FeishuError || error instanceof KnowledgeTableError || message.startsWith('无法识别成员') || message.startsWith('找不到任务') || ['缺少字段', '缺少单选选项', '分类不存在', '资料标题重复'].some(prefix => message.startsWith(prefix)) || message === '请提供任务状态或备注。';
        if (!expected) console.warn('[工具] 数据操作失败，请检查本地数据与权限。');
        return encode({ error: expected ? message : '数据操作失败，请稍后重试或检查本地数据。' });
      }
    };
  }

  const empty = z.object({});
  const knowledgeInput = z.object({ table: text.describe('list_knowledge_tables 返回的知识表名称'), keyword: text.optional().describe('可选关键词，任一字段包含即匹配，不区分大小写') });
  const knowledgeDescription = '资料、联系人、项目及其他知识问题，先用 list_knowledge_tables 查看有哪些表，再用 query_knowledge 查询。';
  const infoInput = z.object({ keyword: text.optional() });
  const saveInput = z.object({ title: text, content: text, 分类: z.enum(INFO_CATEGORIES).optional() });
  const listInput = z.object({ assignee: text.optional(), status: status.optional() });
  const createInput = z.object({ title: text, assignee: text.optional().describe('成员 ID、名称或别名；单人可省略'), detail: text.optional(), due: due.optional() });
  const updateInput = z.object({ id: text, status: status.optional(), note: text.optional() });
  const progressInput = z.object({ text: text });
  const getProgressInput = z.object({ member: text, days: z.number().int().min(1).max(3660).default(3) });
  const notifyInput = z.object({ to: text, text });

  return {
    list_knowledge_tables: betaZodTool({
      name: 'list_knowledge_tables', description: `只读列出可用业务知识表。${knowledgeDescription}`,
      inputSchema: empty, run: run(empty, () => store.listKnowledgeTables(), 8000),
    }),
    query_knowledge: betaZodTool({
      name: 'query_knowledge', description: `只读查询知识表，可用 keyword 筛选；结果超过约 8000 字符会截断，请缩小关键词范围。${knowledgeDescription}待确认、待填写表示尚未确认，不可猜测。`,
      inputSchema: knowledgeInput, run: run(knowledgeInput, input => store.queryKnowledge(input.table, input.keyword), 8000),
    }),
    search_info: betaZodTool({
      name: 'search_info', description: '查询资料表，可按关键词筛选；回答已记录事实前先查询。',
      inputSchema: infoInput, run: run(infoInput, input => store.searchInfo(input.keyword), 8000),
    }),
    save_info: betaZodTool({
      name: 'save_info', description: '用户明确要求保存时按标题新增或更新资料，不可编造内容。',
      inputSchema: saveInput, run: run(saveInput, input => store.saveInfo(input.title, input.content, input.分类)),
    }),
    list_tasks: betaZodTool({
      name: 'list_tasks', description: '查询任务，可按负责人（支持成员表中的名称和别名）和状态筛选；不传筛选则列出所有任务。',
      inputSchema: listInput, run: run(listInput, async input => store.listTasks({
        ...(input.assignee ? { assignee: await member(input.assignee) } : {}),
        ...(input.status ? { status: input.status } : {}),
      })),
    }),
    create_task: betaZodTool({
      name: 'create_task', description: '用户要求派任务或记录待办时调用。创建者自动使用当前用户；指派给另一成员时自动排队通知。单人时可省略负责人，默认当前用户；多人负责人不明确时先询问。',
      inputSchema: createInput, run: run(createInput, async input => store.createTask(owner, {
        title: input.title, assignee: await member(input.assignee ?? ((await store.getMembers()).length === 1 ? owner : '')),
        ...(input.detail ? { detail: input.detail } : {}), ...(input.due ? { due: input.due } : {}),
      })),
    }),
    update_task: betaZodTool({
      name: 'update_task', description: '按任务 id 更新状态或添加备注，至少提供一项。id 不清楚时先查询任务；非创建者更新会自动通知创建者。',
      inputSchema: updateInput, run: run(updateInput, input => store.updateTask(owner, input.id, {
        ...(input.status ? { status: input.status } : {}), ...(input.note ? { note: input.note } : {}),
      })),
    }),
    log_progress: betaZodTool({
      name: 'log_progress', description: '用户要求记录今日进度时调用，记录归属固定为当前用户，日期自动采用上海时区。',
      inputSchema: progressInput, run: run(progressInput, input => store.logProgress(owner, input.text)),
    }),
    get_progress: betaZodTool({
      name: 'get_progress', description: '查询指定成员最近 N 个自然日（包含今天）的进度及全部未完成任务；默认 3 天，支持成员别名。',
      inputSchema: getProgressInput, run: run(getProgressInput, async input => store.getProgress(await member(input.member), input.days)),
    }),
    notify_member: betaZodTool({
      name: 'notify_member', description: '用户明确要求给另一成员发消息、提醒或转告时写入通知队列；这仅表示排队，未保证已送达微信。',
      inputSchema: notifyInput, run: run(notifyInput, async input => store.notifyMember(owner, await member(input.to), input.text)),
    }),
  };
}
