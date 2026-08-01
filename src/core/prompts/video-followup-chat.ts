import type { VideoContextPackage } from '@core/followup/video-context-package';
import type { FollowupContext } from '@core/followup/select-followup-context';
import type { TranscriptMatchKind } from '@core/followup/transcript-retrieval';
import type { MinimaxWebSearchContext } from '@core/llm/minimax-search-client';
import type {
  FollowupAnswerBasis,
  FollowupConversationMessage,
} from '@shared/messages';
import { detectQuestionLocale, type UiLocale } from '@shared/locale-settings';

/**
 * question_match 专用 matchInfo 扩展：FR-02 §3 引入 `matchKind`（按检索容错层级
 * 选用户可见话术）。`FollowupContext.matchInfo` 类型尚未暴露该字段 —— 选 followup
 * 层 / builder 层只动 retrieval / context 接口的修改不在本任务范围，运行时做类型断言读取。
 */
type QuestionMatchInfo = {
  readonly keyword: string;
  readonly hitCount: number;
  readonly hitTimestamps: readonly number[];
  readonly matchKind?: TranscriptMatchKind;
};

export interface BuildFollowupChatPromptInput {
  readonly question: string;
  readonly contextPackage: VideoContextPackage;
  readonly selectedContext: FollowupContext;
  /**
   * 回答依据。`undefined` 走 `'video_only'` 默认（保持历史严格行为）。
   * background controller 已归一化；prompt 层防御性二次校验，避免老页面 / 直接
   * 单元测试不传时回退到错误的通识补充行为。
   */
  readonly answerBasis?: FollowupAnswerBasis;
  /**
   * 回答语言由用户当前问题决定：中文问中文答，英文问英文答。
   * 与 UI 语言、字幕语言解耦。
   */
  readonly answerLocale?: UiLocale;
  /**
   * 仅 `video_plus_web` 模式传入。搜索结果不是视频事实，只能作为联网补充 / 查证来源。
   */
  readonly webSearchContext?: MinimaxWebSearchContext;
  /**
   * 跨 Port 边界传输的对话历史。空 / 缺失时**不**渲染空块（保持首问 prompt 不变）。
   * 历史仅用于"它 / 我问的是 / 那缺点呢"等指代 / 纠正 / 延续型短追问；
   * 视频事实仍必须来自 `<video_context>`。
   */
  readonly conversationHistory?: readonly FollowupConversationMessage[];
}

/**
 * 追问 prompt。
 *
 * 强制要求（由单测 assert）：
 * - 只基于给定的视频上下文回答
 * - 不知道 / 没提到就明确说不知道
 * - 给时间点依据（mm:ss / hh:mm:ss）
 * - 默认中文回答
 * - 不做通用聊天 / 拒绝离题问题
 * - 引用 prompt 之外的"通用知识"或"训练数据"要明确标"未在上下文中"
 *
 * 输入：
 * - `question`：用户问题
 * - `contextPackage`：当前视频上下文（来自任务 1）
 * - `selectedContext`：由 selectFollowupContext() 选好的范围（任务 2）
 *
 * 输出：system + user 两段文本，调用方直接传给 chat() / streamChat()。
 */
export function buildFollowupChatPrompt(input: BuildFollowupChatPromptInput): {
  readonly system: string;
  readonly user: string;
} {
  const {
    question,
    contextPackage: pkg,
    selectedContext: ctx,
    answerBasis,
    answerLocale,
    webSearchContext,
    conversationHistory,
  } = input;
  // 防御性二次归一化：单元测试 / 老调用方可能不传；缺省走严格 video_only。
  const normalizedBasis: FollowupAnswerBasis = answerBasis ?? 'video_only';
  const normalizedAnswerLocale = answerLocale ?? detectQuestionLocale(question);
  const system = buildSystemPrompt(normalizedBasis, normalizedAnswerLocale);
  // QA2 必修：把已归一化的 basis 透传给 buildUserPrompt，让 global scope 的
  // scope 块不再固定压制 video_plus_general。
  const user = buildUserPrompt({
    pkg,
    ctx,
    question,
    answerBasis: normalizedBasis,
    ...(webSearchContext ? { webSearchContext } : {}),
    ...(conversationHistory && conversationHistory.length > 0 ? { conversationHistory } : {}),
  });
  return { system, user };
}

function buildSystemPrompt(basis: FollowupAnswerBasis, answerLocale: UiLocale): string {
  const basisBlock = renderAnswerBasisBlock(basis);
  const languageBlock = renderAnswerLanguageBlock(answerLocale);
  // 关键：以下所有规则都是 video_only 和 video_plus_general 都成立的"共同约束"。
  // mode-specific 的"是否允许通识补充"由上方 basis 块单独承担 ——
  // **不要**在这里写"不要用训练数据补" / "不要引用课程体系外的知识"这种
  // 与 video_plus_general 直接冲突的硬性约束。
  return `你是 bAI 视频分析助手的学习追问助手。你的任务不是通用聊天，也不是泛泛总结，而是帮助用户理解当前视频、看懂当前片段、提炼可吸收的观点，并识别哪些判断需要保留。当前用户正在围绕"当前播放视频"或与当前视频主题直接相关的问题追问。

${basisBlock}

${languageBlock}

共同约束（video_only / video_plus_general / video_plus_web 都适用）：

1. **回答必须服务学习理解**：优先回答"视频整体讲了什么 / 当前片段怎么理解 / 从这里往后重点怎么看 / 有哪些核心观点和保留意见"。整体总结可以回答内容主线，但不要照搬分析页的固定“快速预览 / 内容精华 / 观看建议 / 适合人群 / 信息边界”模板。**提问页不要搬分析页或导航页模板**：不要输出"完整细看 / 选择性看 / 快速浏览 / 分析分 / 为什么值得看 / 适合不适合 / 观看路线 / 最值得看 / 可看 / 可轻放 / 可跳过"这类旧栏目，除非用户明确要求做观看决策。

2. **视频事实必须来自 <video_context>**：视频里有什么 / 没什么以视频上下文为准。**视频里没有的事实不要编造** —— 这是无论哪种 mode 都必须遵守的底线（basis 块额外约束 video_only 不准用训练数据补齐；video_plus_general 允许用通识补充概念 / 背景；video_plus_web 只允许使用 <web_search_results> 里的联网结果，不允许用模型训练知识 / 游戏通识补事实；补充信息都不能伪装成视频事实）。

3. **围绕当前视频主题**：不要假装看过其他视频；脱离当前视频主题的通用问题（"你好"、"今天天气"、"写首诗"、"写段代码"、"翻译这句话"）礼貌拒绝并提示"请围绕当前视频内容提问"。但在 video_plus_general / video_plus_web 模式下，和当前视频主题直接相关的外部事实问题（如作品背景、版本上线时间、角色人气、当前状态、排名）可以回答，**不要**机械地先说"这个问题和当前视频没有直接关系"。

4. **视频事实给时间点依据**：当提到"视频里讲过 / 时间线 / 字幕"时，用 mm:ss 或 hh:mm:ss 的时间点形式（例如 [03:20-04:10]、[1:02:11]）让用户能直接跳转。**不要**写"在视频中间"这种含糊表达。引用逐字稿原话或某一句话时，时间点必须取对应字幕 cue 的**开始时间**，不要取字幕结束时间、句尾时间或下一条字幕时间；如果担心点击后错过原话，最多只允许比开始时间提前 1 秒，不能提前更多。**这条只约束"视频事实"段落**；其它来源的内容如何标注、是否给时间点由上方 basis 块决定。

5. **证据不足就降级**：当用户问"当前片段怎么看 / 观点是否可信 / 哪些地方需要保留判断 / 能吸收什么"时，如果 <video_context> 没有足够证据，必须明确说"仅凭当前视频证据无法判断"，再说明缺少哪类证据；不要用通识替用户下视频结论。

6. **不确定就说不知道**：没有把握的事实关系、推论、跨章节的因果链不要硬给结论；视频上下文不足以确认的，直接说"视频里讲到的信息不足以确认"。

7. **回答语言**：严格遵守上方"回答语言"规则。字幕、标题或视频语言不改变回答语言；只有引用原文短语时可以保留原文。

8. **回答结构**：根据问题类型**自适应**，**不要**每次都套同一模板：

   - **全局 / 整体性问题**（例如"这个视频主要讲什么？" / "整体讲什么？"）：先讲内容主线，再按需要展开关键概念、核心观点或章节关系；可以给用户理解上的指引和思考，但不要变成分析页的固定快速预览模板。不要写"回答：/依据：/可以继续问："或"Answer:/Evidence:/You can ask next:"这种固定三段式。
   - **当前片段 / 明确时间点问题**（例如"5:05 这段在讲什么" / "解释当前片段"）：**可以**用紧凑依据（1-3 条时间点），**不要**强制长列表 / 强制 3 条以上。
   - **观点 / 收获 / 保留判断类问题**（例如"有哪些观点？" / "我能吸收什么？" / "哪些地方存疑？"）：先给明确结论，再给 1-3 条证据和对应时间点；证据不足时按第 5 条降级。
   - **学习笔记类**（用户明确问"整理成学习笔记"）：只给本轮问题相关的简短整理，并提示正式学习笔记请到"笔记"页生成；不要在提问回答里整理用户记录。
   - **比较 / 归纳 / 多项并列**：**允许**用 Markdown 表格简化。
   - **简单问题**（是 / 否 / 短事实）：先直接回答，再说明依据或不确定性；**可以不输出**"可以继续问"小节。**不要**为了按钮强行生成。

   继续追问建议**只**作为可选末尾小节，**不是**所有回答必需。出现时按第 14 条规范输出。

9. **排版策略**（必读，Round 15 必修 1 + Round 18 必修 2 修订）：

   - 默认可用 Markdown 排版。
   - 关键词 / 关键结论用 \`**加粗**\` 突出，便于在侧边栏里扫读。
   - 当回答里出现 **3 个及以上并列项、优缺点对比、关键概念对比、行动清单**时，**优先**用 Markdown 表格。表头列名要可读，不堆中文长句。
   - 一级小节标题前可少量 emoji 视觉锚点（\`🎯\` / \`📌\` / \`🧭\`），**不要**每行都加、**不要**满屏 emoji。
   - 不要写成纯文本流（之前一直被压缩成"一坨文字"，可读性差）。
   - 列表、引用、简短代码示例都允许。
   - 视频事实依据仍必须用 \`[mm:ss]\` / \`[mm:ss-mm:ss]\` 形式，不要省略时间点、不要写"在视频中间"这种含糊表达。
   - 用户**已经**问的是"整理成学习笔记"时：仍按提问回答处理，只整理当前回答需要的信息；不要展开成正式笔记模板。

10. **解释当前片段时**（用户问"解释当前片段 / 这段在讲什么"等）：

   - **必须**先在回答开头引用 \`<focus_anchor>\` 标签里给出的时间点（例如："在 4:31 这段，视频讲的是……"）。不要泛说"视频中段"。
   - **不要**回答"未指明是哪个时间点"——除非 \`<focus_anchor>\` 块**完全不存在**且问题里**也**没有任何时间点。Round 15 必修 2 已修，current_segment 路径一定会带 \`<focus_anchor>\`。
   - 当前时间附近**逐字稿较少**时：用自然表达告诉用户——"这一段附近逐字稿较少，以下基于章节和时间线概括"。**不要**写"附近字幕不足" / "附近字幕兜底" / "字幕："/"章节："/"时间线："这类内部标签或兜底标语。
   - 结构建议（不强求字面）：
     - 这段在说：1-2 句概括
     - 它和前后内容的关系：基于时间线说明
     - 值得注意：1-2 条具体细节

11. **不要在提问页生成正式笔记**：提问回答只服务当前这次问答。用户要正式学习笔记时，可以简短说明"正式笔记请到笔记页生成"，然后回答他当前真正问的内容；不要整理用户手动记录、不要把提问页变成笔记页。

12. **冲突处理**：如果字幕和复盘/章节描述明显冲突，以 <video_context> 里同时给出的两个版本都列出来，让用户判断，不要替用户取舍。

13. **不要输出内部来源标签 / 内部上下文细节**（Round 17 必修 B + Round 18 必修 2 强化）：不要在用户可见回答中输出"字幕："、"章节："、"时间线："、"附近字幕兜底"、"附近字幕不足提醒"这类内部标签或兜底标语。也不要暴露"本轮提供字幕条数 / 采样字幕 / 50 条采样字幕 / 候选片段 / 上下文窗口 / 完整字幕条数"等内部检索或上下文控制信息；证据不足时用自然表达，例如"视频里没有给出统一量化口径"或"当前视频证据不足以确认"。引用逐字稿用自然表达，例如 "[2:33-2:50] 作者提到…"，引用章节用"按时间线，这段讲的是…"。如果当前上下文里逐字稿较少，只用一句自然表达说明"这一段附近逐字稿较少，以下基于章节和时间线概括"，**不要**照搬 prompt 里的"附近字幕不足"字面。

14. **继续追问建议输出规范**（Round 17 必修 D + Round 18 必修 2 强化）：

    - 这是一个**可选**末尾小节，**不是**所有回答必需。简单问题、用户已经获得完整答案、用户明确要求正式笔记等场景下**不输出**。
    - 如果输出，**只**输出一个继续追问小节，且小节标题必须服从回答语言：中文回答用"可以继续问："；英文回答用"You can ask next:"。
    - 小节内**只放 2 个短问题**（不是 3 个也不是 5 个）。
    - 每行必须以 \`- \` 开头。中文回答里的问题以 \`？\` 结尾；英文回答里的问题以 \`?\` 结尾。
    - 不要在该小节写解释、答案、依据或时间点。
    - 不要重复正文已经完整回答过的句子。
    - 不要混用小节标题语言：英文回答中禁止输出"可以继续问"；中文回答中禁止输出"You can ask next"。
    - **不要**为了按钮强行生成——没有合适追问就跳过。

15. **容错匹配回答话术**（FR-02 §3 Agent C 必修 1-4）：当用户问的主题和字幕不完全一致时（例如"维林娜一命" vs 字幕"维琳娜一命"），按命中层级选话术：

    - **确定命中（exact 匹配）**：直接说"视频里提到……"，并引用对应的 \u0060[…]\u0060 时间点依据。
    - **近似命中（ordered_coverage / one_edit 容错匹配）**：说"你说的 \u0060X\u0060 可能对应字幕里的 \u0060Y\u0060 \u0060[…]\u0060，意思是……" —— **不要**直接断言"视频里说了 X"。
    - **部分相关**（仅有容错命中但匹配松散）：说"字幕里没有完全一致的说法，最相关的一段是 \u0060[…]\u0060 ……"。
    - **无法确认**（所有层都无可靠命中）：说"我在当前字幕里没有找到足够明确的对应内容"，**不要**说"视频没讲过"。
    - **用户问"是否提到 X"但精确检索未命中**：这只代表完整字幕里没有完全一致的字面词，**不要**直接等同于"否"。先结合候选字幕 / 时间线 / 章节判断是否有同义表达、ASR 错字、标题或简介证据；仍无明确证据时说"我在当前视频上下文里没有找到足够明确的对应内容"。`;
}

function renderAnswerLanguageBlock(locale: UiLocale): string {
  if (locale === 'en-US') {
    return [
      '回答语言：English.',
      '- All user-visible answer text must be English because the user asked in English.',
      '- Keep short original subtitle terms only when citing evidence, then explain them in English.',
      '- If a transcript term is only an approximate match, use cautious English wording: "Your phrase X may correspond to Y in the subtitles at [mm:ss]..."',
      '- If you include follow-up suggestions, the heading must be exactly "You can ask next:" and each bullet question must be in English.',
      '- Never output the Chinese heading "可以继续问" in an English answer.',
      '- Do not ask the user to clarify by default. Ask only when there are multiple equally plausible candidates and answering one would mislead.',
    ].join('\n');
  }
  return [
    '回答语言：中文。',
    '- 用户可见回答使用中文，因为用户用中文提问。',
    '- 引用英文字幕术语时可以保留原文，再用中文解释。',
    '- 如果只是近似命中，使用谨慎话术：“你说的 X 可能对应字幕里的 Y [mm:ss]……”。',
    '- 默认不要反问用户；只有多个候选同样可能、直接回答会误导时才追问澄清。',
  ].join('\n');
}

function buildUserPrompt(input: {
  readonly pkg: VideoContextPackage;
  readonly ctx: FollowupContext;
  readonly question: string;
  /**
   * QA2 必修：把已归一化的 answerBasis 透传到 renderScopeDescription，
   * 让 `global` scope 的提示不再固定压制 video_plus_general。
   * system prompt 已经按 basis 渲染好"视频事实 vs 补充理解（通识）"规则，
   * user prompt 的 scope 块需要服从该规则，不能再独立写"只基于字幕回答"。
   */
  readonly answerBasis?: FollowupAnswerBasis;
  readonly webSearchContext?: MinimaxWebSearchContext;
  /**
   * 对话历史。空 / 缺失时**不**渲染 <conversation_history> 块（保持首问 prompt 不变）。
   */
  readonly conversationHistory?: readonly FollowupConversationMessage[];
}): string {
  const { pkg, ctx, question, answerBasis, webSearchContext, conversationHistory } = input;
  const focusAnchorBlock = renderFocusAnchorBlock(ctx);
  const transcriptBlock = renderTranscriptBlock(
    ctx.selectedTranscriptCues,
    ctx.transcriptFallback ?? false,
  );
  const timelineBlock = renderTimelineBlock(ctx.selectedTimelineItems);
  const chapterBlock = renderChapterBlock(ctx.selectedChapters);
  const reviewBlock = renderReviewBlock(pkg, ctx);
  const keywordBlock = renderKeywordBlock(ctx);
  const webSearchBlock = renderWebSearchBlock(webSearchContext);

  const conversationBlock = renderConversationHistoryBlock(conversationHistory);

  return [
    ...(conversationBlock ? [conversationBlock, ''] : []),
    '<video_context>',
    `标题：${pkg.title}`,
    `作者：${pkg.author}`,
    `平台：${pkg.platform}`,
    `URL：${pkg.url}`,
    pkg.duration !== undefined ? `时长：${pkg.duration} 秒` : '时长：未知',
    `分析来源：${formatAnalysisModeLabel(pkg.analysisMode)}`,
    '',
    '<content_inventory>',
    '本轮上下文：已按问题、时间点和视频结构选取相关字幕；这只是给模型的内部证据窗口。',
    '说明：当前上下文窗口不是全片字幕总量。除非用户明确询问字幕数据本身，不要在用户可见回答中提到字幕条数、采样、候选字幕或上下文窗口。定位类问题应以字幕开始时间和时间线节点为准。',
    '</content_inventory>',
    '',
    '<primary_scope>',
    renderScopeDescription(ctx.primaryScope, ctx, answerBasis),
    '</primary_scope>',
    '',
    focusAnchorBlock,
    timelineBlock,
    chapterBlock,
    transcriptBlock,
    reviewBlock,
    keywordBlock,
    '</video_context>',
    '',
    ...(webSearchBlock ? [webSearchBlock, ''] : []),
    '用户问题：',
    question,
  ].join('\n');
}

function renderScopeDescription(
  scope: FollowupContext['primaryScope'],
  // ctx 是预留扩展位（后续可能根据 scope 渲染不同 hint），目前 switch 内未读取。
  _ctx?: FollowupContext,
  /**
   * QA2 必修：把已归一化的 answerBasis 传进 scope 渲染，让 `global` scope
   * 不再固定压制 video_plus_general；其它 scope 仍走原有措辞（QA1 已通过）。
   * 未传 / undefined 时按 video_only 渲染（防御性二次归一化，避免老调用方回归）。
   */
  answerBasis?: FollowupAnswerBasis,
): string {
  const basis: FollowupAnswerBasis = answerBasis ?? 'video_only';
  const transcriptTerm = '字幕';
  switch (scope) {
    case 'explicit_time':
      return '用户在问题里给了一个明确时间点；已按 ±30s / +90s 取字幕与覆盖该时间的章节。回答请围绕这个时间点。';
    case 'selected_segment':
      return '用户点选了某个时间线节点；请围绕该节点及前后字幕回答。';
    case 'current_segment':
      return '用户问的是"这段 / 这里 / 现在讲"等当前片段意图，或点击了"解释当前片段"快捷问题；请围绕当前播放时间覆盖的章节与字幕回答。';
    case 'keyword_match':
      return '用户在问"是否提到 X"；已用关键词在**完整字幕**里做精确检索。命中时直接基于命中片段回答并给时间点；未命中时只说明"完整字幕里没有完全一致的字面词"，**不要**直接等同于"否"，也不要说"整个视频没讲过"。请结合候选字幕 / 时间线 / 章节判断是否有同义表达、ASR 错字或标题简介证据；仍无明确证据时说"我在当前视频上下文里没有找到足够明确的对应内容"。';
    case 'timeline_match':
      return '用户问的是某个主题在视频哪里或是否出现；字幕检索没有直接命中，但时间线/章节标题或摘要已经命中。请把 <timeline_nodes> / <chapters> 里的标题和时间范围当成标准答案，回答位置类问题时必须优先原样使用这些标题和时间范围；不要改写成另一个能力编号，也不要用字幕里的"能力几"替换时间线标题。如果 <transcript_cues> 没有逐字出现该主题，要说明依据来自时间线，不要回答成"没找到"。';
    case 'question_match': {
      // SG-05B §3 / §4：普通事实问题（无关键词触发词、无时间词）。
      // 与 keyword_match 的关键差异：未命中时路由层已回落 global，**不**在 prompt
      // 出现"完整字幕零命中"否认信号。这里描述明确"普通检索不足"。
      // QA2 修正：原注释说"让 LLM 知道不要用训练数据脑补"——这是 video_only 的语义；
      // video_plus_general 模式下 LLM 可以补通识。注释只描述路由层职责，不带 mode 偏好。
      //
      // FR-02 §3 Agent C 必修 1-4：按 matchKind 选用户可见话术。
      // - exact 命中：可以直接说"视频里找到与主题完全一致的内容"
      // - ordered_coverage / one_edit 容错命中：要诚实说"字幕里没有与主题完全一致"，并
      //   提示模型按上方容错匹配回答话术（"你说的 X 可能对应字幕里的 Y"）回答
      // QA3 修正：之前是"按 rule 14"——system prompt 实际只有 13 条规则。
      // 改成不依赖数字的措辞，避免规则重排再次失效。
      const matchInfo = _ctx?.matchInfo as QuestionMatchInfo | undefined;
      const matchKind: TranscriptMatchKind = matchInfo?.matchKind ?? 'exact';
      if (matchKind === 'exact') {
        return '用户问的是普通事实问题；已在完整字幕里找到与主题完全一致的片段。**直接说"视频里提到……"**，并按上方容错匹配回答话术引用对应 \u0060[…]\u0060 时间点依据。';
      }
      // ordered_coverage / one_edit 都走容错话术
      return '用户问的是普通事实问题；字幕里没有与主题完全一致的内容，但有**容错命中**（ordered_coverage 多 token 顺序覆盖 / one_edit 一处编辑距离）。'
        + '**不要**直接断言"视频里说了 X"——按上方容错匹配回答话术说"你说的 \u0060X\u0060 可能对应字幕里的 \u0060Y\u0060 \u0060[…]\u0060"，并允许在容错命中较松散时说"字幕里没有完全一致的说法，最相关的一段是 \u0060[…]\u0060"。';
    }
    case 'global':
    default: {
      // SG-05B §4：global 统一走全片均匀采样；globalContextMode 总是 'transcript_only'。
      // 'derived_analysis' 分支已删除（之前是"少量代表性字幕"，那是 §1 真实用户 bug）。
      //
      // QA2 必修：原固定文案"请基于字幕内容回答 / 最多说"我在当前字幕里没有找到
      // 足够明确的对应内容""在 user prompt 中压制了 video_plus_general。
      // 现在按 answerBasis 分模式：video_only 保持原严格措辞；video_plus_general
      // 明确"视频事实仍基于上下文 / 上下文不足时按上方 basis 规则补通识"。
      const head = `用户问的是视频整体。**已按全片时间分布提供${transcriptTerm}证据**，覆盖开头 / 中段 / 结尾；时间线 + 章节 + 复盘作为补充锚点。`;
      if (basis === 'video_plus_general') {
        return (
          head +
          '视频事实只能基于上方 <video_context> 给出的字幕 / 时间线 / 章节 / 复盘，' +
          '**不要**把通识知识伪装成视频原话、**不要**为通识内容编造视频时间点。' +
          '如果用户问的是某个具体概念但当前视频上下文没有直接解释，先明确说明' +
          '"当前视频上下文没有直接解释 X"，再按上方 basis 规则输出"补充理解（通识）"——' +
          '不要假定上下文只覆盖开场。'
        );
      }
      if (basis === 'video_plus_web') {
        return (
          head +
          '视频事实只能基于上方 <video_context>；如果用户问的是同主题外部事实或实时信息，' +
          '可以直接基于 <web_search_results> 回答，不要先否定"当前视频没讲"；' +
          '如果用户问的是视频观点核查，再把联网内容作为"联网补充 / 联网查证"。' +
          '联网内容必须给来源链接，**不要**把联网内容写成视频原话，也**不要**给联网内容编造视频时间点。' +
          '没有被 <web_search_results> 或 <video_context> 直接支持的事实，不要用模型通识 / 训练知识补答案。'
        );
      }
      // video_only（默认 / 防御性 fallback）
      return (
        head +
        `请基于${transcriptTerm}内容回答；不要假定上下文只覆盖开场。` +
        `如果用户问的是某个具体概念但当前${transcriptTerm}证据里没找到，**最多说"我在当前${transcriptTerm}里没有找到足够明确的对应内容"**——` +
        `你看到的是按全片时间分布选取的${transcriptTerm}证据，**不能**下"整个视频没讲过"的结论。`
      );
    }
  }
}

/**
 * 渲染 <focus_anchor> 块（Round 15 必修 2 D）。
 *
 * 触发条件：FollowupContext.anchorTimestamp 是有效 number（必填）。
 *
 * 输出 XML-style 块，方便被 react-markdown / 普通文本解析。
 * 如果 anchorLabel = 'current_time' → 块标题是"类型：当前播放位置"
 * 等等，让 LLM 一眼看到这是"用户指定的焦点"，必须在回答开头引用这个时间点。
 */
function renderFocusAnchorBlock(ctx: FollowupContext): string {
  if (typeof ctx.anchorTimestamp !== 'number' || !Number.isFinite(ctx.anchorTimestamp)) {
    return '';
  }
  const label = ctx.anchorLabel ?? 'explicit_time';
  const labelText =
    label === 'current_time'
      ? '当前播放位置'
      : label === 'selected_timestamp'
        ? '用户点选的时间线节点'
        : '用户在问题里写出的时间点';
  const hintText =
    label === 'current_time'
      ? '用户问的是"这段 / 这里 / 现在讲"等当前片段意图，或点击了"解释当前片段"快捷问题，请围绕该时间附近字幕、章节和时间线回答。'
      : label === 'selected_timestamp'
        ? '用户点选了时间线上的某个节点，请围绕该节点时间回答。'
        : '用户在问题里写出了时间点，请围绕该时间点回答。';
  return [
    '<focus_anchor>',
    `类型：${labelText}`,
    `时间：${formatSeconds(ctx.anchorTimestamp)}`,
    `说明：${hintText}`,
    '</focus_anchor>',
  ].join('\n');
}

function renderTranscriptBlock(
  cues: FollowupContext['selectedTranscriptCues'],
  fallback: boolean,
): string {
  // Round 17 必修 B + Round 18 必修 2：fallback 标志改为结构化 <context_quality> 块。
  // 给 LLM 的注释只写"以上 cue 离 anchor 较远"，**不要**写"附近字幕不足/兜底"等
  // 容易在用户可见回答里被原样照搬的标语 —— 那是 LLM 看到的元数据，不是给用户看的话术。
  if (cues.length === 0) {
    return '<transcript_cues>\n（当前 anchor 附近没有逐字稿可参考）\n</transcript_cues>';
  }
  const quality = fallback
    ? [
        '',
        '<context_quality transcript="nearest_fallback" />',
        '说明：以上 cue 离 anchor 较远，仅作参考；如需更精确请按章节/时间线回答。',
      ]
    : [];
  return [
    '<transcript_cues>',
    ...cues.map((cue) => `[${formatSeconds(cue.start)}] ${cue.text}`),
    '</transcript_cues>',
    ...quality,
  ].join('\n');
}

function renderTimelineBlock(items: FollowupContext['selectedTimelineItems']): string {
  if (items.length === 0) {
    return '<timeline_nodes>\n（无相关时间线节点）\n</timeline_nodes>';
  }
  return [
    '<timeline_nodes>',
    ...items.map((node) => {
      const end = node.endTimestamp !== undefined ? `-${formatSeconds(node.endTimestamp)}` : '';
      return `[${formatSeconds(node.timestamp)}${end}] ${node.title}：${node.summary}`;
    }),
    '</timeline_nodes>',
  ].join('\n');
}

function renderChapterBlock(chapters: FollowupContext['selectedChapters']): string {
  if (chapters.length === 0) {
    return '<chapters>\n（无相关章节）\n</chapters>';
  }
  return [
    '<chapters>',
    ...chapters.map((chapter) => {
      const end = chapter.endTimestamp !== undefined ? `-${formatSeconds(chapter.endTimestamp)}` : '';
      return `[${formatSeconds(chapter.timestamp)}${end}] ${chapter.title}：${chapter.summary}`;
    }),
    '</chapters>',
  ].join('\n');
}

function renderReviewBlock(
  pkg: VideoContextPackage,
  ctx: FollowupContext,
): string {
  const lines: string[] = ['<review>'];
  if (ctx.overviewLine) {
    lines.push(`视频核心：${ctx.overviewLine}`);
  }
  if (ctx.reviewSummary) {
    lines.push(`整体总结：${ctx.reviewSummary}`);
  }
  if (pkg.review.keyPoints.length > 0) {
    lines.push('核心要点：');
    for (const point of pkg.review.keyPoints) {
      lines.push(`- ${point}`);
    }
  }
  lines.push('</review>');
  return lines.join('\n');
}

function renderKeywordBlock(ctx: FollowupContext): string {
  if (!ctx.matchInfo) {
    return '';
  }
  const { keyword, hitCount, hitTimestamps } = ctx.matchInfo;
  if (hitCount === 0) {
    return [
      '<keyword_search>',
      `关键词：${keyword}`,
      '命中片段数：0（完整字幕精确检索没有找到完全一致的字面词）',
      '处理要求：这不是"视频一定没讲"的结论。请结合 <transcript_cues> / <timeline_nodes> / <chapters> 判断是否存在同义表达、ASR 错字、标题或简介证据；如果仍无明确证据，只能说"我在当前视频上下文里没有找到足够明确的对应内容"，不要直接回答"否"。',
      '</keyword_search>',
    ].join('\n');
  }
  return [
    '<keyword_search>',
    `关键词：${keyword}`,
    `命中片段数：${hitCount}`,
    `命中时间点：${hitTimestamps.map((t) => formatSeconds(t)).join(', ')}`,
    '请基于下方 <transcript_cues> 中含该关键词的句子回答。',
    '</keyword_search>',
  ].join('\n');
}

function renderWebSearchBlock(search: MinimaxWebSearchContext | undefined): string {
  if (!search) {
    return '';
  }
  if (search.results.length === 0) {
    return [
      '<web_search_results>',
      renderSearchPlanLines(search),
      '结果：0 条。请说明"这次没有检索到足够可靠的联网来源"，不要伪造来源。',
      '</web_search_results>',
    ].join('\n');
  }
  return [
    '<web_search_results>',
    renderSearchPlanLines(search),
    ...search.results.map((result, index) =>
      [
        `[来源 ${index + 1}] ${result.title}`,
        `URL：${result.url}`,
        result.sourceType ? `来源类型：${renderSourceType(result.sourceType)}` : '',
        result.sourceQuery ? `命中查询：${result.sourceQuery}` : '',
        result.snippet ? `摘要：${result.snippet}` : '摘要：（无）',
      ].filter(Boolean).join('\n'),
    ),
    '</web_search_results>',
  ].join('\n');
}

function renderSearchPlanLines(search: MinimaxWebSearchContext): string {
  if (!search.plan) {
    return `搜索词：${search.query || '（空）'}`;
  }
  const lines = [
    '<web_search_plan>',
    `意图：${search.plan.intent}`,
    search.plan.entity ? `识别实体：${search.plan.entity}` : '',
    search.plan.topicHint ? `主题补充：${search.plan.topicHint}` : '',
    `证据要求：${search.plan.requiredEvidence}`,
    '查询词：',
    ...search.plan.queries.map((query) => `- ${query}`),
    '</web_search_plan>',
  ].filter(Boolean);
  return lines.join('\n');
}

function renderSourceType(type: NonNullable<MinimaxWebSearchContext['results'][number]['sourceType']>): string {
  switch (type) {
    case 'official':
      return '官方 / 准官方';
    case 'media':
      return '媒体 / 攻略站';
    case 'community':
      return '社区 / 视频平台';
    case 'weak':
    default:
      return '弱来源 / 待核验';
  }
}

/**
 * 渲染 `<conversation_history>` 块（用于"它 / 我问的是 / 那缺点呢"等
 * 指代 / 纠正 / 延续型短追问）。
 *
 * 关键不变量（AGENT_HANDOFF §Prompt 约束 + QA1 必修 2）：
 * - 空 / 缺失 → 返回 `''`，由调用方保持首问 prompt 不变（不渲染空块）。
 * - 非空时**先**渲染一段模型可见的"历史证据边界" instruction（包含历史**不**是
 *   视频事实依据、当前 answerBasis 规则优先于历史回答、video_only 不得复用历史通识
 *   等规则），**再**渲染 `<conversation_history>` 块。
 *   这样模型能在读历史前就明确"历史是上下文、不是证据"的边界。
 * - assistant 历史回答**可能误述**，只是对话上下文；模型**不**应基于历史 assistant
 *   内容下"视频里说过 X"这种断言。
 * - 当前回答依据规则（video_only / video_plus_general / video_plus_web）**不**被历史改变 —— 历史是
 *   对话上下文，回答依据是单轮回答的语义。
 */
function renderConversationHistoryBlock(
  history: readonly FollowupConversationMessage[] | undefined,
): string {
  if (!history || history.length === 0) {
    return '';
  }
  // QA1 必修 2：模型可见的"历史证据边界"规则放在 <conversation_history> 块之前。
  // 单数 \n 分隔，prompt 解析友好；不在 system prompt 写是因为空历史时不渲染，
  // 保持首问 prompt 精简。
  const evidenceBoundary = [
    '<!-- 历史证据边界（仅当携带历史时渲染，**不**在首问出现） -->',
    '对话历史**只**用于理解当前问题的指代 / 纠正 / 延续关系（"它 / 我问的是 / 那缺点呢"等）。',
    '**视频事实只能来自下方 <video_context>**：历史中的助手回答可能错误，**不**是视频证据；不要据此断言"视频里说过 X"。',
    '**当前请求的 video_only / video_plus_general / video_plus_web 规则优先于历史回答**：video_only 模式下，历史中的通识补充不能作为本轮依据；video_plus_web 模式下，历史中的联网说法也不能替代本轮 <web_search_results>。',
  ].join('\n');
  const historyBlock = [
    '<conversation_history>',
    ...history.map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`),
    '</conversation_history>',
  ].join('\n');
  return `${evidenceBoundary}\n${historyBlock}`;
}

/**
 * 渲染 system prompt 顶部的"回答依据"块（覆盖在"硬性约束"之前）。
 *
 * 两个 mode 都是"围绕当前视频学习"，但允许使用模型通识的程度不同：
 * - `video_only`（默认 / 历史行为）：视频没讲就说不知道，**不**用训练数据补。
 * - `video_plus_general`：允许模型用训练数据补充概念解释，但**必须**区分
 *   "视频内容"和"补充理解（通识）"，通识**不能**伪装成视频原话 / 编造时间点，
 *   也**不能**声称已联网或伪造引用。
 * - `video_plus_web`：允许使用本轮 <web_search_results>，但必须给来源，不能伪造网页证据；
 *   不允许用模型通识 / 训练知识补事实。
 */
function renderAnswerBasisBlock(basis: FollowupAnswerBasis): string {
  const transcriptTerm = '字幕';
  if (basis === 'video_plus_general') {
    return [
      '0. **回答依据：视频上下文 + 模型通识知识（video_plus_general）**：',
      '   - **仍然是围绕当前视频学习，不能退化成通用聊天**。',
      '   - **先回答视频中说了什么**，并保持视频时间点能力。',
      '   - 只有在解释概念、背景或帮助理解时，才使用模型已有通识知识；**必须**用清晰的小标题区分两类内容：',
      '     - "**视频内容**"：来自 <video_context> 的事实，时间点依据照常给 [mm:ss]。',
      '     - "**补充理解（通识）**"：来自模型训练数据的概念解释，**不能**给视频时间点。',
      '   - 通识补充**不能**伪装成视频原话；不要把通识内容写成"视频里说"。',
      '   - 视频没有直接依据时，应先明确说明"视频里没直接讲 X"，再给与当前问题相关的通识解释。',
      '   - **不得**声称已联网，不提供伪造的实时信息 / 网页来源 / 引用。',
      '   - 对明显脱离当前视频主题的问题继续拒绝，避免形成通用 AI 聊天入口。',
    ].join('\n');
  }
  if (basis === 'video_plus_web') {
    return [
      '0. **回答依据：视频上下文 + MiniMax 联网搜索结果（video_plus_web）**：',
      '   - **仍然是围绕当前视频主题学习，不能退化成通用搜索助手**。',
      '   - 如果用户问的是"视频里怎么说 / 作者为什么这么说 / 这段怎么看"，先回答视频内容，并保持视频时间点能力。',
      '   - 如果用户问的是和视频主题直接相关的外部事实 / 实时信息（如上线时间、当前排名、人气、版本状态），可以直接基于 <web_search_results> 回答，**不要**机械地先说"视频里没讲 / 和视频无关"。',
      '   - **联网模式不是通识模式**：除 <video_context> 和 <web_search_results> 以外，**不得**使用模型训练知识、游戏内通识、百科印象或记忆来补事实；不要写"来源：游戏内通识背景"。',
      '   - <web_search_plan> 是本轮查证计划：按"意图 / 识别实体 / 证据要求 / 查询词"判断搜索是否覆盖了问题，不要只看第一条结果。',
      '   - 每条来源会标注来源类型：官方 / 媒体 / 社区 / 弱来源。官方优先；媒体可辅助；社区可说明讨论热度但不能单独当作确定事实；弱来源只能作为线索。',
      '   - 联网内容只能来自本轮 <web_search_results>，必须以"联网补充"、"联网查证"或"联网结果"的身份出现。',
      '   - 联网补充必须给来源链接，例如"来源：[标题](URL)"；不要伪造没有出现在搜索结果里的网页、作者或日期。',
      '   - **不要**把联网搜索结果写成"视频里说"；联网内容不能给视频时间点。',
      '   - 对"什么时候 / 日期 / 目前 / 最新 / 最高 / 排名 / 人气 / 第一"这类问题，必须有搜索结果直接支持日期、榜单、投票或排名，才能下确定结论；只有"引发讨论 / 热议"这类弱证据时，必须说"没有找到足够可靠的排名 / 日期依据"，不要硬凑。',
      '   - 如果 <web_search_results> 为空或与问题无关，明确说"这次没有检索到足够可靠的联网来源"；如果 <video_context> 也不能回答，就停在这里并建议换关键词或改用通识，不要用通识兜底。',
      '   - 对明显脱离当前视频主题的问题继续拒绝，避免形成通用 AI 聊天入口。',
    ].join('\n');
  }
  // video_only（默认）
  return [
    '0. **回答依据：仅视频上下文（video_only）**：',
    `   - 视频里没有明确信息时，必须明确说"我在当前${transcriptTerm}里没有找到足够明确的对应内容"。`,
    '   - **不**使用模型训练数据 / 通识知识补齐视频里没有的内容。',
    '   - **不**主动补充背景或概念解释；用户问"X 是什么"且当前视频上下文没有明确证据时，直接说"我在当前视频上下文里没有找到足够明确的对应内容"。',
  ].join('\n');
}

function formatAnalysisModeLabel(mode: VideoContextPackage['analysisMode']): string {
  if (mode === 'subtitle') {
    return '字幕分析';
  }
  return '旧分析缓存（公开版不再生成）';
}

function formatSeconds(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const rest = safe % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  }
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}
