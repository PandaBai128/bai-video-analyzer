import { normalizeMinimaxBaseUrl, type TextProviderSettings } from '@shared/settings';
import { MinimaxApiError } from './minimax-client';

const MAX_QUERY_LENGTH = 220;
const DEFAULT_FOLLOWUP_RESULT_LIMIT = 10;

export type FollowupWebSearchIntent =
  | 'entity_intro'
  | 'release_date'
  | 'ranking'
  | 'fact_check'
  | 'fresh_fact'
  | 'general';

export type MinimaxWebSearchSourceType = 'official' | 'media' | 'community' | 'weak';

export interface MinimaxWebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly sourceQuery?: string;
  readonly sourceType?: MinimaxWebSearchSourceType;
  readonly relevanceScore?: number;
}

export interface MinimaxWebSearchPlan {
  readonly intent: FollowupWebSearchIntent;
  readonly entity?: string;
  readonly topicHint?: string;
  readonly queries: readonly string[];
  readonly requiredEvidence: string;
}

export interface MinimaxWebSearchContext {
  readonly query: string;
  readonly queries?: readonly string[];
  readonly plan?: MinimaxWebSearchPlan;
  readonly results: readonly MinimaxWebSearchResult[];
}

export interface MinimaxSearchOptions {
  readonly signal?: AbortSignal;
  readonly limit?: number;
}

export class MinimaxSearchClient {
  constructor(private readonly settings: TextProviderSettings) {}

  async search(query: string, options: MinimaxSearchOptions = {}): Promise<MinimaxWebSearchContext> {
    const normalizedQuery = normalizeSearchQuery(query);
    if (!normalizedQuery) {
      return { query: '', results: [] };
    }

    const baseUrl = normalizeMinimaxBaseUrl(this.settings.baseUrl);
    const requestInit: RequestInit = {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.settings.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: normalizedQuery }),
    };
    if (options.signal) {
      requestInit.signal = options.signal;
    }

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/v1/coding_plan/search`, requestInit);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `MiniMax 联网搜索请求失败：${message}。当前 Base URL：${baseUrl}。如果终端 curl 能访问但 Chrome 扩展仍失败，请在 chrome://extensions 重新加载 bAI，并确认扩展的“站点访问权限”未被限制；manifest 需要允许 api.minimax.io / api.minimaxi.com 的 host_permissions 与 connect-src。`,
      );
    }

    if (!response.ok) {
      const detail = await response.text();
      throw new MinimaxApiError(
        createMiniMaxSearchHttpErrorMessage(response.status, detail),
        response.status,
        detail,
      );
    }

    const data = (await response.json()) as unknown;
    assertSearchBusinessOk(data);
    return {
      query: normalizedQuery,
      results: normalizeSearchResults(data).slice(0, clampLimit(options.limit)),
    };
  }

  async searchFollowup(input: {
    readonly question: string;
    readonly title: string;
    readonly author?: string;
  }, options: MinimaxSearchOptions = {}): Promise<MinimaxWebSearchContext> {
  const plan = buildFollowupWebSearchPlan(input);
    if (plan.queries.length === 0) {
      return { query: '', queries: [], plan, results: [] };
    }

    const perQueryLimit = Math.min(3, clampLimit(options.limit));
    const contexts = await Promise.all(
      plan.queries.map((query) => this.search(query, { ...options, limit: perQueryLimit })),
    );
    const results = mergeSearchResultsForPlan(contexts, plan).slice(
      0,
      clampFollowupLimit(options.limit),
    );
    return {
      query: plan.queries[0] ?? '',
      queries: plan.queries,
      plan,
      results,
    };
  }
}

export function buildFollowupWebSearchQuery(input: {
  readonly question: string;
  readonly title: string;
  readonly author?: string;
}): string {
  return buildFollowupWebSearchPlan(input).queries[0] ?? '';
}

export function buildFollowupWebSearchPlan(input: {
  readonly question: string;
  readonly title: string;
  readonly author?: string;
}): MinimaxWebSearchPlan {
  const question = normalizeSearchQuery(input.question);
  if (!question) {
    return {
      intent: 'general',
      queries: [],
      requiredEvidence: '需要至少一条与问题直接相关的联网来源。',
    };
  }

  const intent = classifyFollowupWebSearchIntent(question);
  const entity = extractQuestionEntity(question);
  const titleHint = buildContextualTitleHint({
    title: input.title,
    question,
    intent,
  });
  const intentTerms = buildIntentTerms(intent, question);
  const adjustedQuestion = removeDuplicatedLeadingVersion(question, titleHint);
  const queries = buildFollowupQueries({
    question: adjustedQuestion,
    originalQuestion: question,
    intent,
    entity,
    titleHint,
    intentTerms,
  });
  return {
    intent,
    ...(entity ? { entity } : {}),
    ...(titleHint ? { topicHint: titleHint } : {}),
    queries,
    requiredEvidence: buildRequiredEvidence(intent),
  };
}

function normalizeSearchQuery(query: string): string {
  return query.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_LENGTH);
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    return 5;
  }
  return Math.min(10, Math.max(1, Math.floor(limit)));
}

function clampFollowupLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    return DEFAULT_FOLLOWUP_RESULT_LIMIT;
  }
  return Math.min(12, Math.max(3, Math.floor(limit)));
}

function normalizeSearchResults(data: unknown): readonly MinimaxWebSearchResult[] {
  const root = isRecord(data) ? data : {};
  const nestedData = isRecord(root.data) ? root.data : {};
  const organic =
    root.organic ?? root.results ?? nestedData.organic ?? nestedData.results ?? root.data;
  const items = Array.isArray(organic) ? organic : [];
  return items
    .map(normalizeSearchResult)
    .filter((item): item is MinimaxWebSearchResult => item !== null);
}

function assertSearchBusinessOk(data: unknown): void {
  const root = isRecord(data) ? data : {};
  const baseResp = isRecord(root.base_resp) ? root.base_resp : null;
  if (!baseResp) {
    return;
  }

  const rawStatusCode = baseResp.status_code ?? baseResp.statusCode ?? baseResp.code;
  if (rawStatusCode === undefined || rawStatusCode === null) {
    return;
  }

  const normalizedStatusCode =
    typeof rawStatusCode === 'number'
      ? rawStatusCode
      : typeof rawStatusCode === 'string'
        ? Number(rawStatusCode.trim())
        : Number.NaN;
  const statusCodeText = String(rawStatusCode).trim();
  const isSuccess =
    Number.isFinite(normalizedStatusCode) ? normalizedStatusCode === 0 : statusCodeText === '0';
  if (isSuccess) {
    return;
  }

  const statusMessage =
    readString(baseResp, ['status_msg', 'statusMessage', 'message', 'msg']) ??
    readString(root, ['message', 'msg', 'error']) ??
    '未知错误';
  const detail = stringifyDetail(data);
  throw new MinimaxApiError(
    createMiniMaxSearchBusinessErrorMessage(statusCodeText, statusMessage, detail),
    null,
    detail,
  );
}

function normalizeSearchResult(item: unknown): MinimaxWebSearchResult | null {
  if (!isRecord(item)) {
    return null;
  }
  const rawTitle = readString(item, ['title', 'name']);
  const rawUrl = readString(item, ['link', 'url']);
  if (!rawTitle || !rawUrl) {
    return null;
  }
  const snippet = readString(item, ['snippet', 'content', 'description']) ?? '';
  return {
    title: rawTitle,
    url: rawUrl,
    snippet,
  };
}

function readString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function classifyFollowupWebSearchIntent(question: string): FollowupWebSearchIntent {
  if (
    /什么时候|何时|哪天|上线|推出|发布|发售|开服|更新|日期|时间/.test(question)
  ) {
    return 'release_date';
  }
  if (/人气|最高|最受欢迎|排行|排名|榜单|投票|热度|播放量|销量|最强|第一/.test(question)) {
    return 'ranking';
  }
  if (/目前|现在|最新|最近|今年|今天|当下|实时/.test(question)) {
    return 'fresh_fact';
  }
  if (/搜索|搜一下|帮我搜|帮我查|查一下|介绍|是谁|是什么角色|什么人物|背景|资料/.test(question)) {
    return 'entity_intro';
  }
  if (/真假|真的吗|靠谱吗|是否|是不是|有没有|能不能|可不可以|为什么/.test(question)) {
    return 'fact_check';
  }
  return 'general';
}

function buildContextualTitleHint(input: {
  readonly title: string;
  readonly question: string;
  readonly intent: FollowupWebSearchIntent;
}): string {
  const hint = extractTitleTopicHint(input.title, input.question);
  if (!hint) {
    return '';
  }
  if (questionAlreadyContainsCoreHint(input.question, hint)) {
    return '';
  }
  if (input.intent === 'ranking') {
    return stripVersionNumbers(hint);
  }
  return hint;
}

function buildIntentTerms(intent: FollowupWebSearchIntent, question: string): string {
  const terms: string[] = [];
  if (intent === 'entity_intro') {
    pushTermIfMissing(terms, question, '介绍');
    pushTermIfMissing(terms, question, '角色');
    pushTermIfMissing(terms, question, '背景');
  }
  if (intent === 'release_date') {
    pushTermIfMissing(terms, question, '官方公告');
    pushTermIfMissing(terms, question, '上线时间');
    pushTermIfMissing(terms, question, '发布日期');
  }
  if (intent === 'ranking') {
    pushTermIfMissing(terms, question, '人气榜');
    pushTermIfMissing(terms, question, '投票');
    pushTermIfMissing(terms, question, '排名');
  }
  if (intent === 'fresh_fact' || /目前|现在|最新|最近|当下|实时/.test(question)) {
    pushTermIfMissing(terms, question, '最新');
  }
  if (intent === 'fact_check') {
    pushTermIfMissing(terms, question, '来源');
    pushTermIfMissing(terms, question, '查证');
  }
  return terms.join(' ');
}

function pushTermIfMissing(terms: string[], question: string, term: string): void {
  if (!question.includes(term)) {
    terms.push(term);
  }
}

function extractTitleTopicHint(title: string, question: string): string {
  const cleanTitle = normalizeTitleForSearchHint(title);
  if (!cleanTitle) {
    return '';
  }

  const leadingSubject = extractLeadingSubject(cleanTitle);
  if (leadingSubject && question.includes(leadingSubject)) {
    return '';
  }

  const versionMatches = question.match(/[0-9]+(?:\.[0-9]+)?/g) ?? [];
  for (const version of versionMatches) {
    const escapedVersion = escapeRegExp(version);
    const match = cleanTitle.match(
      new RegExp(`([\\u4e00-\\u9fffA-Za-z][\\u4e00-\\u9fffA-Za-z0-9·・ ]{1,24})\\s*${escapedVersion}`),
    );
    if (match?.[1]) {
      const subject = trimTitleSubject(match[1]);
      if (subject) {
        return normalizeSearchQuery(`${subject} ${version}`);
      }
    }
  }

  if (leadingSubject) {
    return leadingSubject;
  }
  const firstSegment = cleanTitle.split(/[：:？?！!。｜|,，、\-_—]/)[0] ?? '';
  return trimTitleSubject(firstSegment).slice(0, 24).trim();
}

function extractLeadingSubject(title: string): string {
  const beforeVersion = title.match(/^([\u4e00-\u9fff]{2,10})(?=[0-9]+(?:\.[0-9]+)?)/);
  if (beforeVersion?.[1]) {
    return trimTitleSubject(beforeVersion[1]);
  }
  const bracketSubject = title.match(/[《「“]([^》」”]{2,12})[》」”]/);
  if (bracketSubject?.[1]) {
    return trimTitleSubject(bracketSubject[1]);
  }
  return '';
}

function normalizeTitleForSearchHint(title: string): string {
  return title
    .replace(/【[^】]*】|\[[^\]]*]|\([^)]*\)|（[^）]*）/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function trimTitleSubject(value: string): string {
  return value
    .replace(/^(深度|解析|推荐|游戏推荐|评测|杂谈|观点|复盘|看完|聊聊|关于)\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function questionAlreadyContainsCoreHint(question: string, hint: string): boolean {
  const tokens = [
    ...hint.split(/\s+/),
    ...(hint.match(/[\u4e00-\u9fff]{2,}/g) ?? []),
  ].filter((token) => token.length >= 2);
  return tokens.some((token) => !/^[0-9]+(?:\.[0-9]+)?$/.test(token) && question.includes(token));
}

function stripVersionNumbers(value: string): string {
  const stripped = value
    .replace(/\b[0-9]+(?:\.[0-9]+)?\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped || value;
}

function removeDuplicatedLeadingVersion(question: string, titleHint: string): string {
  if (!titleHint) {
    return question;
  }
  const titleVersions = titleHint.match(/[0-9]+(?:\.[0-9]+)?/g) ?? [];
  for (const version of titleVersions) {
    if (question.startsWith(version)) {
      return question.slice(version.length).trim();
    }
  }
  return question;
}

function buildFollowupQueries(input: {
  readonly question: string;
  readonly originalQuestion: string;
  readonly intent: FollowupWebSearchIntent;
  readonly entity: string;
  readonly titleHint: string;
  readonly intentTerms: string;
}): readonly string[] {
  const queries: string[] = [];
  const pushQuery = (query: string): void => {
    const normalized = normalizeSearchQuery(query);
    if (normalized && !queries.includes(normalized) && queries.length < maxQueryCountForIntent(input.intent)) {
      queries.push(normalized);
    }
  };

  if (input.intent === 'entity_intro' && input.entity) {
    const aliases = buildEntityAliases(input.entity);
    pushQuery([input.titleHint, input.entity, '介绍'].filter(Boolean).join(' '));
    if (aliases.length > 1) {
      pushQuery([input.titleHint, aliases.slice(0, 6).join(' ')].filter(Boolean).join(' '));
    }
    pushQuery([input.titleHint, input.entity, '官方'].filter(Boolean).join(' '));
    pushQuery([input.titleHint, input.entity, '角色 背景'].filter(Boolean).join(' '));
    return queries;
  }

  pushQuery([input.titleHint, input.question, input.intentTerms].filter(Boolean).join(' '));
  if (input.intent === 'release_date') {
    pushQuery([input.titleHint, input.question, '官方'].filter(Boolean).join(' '));
  }
  if (input.intent === 'ranking') {
    pushQuery([stripVersionNumbers(input.titleHint), input.question, '投票 榜单'].filter(Boolean).join(' '));
  }
  if (queries.length === 0) {
    pushQuery([input.titleHint, input.originalQuestion, input.intentTerms].filter(Boolean).join(' '));
  }
  return queries;
}

function maxQueryCountForIntent(intent: FollowupWebSearchIntent): number {
  switch (intent) {
    case 'entity_intro':
      return 3;
    case 'release_date':
    case 'ranking':
    case 'fact_check':
      return 2;
    case 'fresh_fact':
    case 'general':
    default:
      return 1;
  }
}

function buildRequiredEvidence(intent: FollowupWebSearchIntent): string {
  switch (intent) {
    case 'entity_intro':
      return '优先需要官方公告、角色 PV、游戏官网 / 社区官方信息；没有官方来源时，可用媒体和社区结果说明“暂未官方完整确认”。';
    case 'release_date':
      return '需要搜索结果直接给出日期、版本号或官方公告链接，不能只用“今日上线”类弱表述下结论。';
    case 'ranking':
      return '需要明确榜单、投票、播放量、热度或统计来源；普通讨论热度不能推出“最高 / 第一”。';
    case 'fact_check':
      return '需要能直接支撑或反驳问题说法的来源，弱相关结果只能作为背景。';
    case 'fresh_fact':
      return '需要近期来源或明确发布时间，过期来源只能作为背景。';
    case 'general':
    default:
      return '需要至少一条与问题直接相关的联网来源；来源弱时不要硬凑确定结论。';
  }
}

function extractQuestionEntity(question: string): string {
  let cleaned = question
    .replace(/^(请|麻烦|帮我|给我)?\s*(搜索|搜一下|搜搜|搜|查一下|查查|查)\s*/u, '')
    .replace(/^(请|麻烦|帮我|给我)\s*/u, '')
    .trim();
  cleaned = cleaned.split(/[，,。？?！!；;]/)[0] ?? cleaned;
  cleaned = cleaned
    .replace(/(给我)?(来)?(个|一个)?(简单)?介绍(一下)?$/u, '')
    .replace(/(是谁|是什么角色|是什么人物|什么角色|什么人物|资料|背景)$/u, '')
    .replace(/^(关于|有关)\s*/u, '')
    .trim();
  return normalizeSearchQuery(cleaned).slice(0, 40);
}

function buildEntityAliases(entity: string): readonly string[] {
  const aliases = new Set<string>();
  const add = (value: string): void => {
    const normalized = normalizeSearchQuery(value);
    if (normalized) {
      aliases.add(normalized);
    }
  };
  add(entity);
  return [...aliases];
}

function mergeSearchResultsForPlan(
  contexts: readonly MinimaxWebSearchContext[],
  plan: MinimaxWebSearchPlan,
): readonly MinimaxWebSearchResult[] {
  const merged = new Map<string, MinimaxWebSearchResult>();
  for (const context of contexts) {
    for (const result of context.results) {
      const key = normalizeResultUrl(result.url);
      const scored: MinimaxWebSearchResult = {
        ...result,
        sourceQuery: context.query,
        sourceType: classifySourceType(result),
        relevanceScore: scoreSearchResult(result, plan),
      };
      const existing = merged.get(key);
      if (!existing || (existing.relevanceScore ?? 0) < (scored.relevanceScore ?? 0)) {
        merged.set(key, scored);
      }
    }
  }
  return [...merged.values()].sort((a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0));
}

function normalizeResultUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    parsed.searchParams.sort();
    return parsed.toString();
  } catch {
    return url.trim();
  }
}

function classifySourceType(result: MinimaxWebSearchResult): MinimaxWebSearchSourceType {
  const haystack = `${result.title} ${result.url} ${result.snippet}`.toLowerCase();
  if (/官方|官网|official/.test(haystack)) {
    return 'official';
  }
  if (/news|media|reuters|apnews|bloomberg|theverge|36kr|qq\.com|sohu\.com|163\.com|ithome|新华社|澎湃/.test(haystack)) {
    return 'media';
  }
  if (/bilibili|youtube|facebook|x\.com|twitter|instagram|reddit|nga/.test(haystack)) {
    return 'community';
  }
  return 'weak';
}

function scoreSearchResult(result: MinimaxWebSearchResult, plan: MinimaxWebSearchPlan): number {
  const sourceType = classifySourceType(result);
  const sourceScore: Record<MinimaxWebSearchSourceType, number> = {
    official: 100,
    media: 60,
    community: 45,
    weak: 25,
  };
  const haystack = `${result.title} ${result.snippet}`.toLowerCase();
  let score = sourceScore[sourceType];
  if (plan.entity && containsLoosely(haystack, plan.entity)) {
    score += 20;
  }
  if (plan.topicHint && containsLoosely(haystack, plan.topicHint)) {
    score += 10;
  }
  if (plan.intent === 'release_date' && /上线|发布|日期|时间|更新|版本/.test(haystack)) {
    score += 10;
  }
  if (plan.intent === 'ranking' && /榜|排名|投票|热度|播放量|人气/.test(haystack)) {
    score += 10;
  }
  return score;
}

function containsLoosely(haystack: string, needle: string): boolean {
  const normalizedHaystack = haystack.replace(/[·・\s]/g, '').toLowerCase();
  const normalizedNeedle = needle.replace(/[·・\s]/g, '').toLowerCase();
  return normalizedNeedle.length >= 2 && normalizedHaystack.includes(normalizedNeedle);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createMiniMaxSearchHttpErrorMessage(status: number, detail: string): string {
  const hint =
    status === 401 || status === 403
      ? '这通常表示当前 MiniMax Key 没有联网搜索 / Token Plan 权限，或鉴权已失效。'
      : '如果普通提问可用但联网失败，通常是搜索端点权限或服务端暂时不可用。';
  return `MiniMax 联网搜索失败：HTTP ${status}。${hint}服务端返回：${trimDetail(detail)}`;
}

function createMiniMaxSearchBusinessErrorMessage(
  statusCode: string,
  statusMessage: string,
  detail: string,
): string {
  return `MiniMax 联网搜索失败：服务端业务状态 ${statusCode}（${statusMessage}）。这通常表示当前 MiniMax Key 没有联网搜索 / Token Plan 权限，或搜索服务拒绝了请求。服务端返回：${trimDetail(detail)}`;
}

function stringifyDetail(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function trimDetail(detail: string): string {
  const trimmed = detail.trim();
  return trimmed.length > 600 ? `${trimmed.slice(0, 600)}…` : trimmed;
}
