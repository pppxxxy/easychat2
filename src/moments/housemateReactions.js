// 同住角色的动态反应（点赞 / 评价）：纯函数层负责提示词、结果解析与数据合并，
// 便于单测；真正的模型调用在 runHousemateReactions.js。
//
// 规则：同一栋房子里的角色（屋主 + 住户）在别人发动态时会来点赞、评论。
// 这是「不进记忆」的一次性反应，绝不写回会话消息或记忆摘要。

const REACTION_COMMENT_MAX = 120;
const MAX_REACTIONS_PER_MOMENT = 8;

function clean(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

export function buildHousemateReactionPrompt({
  moment,
  reactor,
  posterName = '角色',
  sameHouseLabel = '',
  charName = '',
} = {}) {
  const name = clean(charName) || clean(reactor && reactor.name) || '角色';
  const author = clean(posterName) || clean(moment && moment.characterName) || '角色';
  const lines = [
    `你是${name}，你正以${name}的身份刷到了一条动态。`,
    `发动态的是和你住在同一栋房子的${author}：`,
    `「${clean(moment && moment.text)}」`,
  ];
  if (clean(sameHouseLabel)) {
    lines.push(`你们同住在${clean(sameHouseLabel)}。`);
  }
  if (clean(reactor && reactor.persona)) {
    lines.push('', `你的性格与设定：${clean(reactor.persona)}`);
  }
  lines.push(
    '',
    '请以你的身份，对这条动态给出真实反应。严格按下面两行输出，不要多余内容、不要解释：',
    '点赞：是 或 否',
    '评论：<40 字以内的口语化评论；不想评论就写“无”>',
    '',
    '要求：',
    '- 点赞与评论都要符合你和发帖人的关系与性格，可以调侃、关心、附和或吐槽。',
    '- 不要写动作描写、旁白、括号补充或思考过程，也不要加引号或署名。',
    '- 不要提到“提示词”“系统”“模型”这类词。'
  );
  return lines.join('\n');
}

// 点赞字段的两种写法。提示词要求「点赞：是 或 否」，但模型也常写成「不点赞是因为…」，
// 那时「点赞」后面紧跟的正是「是」——只看肯定式就会把否定读成点赞（语义反转）。
const LIKE_PATTERN = /点赞\s*[:：]?\s*(?:是|要|会|true|yes|y|👍|1)/i;
const DISLIKE_PATTERN = /(?:不|没|别|不想)点赞|点赞\s*[:：]?\s*(?:否|不|不会|false|no|n|0|👎)/i;
// 整行只是一个点赞回答（「点赞：是」「我点赞：否」「不点赞」）：这种行是回答点赞问题，
// 不是评论，整行丢掉。只删匹配片段会把「我点赞：否」的「我」留成评论（实测过）。
const LIKE_FIELD_ANY = /[我咱俺]\s*|(?:不|没|别|不会)?点赞\s*[:：]?\s*(?:是|否|不|要|会|不会|true|false|yes|no|y|n|👍|👎|1|0)?/gi;
// 行内残留的点赞字段（带冒号才算字段，这样「不点赞是因为今天没空」这种句子不会被削）。
const LIKE_FIELD_INLINE = /(?:不|没|别|不会)?点赞\s*[:：]\s*(?:是|否|不|要|会|不会|true|false|yes|no|y|n|👍|👎|1|0)/gi;
const LINE_NOISE = /[\s，,。.！!；;：:、~～「」『』“”"'（）()\-—_]/g;
// 整段只回答了点赞问题（「是」「否」「true」），不是评论。
const LIKE_ANSWER_ONLY = /^(?:是|否|要|不|会|不会|true|false|yes|no|y|n|👍|👎|1|0)$/i;

function isLikeOnlyLine(line) {
  if (!/点赞/.test(line)) return false;
  return line.replace(LIKE_FIELD_ANY, '').replace(LINE_NOISE, '') === '';
}

// 解析模型输出：容错处理“点赞：是/否”“评论：xxx”、缺行、JSON 等写法。
// 返回 { like, comment }；comment 为空串表示不评论。
export function parseHousemateReaction(text, maxLength = REACTION_COMMENT_MAX) {
  const raw = clean(text);
  if (!raw) return { like: false, comment: '' };

  let like = false;
  let comment = '';

  // 否定优先：两种表达都出现时取更靠前的那个。「不点赞是因为今天没空」里否定在 0、
  // 「点赞…是」在 1，取前者；「点赞：是\n评论：我不点赞」里肯定在 0，取后者。
  const likeMatch = raw.match(LIKE_PATTERN);
  const dislikeMatch = raw.match(DISLIKE_PATTERN);
  if (dislikeMatch && (!likeMatch || dislikeMatch.index <= likeMatch.index)) like = false;
  else if (likeMatch) like = true;
  else if (/👍/.test(raw)) like = true;

  const commentMatch = raw.match(/评论\s*[:：]\s*([\s\S]*)$/);
  if (commentMatch) {
    comment = commentMatch[1];
  } else {
    // 没写“评论：”前缀时，按行丢掉「点赞…」回答行，剩下的才算评论
    // （只删匹配片段会把「我点赞：否」剩成「我」）。
    comment = raw
      .split('\n')
      .filter(line => !isLikeOnlyLine(line))
      .join('\n')
      .replace(LIKE_FIELD_INLINE, '');
  }
  comment = comment
    .replace(/^[（(]([^（）()]*)[）)]$/, '$1')
    .replace(/^[「『“"']+/, '')
    .replace(/[」』”"']+$/, '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (/^(无|没有|不评论|无评论|none|n\/a|-|—)$/i.test(comment)) comment = '';
  // 只剩一个点赞答案的残留（「是」「否」）不是评论：否则动态下会出现正文就是「否」的评论。
  if (LIKE_ANSWER_ONLY.test(comment)) comment = '';
  if (comment.length > maxLength) {
    comment = `${comment.slice(0, Math.max(1, maxLength - 1)).trim()}…`;
  }
  return { like, comment };
}

// 选出需要对这条动态做出反应的同住角色：排掉发帖人自己、已点过赞或已评论过的人。
// reactors 为候选角色对象数组（含 id / name / persona）。已发过反应的不再重复调用模型。
export function selectReactingHousemates({
  reactors = [],
  moment,
  max = MAX_REACTIONS_PER_MOMENT,
} = {}) {
  const posterId = clean(moment && moment.characterId);
  const likes = Array.isArray(moment && moment.likes) ? moment.likes : [];
  const comments = Array.isArray(moment && moment.comments) ? moment.comments : [];
  const reacted = new Set();
  likes.forEach(like => {
    if (like && String(like.by) === 'character' && like.characterId) reacted.add(clean(like.characterId));
  });
  comments.forEach(comment => {
    if (comment && String(comment.by) === 'character' && comment.characterId) {
      reacted.add(clean(comment.characterId));
    }
  });
  const limit = Math.max(0, Math.trunc(Number(max)) || 0);
  return (Array.isArray(reactors) ? reactors : [])
    .filter(item => item && item.id && clean(item.id) !== posterId && !reacted.has(clean(item.id)))
    .slice(0, limit);
}

// 把某个角色的反应合并进这条动态；返回新数组（不可变）。
export function mergeReactionIntoMoments(list, momentId, reaction) {
  const id = String(momentId || '');
  const reactorId = clean(reaction && reaction.characterId);
  const reactorName = clean(reaction && reaction.name) || '角色';
  if (!id || !reactorId) return Array.isArray(list) ? list : [];
  const now = Number(reaction && reaction.createdAt) || Date.now();
  return (Array.isArray(list) ? list : []).map(moment => {
    if (!moment || moment.id !== id) return moment;
    const likes = Array.isArray(moment.likes) ? moment.likes : [];
    const comments = Array.isArray(moment.comments) ? moment.comments : [];
    const alreadyLiked = likes.some(like => like && like.by === 'character' && like.characterId === reactorId);
    const alreadyCommented = comments.some(comment => comment
      && comment.by === 'character' && comment.characterId === reactorId);
    const nextLikes = reaction && reaction.like && !alreadyLiked
      ? [...likes, {
        id: `like-${reactorId}-${now}`,
        by: 'character',
        characterId: reactorId,
        name: reactorName,
        createdAt: now,
      }]
      : likes;
    const nextComments = reaction && clean(reaction.comment) && !alreadyCommented
      ? [...comments, {
        id: `r-${reactorId}-${now}`,
        by: 'character',
        characterId: reactorId,
        name: reactorName,
        text: clean(reaction.comment),
        createdAt: now,
        likedByCharacter: false,
      }]
      : comments;
    if (nextLikes === likes && nextComments === comments) return moment;
    return { ...moment, likes: nextLikes, comments: nextComments };
  });
}
