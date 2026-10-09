// 子代理工具定义（run_subagent）。
//
// 只读对象**从 readTools.js 直接引**（不是从全量工具表过滤）：防递归的名单天然
// 只包含只读两项，且这条引用关系不经过「注册表」——子代理在结构上就拿不到
// 别的工具（含它自己）。run_subagent 自身也是 readOnly 工具，按标志过滤会
// 把它放进来递归，所以只读白名单按**名字**收（见 agent/subagent.js）。

import { runSubagent, SUBAGENT_TOOL_NAMES } from '../../agent/subagent.js';
import { READ_ONLY_TOOL_DEFINITIONS } from './readTools.js';

export const SUBAGENT_TOOL_DEFINITION = {
  name: 'run_subagent',
  description: '把一个「研究型子任务」委托给助手的一个独立分身：它只能读工作区文件'
    + '（不能改任何东西），完成后把整理好的结论交回来。适合「翻很多文件找答案」'
    + '这类会刷屏的任务——中间过程不会占用当前对话的上下文。task 里要写清'
    + '「要找什么、要回答什么」，结论回来后再由你转述或继续加工。',
  readOnly: true,
  // 子代理要跑多轮模型请求，默认工具超时（十几秒）不够；180s 是防跑飞的上限。
  timeoutMs: 180000,
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string', description: '子任务描述（要找什么、要回答什么）。' },
    },
    required: ['task'],
  },
  execute: async (options, args, ctx) => {
    // 只读工具按**名字白名单**过滤（不含 run_subagent——它自己也是 readOnly，
    // 只看标志会递归）：防递归是结构性的，不靠"记得别给"。
    const readOnlyTools = READ_ONLY_TOOL_DEFINITIONS.filter(item => SUBAGENT_TOOL_NAMES.includes(item.name));
    const result = await runSubagent({
      task: args.task,
      tools: readOnlyTools,
      store: options.store,
      characterId: ctx && ctx.characterId,
      signal: (ctx && ctx.signal) || null,
    });
    return result.isError ? { content: result.content, isError: true } : result.content;
  },
};
