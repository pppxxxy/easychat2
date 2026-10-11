// 动态评论线程化 + 后台评论的接入守卫（2026-10-11 用户三项反馈）。
//
// 钉住三件事：
// 1. 用户发完动态退出界面，评论仍在后台继续跑——评论任务必须由模块级 runner 持有，
//    不能挂在组件的 AbortController 上被卸载中止；
// 2. 评论默认是对动态（用户）的回应，只有明确「回复<名字>：」才挂到那条评论下；
// 3. 用户能对着某一条评论回应（replyToId），而不是只有一个笼统的输入框。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (...segments) => readFileSync(path.join(HERE, '..', ...segments), 'utf8');

const MOMENTS_VIEW = read('src', 'MomentsView.js');
const RUNNER = read('src', 'moments', 'commentRunner.js');
const RUN_COMMENTS = read('src', 'moments', 'runUserMomentComments.js');
const REPLY = read('src', 'moments', 'momentReply.js');
const STYLES = read('src', 'moments', 'momentsStyles.js');

test('后台评论任务不依赖 React：runner 里不得出现 react / react-native 导入', () => {
  assert.equal(/from 'react'/.test(RUNNER), false, 'runner 不得依赖 React');
  assert.equal(/from 'react-native'/.test(RUNNER), false, 'runner 不得依赖 react-native');
  assert.ok(RUNNER.includes('export function startCommentTask'));
  assert.ok(RUNNER.includes('export function stopCommentTask'));
  assert.ok(RUNNER.includes('export function subscribeCommentRunner'));
});

test('用户发布动态：评论任务交给模块级 runner，而不是组件自己的 AbortController', () => {
  assert.ok(MOMENTS_VIEW.includes("from './moments/commentRunner.js'"), '应引入后台 runner');
  assert.ok(MOMENTS_VIEW.includes('startCommentTask(momentId'), '发布后应登记后台任务');
  assert.ok(MOMENTS_VIEW.includes('stopCommentTask(id)'), '停止按钮应停后台任务');
  assert.ok(MOMENTS_VIEW.includes('subscribeCommentRunner'), '应订阅任务状态');
  // 旧实现把 controller 挂在组件 ref 上，卸载即 abort —— 这正是「一退出就结束」的根因。
  // 只查 submitPost 这一段：requestReply（角色自己动态的单条回复）仍用组件级 controller。
  const start = MOMENTS_VIEW.indexOf('const submitPost = useCallback');
  const end = MOMENTS_VIEW.indexOf('const renderItem = useCallback');
  assert.ok(start > 0 && end > start, '找不到 submitPost');
  const submitPost = MOMENTS_VIEW.slice(start, end);
  assert.equal(submitPost.includes('new AbortController'), false, '发布动态不得再挂组件级 AbortController');
  assert.equal(submitPost.includes('replyControllersRef.current.set'), false, '发布动态不得再挂组件级 controller');
  assert.ok(submitPost.includes('startCommentTask'), '发布动态应改用后台 runner');
});

test('评论线程化：渲染走 flattenCommentThread，嵌套回复带「回复某人」小标', () => {
  assert.ok(MOMENTS_VIEW.includes("from './moments/commentThread.js'"));
  assert.ok(MOMENTS_VIEW.includes('flattenCommentThread(item.comments)'));
  assert.ok(MOMENTS_VIEW.includes('commentRowNested'));
  assert.ok(MOMENTS_VIEW.includes("t('moments.comment.replyTo', { name: parentName })"));
});

test('用户可对着具体评论回应：每条评论有「回复」入口，提交时带上 replyToId', () => {
  assert.ok(MOMENTS_VIEW.includes('replyTargets'), '应有「回复目标」状态');
  assert.ok(MOMENTS_VIEW.includes("t('moments.comment.reply')"), '每条评论应有「回复」按钮');
  assert.ok(MOMENTS_VIEW.includes("t('moments.comment.replyingTo', { name: replyTargets[item.id].name })"), '输入框上方应有「正在回复」提示');
  assert.ok(MOMENTS_VIEW.includes('replyToId: String(target.id)'), '用户评论应带上 replyToId');
  // 对着角色评论回应时，只让那个角色接话（挂在那条用户评论下）
  assert.ok(MOMENTS_VIEW.includes("mode: 'reply'"));
  assert.ok(MOMENTS_VIEW.includes('responderIds: [target.characterId]'));
  assert.ok(MOMENTS_VIEW.includes('focusCommentId: comment.id'));
});

test('角色自己的动态：回复用户那条评论时挂到它下面（不再笼统回最新一条）', () => {
  assert.ok(MOMENTS_VIEW.includes('requestReply(latest, comment.id)'), '应把用户评论 id 传下去');
  assert.ok(MOMENTS_VIEW.includes('focusCommentId: String(focusCommentId'));
  assert.ok(MOMENTS_VIEW.includes('...(focusCommentId ? { replyToId: String(focusCommentId) } : {})'));
});

test('评论生成：用「回应用户」的提示词，并按「回复<名字>：」解析嵌套目标', () => {
  assert.ok(RUN_COMMENTS.includes('buildMomentCommentPrompt'), '应用用户动态的评论提示词');
  assert.ok(RUN_COMMENTS.includes('parseCommentReplyTarget'), '应解析嵌套回复前缀');
  assert.ok(RUN_COMMENTS.includes("...(parsed.replyToId ? { replyToId: parsed.replyToId } : {})"));
  // 回复轮：整轮冲着那条用户评论来，固定挂靠
  assert.ok(RUN_COMMENTS.includes("mode = 'post'"));
  assert.ok(RUN_COMMENTS.includes('responderIds'));
  // 每写一条回调一次，界面据此逐步刷新
  assert.ok(RUN_COMMENTS.includes('onComment'));
});

test('提示词不再要求「回复最新那条评论」当作评论的动态', () => {
  assert.ok(REPLY.includes('export function buildMomentCommentPrompt'));
  assert.ok(REPLY.includes('重点是回应用户'));
  assert.ok(REPLY.includes('回复<对方名字>：'));
  assert.ok(REPLY.includes('focusCommentId'));
});

test('样式外提：MomentsView 不再自带 createStyles（否则会顶破 800 行棘轮）', () => {
  assert.ok(MOMENTS_VIEW.includes('createMomentsStyles'), '应引入外提的样式工厂');
  assert.equal(MOMENTS_VIEW.includes('const createStyles'), false, '内联样式表应已外提');
  assert.ok(STYLES.includes('export const createMomentsStyles'));
});
