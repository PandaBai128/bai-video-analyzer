import {
  LEARNING_SESSION_SCHEMA_VERSION,
  type LearningCoachSettings,
  type LearningExchange,
  type LearningGuide,
  type LearningGoal,
  type LearningMomentCoach,
  type LearningMoment,
  type LearningMomentKind,
  type LearningMomentSource,
  type LearningReview,
  type LearningSession,
  type VideoPlatform,
} from '@core/types';
import { db } from './db';
import { DEFAULT_UI_LOCALE, getArtifactLocale, isUiLocale, type UiLocale } from '@shared/locale-settings';

export const MAX_REVIEW_EXCHANGES = 8;
export const EMPTY_LEARNING_SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const MAX_LEARNING_SESSIONS = 500;
const MIGRATABLE_LEARNING_SESSION_SCHEMA_VERSION = 2;

const DEFAULT_GOAL: LearningGoal = {
  mode: 'adaptive',
  focus: '',
};

const DEFAULT_COACH: LearningCoachSettings = {
  enabled: false,
  intensity: 'light',
  customInstruction: '',
};

export function createLearningSessionId(platform: VideoPlatform, contentKey: string): string {
  return `${platform}:${contentKey}`;
}

export async function getLearningSession(input: {
  readonly platform: VideoPlatform;
  readonly contentKey: string;
}): Promise<LearningSession | null> {
  const id = createLearningSessionId(input.platform, input.contentKey);
  const session = await db.learningSessions.get(id);
  if (!session) {
    return null;
  }
  const migrated = migrateLearningSessionIfNeeded(session);
  if (!migrated) {
    await db.learningSessions.delete(id);
    return null;
  }
  const sanitized = sanitizeLearningSession(migrated.session);
  if (migrated.changed || sanitized.changed) {
    await db.learningSessions.put(sanitized.session);
  }
  return sanitized.session;
}

export async function getOrCreateLearningSession(input: {
  readonly platform: VideoPlatform;
  readonly contentKey: string;
  readonly now?: number;
}): Promise<LearningSession> {
  const now = input.now ?? Date.now();
  const existing = await getLearningSession(input);
  const session = existing ?? (await updateSession({ ...input, now }, (base) => base));
  try {
    await cleanupStaleEmptyLearningSessions({
      now,
      preserveId: createLearningSessionId(input.platform, input.contentKey),
    });
  } catch {
    // 清理失败不能影响当前视频学习会话读取。
  }
  return session;
}

export async function cleanupStaleEmptyLearningSessions(input?: {
  readonly now?: number;
  readonly preserveId?: string;
}): Promise<number> {
  const now = input?.now ?? Date.now();
  const sessions = await db.learningSessions.orderBy('updatedAt').toArray();
  const invalidIds = sessions
    .filter((session) => session.id !== input?.preserveId)
    .filter((session) => !migrateLearningSessionIfNeeded(session))
    .map((session) => session.id);
  const validSessions = sessions.filter(
    (session) => migrateLearningSessionIfNeeded(session) && !invalidIds.includes(session.id),
  );
  const staleEmptyIds = validSessions
    .filter((session) => session.id !== input?.preserveId)
    .filter(isEmptyLearningSession)
    .filter((session) => now - session.updatedAt >= EMPTY_LEARNING_SESSION_RETENTION_MS)
    .map((session) => session.id);

  const remainingCount = validSessions.length - staleEmptyIds.length;
  const overflowCount = Math.max(0, remainingCount - MAX_LEARNING_SESSIONS);
  const overflowEmptyIds =
    overflowCount > 0
      ? validSessions
          .filter((session) => session.id !== input?.preserveId)
          .filter((session) => !staleEmptyIds.includes(session.id))
          .filter(isEmptyLearningSession)
          .slice(0, overflowCount)
          .map((session) => session.id)
      : [];

  const ids = [...new Set([...invalidIds, ...staleEmptyIds, ...overflowEmptyIds])];
  if (ids.length > 0) {
    await db.learningSessions.bulkDelete(ids);
  }
  return ids.length;
}

export async function updateLearningGoal(input: {
  readonly platform: VideoPlatform;
  readonly contentKey: string;
  readonly goal: LearningGoal;
  readonly now?: number;
}): Promise<LearningSession> {
  return updateSession(input, (session) => ({
    ...withoutReview(session),
    goal: {
      mode: input.goal.mode,
      focus: input.goal.focus.trim().slice(0, 500),
      ...(input.goal.guideOptionId
        ? { guideOptionId: input.goal.guideOptionId.trim().slice(0, 80) }
        : {}),
      ...(input.goal.label ? { label: input.goal.label.trim().slice(0, 80) } : {}),
      ...(input.goal.instruction
        ? { instruction: input.goal.instruction.trim().slice(0, 1_200) }
        : {}),
    },
  }));
}

export async function updateLearningCoach(input: {
  readonly platform: VideoPlatform;
  readonly contentKey: string;
  readonly coach: LearningCoachSettings;
  readonly now?: number;
}): Promise<LearningSession> {
  return updateSession(input, (session) => ({
    ...session,
    coach: normalizeCoach(input.coach),
  }));
}

export async function saveLearningGuide(input: {
  readonly platform: VideoPlatform;
  readonly contentKey: string;
  readonly guide: LearningGuide;
  readonly now?: number;
}): Promise<LearningSession> {
  const locale = getArtifactLocale(input.guide);
  return updateSession(input, (session) => {
    const guidesByLocale = compactLocaleMap({
      ...getReadableGuidesByLocale(session),
      [locale]: input.guide,
    });
    return {
      ...withoutReviewForLocale(session, locale),
      guide: input.guide,
      ...(guidesByLocale ? { guidesByLocale } : {}),
      coach: applyGuideDefaultCoach(session),
    };
  });
}

export async function appendLearningMoment(input: {
  readonly platform: VideoPlatform;
  readonly contentKey: string;
  readonly kind: LearningMomentKind;
  readonly content: string;
  readonly source?: LearningMomentSource;
  readonly originTitle?: string;
  readonly timestamp?: number;
  readonly now?: number;
  readonly id?: string;
}): Promise<LearningSession> {
  const now = input.now ?? Date.now();
  const content = input.content.trim();
  const moment: LearningMoment = {
    id: input.id ?? `${now}:moment:${Math.random().toString(36).slice(2, 8)}`,
    kind: input.kind,
    content,
    ...(input.source ? { source: input.source } : {}),
    ...(input.originTitle ? { originTitle: input.originTitle.trim().slice(0, 120) } : {}),
    ...(typeof input.timestamp === 'number' && Number.isFinite(input.timestamp)
      ? { timestamp: Math.max(0, input.timestamp) }
      : {}),
    createdAt: now,
  };
  return updateSession({ ...input, now }, (session) => ({
    ...withoutReview(session),
    moments: [...session.moments, moment],
  }));
}

export async function updateLearningMoment(input: {
  readonly platform: VideoPlatform;
  readonly contentKey: string;
  readonly momentId: string;
  readonly kind: LearningMomentKind;
  readonly content: string;
  readonly now?: number;
}): Promise<LearningSession> {
  const content = input.content.trim();
  return updateSession(input, (session) => ({
    ...withoutReview(session),
    moments: session.moments.map((moment) => {
      if (moment.id !== input.momentId) return moment;
      const changed = moment.kind !== input.kind || moment.content !== content;
      if (!changed) {
        return { ...moment, kind: input.kind, content };
      }
      const { coach: _coach, ...momentWithoutCoach } = moment;
      return { ...momentWithoutCoach, kind: input.kind, content };
    }),
  }));
}

export async function saveLearningMomentCoach(input: {
  readonly platform: VideoPlatform;
  readonly contentKey: string;
  readonly momentId: string;
  readonly coach: LearningMomentCoach;
  readonly now?: number;
}): Promise<LearningSession> {
  return updateSession(input, (session) => ({
    ...withoutReview(session),
    moments: session.moments.map((moment) =>
      moment.id === input.momentId ? { ...moment, coach: input.coach } : moment,
    ),
  }));
}

export async function removeLearningMoment(input: {
  readonly platform: VideoPlatform;
  readonly contentKey: string;
  readonly momentId: string;
  readonly now?: number;
}): Promise<LearningSession> {
  return updateSession(input, (session) => ({
    ...withoutReview(session),
    moments: session.moments.filter((moment) => moment.id !== input.momentId),
  }));
}

export async function saveLearningExchange(input: {
  readonly platform: VideoPlatform;
  readonly contentKey: string;
  readonly exchange: LearningExchange;
  readonly now?: number;
}): Promise<LearningSession | null> {
  const hasIncludedFlag = Object.prototype.hasOwnProperty.call(
    input.exchange,
    'includedInReview',
  );
  if (!hasIncludedFlag) {
    return getLearningSession(input);
  }
  if (input.exchange.includedInReview !== true) {
    const existing = await getLearningSession(input);
    const hasExistingExchange = existing?.exchanges.some(
      (exchange) => exchange.id === input.exchange.id,
    );
    if (!hasExistingExchange) {
      return existing ?? null;
    }
  }
  return updateSession(input, (session) => {
    const existing = session.exchanges.find((exchange) => exchange.id === input.exchange.id);
    const includedInReview = input.exchange.includedInReview === true;
    if (!includedInReview) {
      return {
        ...(existing?.includedInReview === true ? withoutReview(session) : session),
        exchanges: session.exchanges.filter((exchange) => exchange.id !== input.exchange.id),
      };
    }
    const includedCountWithoutCurrent = session.exchanges.filter(
      (exchange) => exchange.includedInReview === true && exchange.id !== input.exchange.id,
    ).length;
    if (includedInReview && includedCountWithoutCurrent >= MAX_REVIEW_EXCHANGES) {
      throw new Error(`最多只能加入 ${MAX_REVIEW_EXCHANGES} 条提问问答到学习笔记`);
    }
    const normalized: LearningExchange = {
      id: input.exchange.id,
      question: input.exchange.question.trim().slice(0, 2_000),
      answer: input.exchange.answer.trim().slice(0, 12_000),
      ...(includedInReview ? { includedInReview: true } : {}),
      createdAt: input.exchange.createdAt,
    };
    const existingIndex = session.exchanges.findIndex((exchange) => exchange.id === normalized.id);
    const exchanges =
      existingIndex >= 0
        ? session.exchanges.map((exchange, index) =>
            index === existingIndex ? normalized : exchange,
          )
        : [...session.exchanges, normalized];
    const affectsReview =
      existing?.includedInReview === true ||
      normalized.includedInReview === true ||
      existing?.includedInReview !== normalized.includedInReview;
    return {
      ...(affectsReview ? withoutReview(session) : session),
      exchanges,
    };
  });
}

export async function saveLearningReview(input: {
  readonly platform: VideoPlatform;
  readonly contentKey: string;
  readonly review: LearningReview;
  readonly now?: number;
}): Promise<LearningSession> {
  const locale = getArtifactLocale(input.review);
  return updateSession(input, (session) => {
    const reviewsByLocale = compactLocaleMap({
      ...getReadableReviewsByLocale(session),
      [locale]: input.review,
    });
    return {
      ...session,
      review: input.review,
      ...(reviewsByLocale ? { reviewsByLocale } : {}),
    };
  });
}

async function updateSession(
  input: {
    readonly platform: VideoPlatform;
    readonly contentKey: string;
    readonly now?: number;
  },
  mutate: (session: LearningSession) => LearningSession,
): Promise<LearningSession> {
  const now = input.now ?? Date.now();
  const id = createLearningSessionId(input.platform, input.contentKey);
  return db.transaction('rw', db.learningSessions, async () => {
    const existing = await db.learningSessions.get(id);
    const migrated = existing ? migrateLearningSessionIfNeeded(existing) : null;
    const base = migrated
      ? sanitizeLearningSession(migrated.session).session
      : createEmptySession({
          id,
          platform: input.platform,
          contentKey: input.contentKey,
          now,
        });
    const next = {
      ...mutate(base),
      updatedAt: now,
    };
    await db.learningSessions.put(next);
    return next;
  });
}

function createEmptySession(input: {
  readonly id: string;
  readonly platform: VideoPlatform;
  readonly contentKey: string;
  readonly now: number;
}): LearningSession {
  return {
    id: input.id,
    schemaVersion: LEARNING_SESSION_SCHEMA_VERSION,
    platform: input.platform,
    videoId: input.contentKey,
    goal: DEFAULT_GOAL,
    coach: DEFAULT_COACH,
    moments: [],
    exchanges: [],
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function isEmptyLearningSession(session: LearningSession): boolean {
  return (
    session.schemaVersion === LEARNING_SESSION_SCHEMA_VERSION &&
    session.moments.length === 0 &&
    session.exchanges.length === 0 &&
    !session.guide &&
    !session.review &&
    !hasLocaleArtifacts(session.guidesByLocale) &&
    !hasLocaleArtifacts(session.reviewsByLocale) &&
    session.goal.mode === DEFAULT_GOAL.mode &&
    session.goal.focus === DEFAULT_GOAL.focus &&
    session.goal.guideOptionId === undefined &&
    session.goal.label === undefined &&
    session.goal.instruction === undefined &&
    session.coach.enabled === DEFAULT_COACH.enabled &&
    session.coach.intensity === DEFAULT_COACH.intensity &&
    session.coach.customInstruction === DEFAULT_COACH.customInstruction
  );
}

function isReadableLearningSession(session: LearningSession): boolean {
  return (
    session.schemaVersion === LEARNING_SESSION_SCHEMA_VERSION &&
    isReadableLearningSessionShape(session)
  );
}

function isReadableLearningSessionShape(session: LearningSession): boolean {
  return (
    typeof session.id === 'string' &&
    typeof session.platform === 'string' &&
    typeof session.videoId === 'string' &&
    Array.isArray(session.moments) &&
    Array.isArray(session.exchanges) &&
    typeof session.goal?.mode === 'string' &&
    typeof session.goal?.focus === 'string' &&
    typeof session.coach?.enabled === 'boolean' &&
    typeof session.coach?.intensity === 'string' &&
    typeof session.coach?.customInstruction === 'string' &&
    Number.isFinite(session.createdAt) &&
    Number.isFinite(session.updatedAt)
  );
}

function migrateLearningSessionIfNeeded(session: LearningSession): {
  readonly session: LearningSession;
  readonly changed: boolean;
} | null {
  if (isReadableLearningSession(session)) {
    return { session, changed: false };
  }
  if (
    session.schemaVersion !== MIGRATABLE_LEARNING_SESSION_SCHEMA_VERSION ||
    !isReadableLearningSessionShape(session)
  ) {
    return null;
  }
  const { guide: _guide, review: _review, ...rest } = session;
  return {
    session: {
      ...rest,
      schemaVersion: LEARNING_SESSION_SCHEMA_VERSION,
    },
    changed: true,
  };
}

function sanitizeLearningSession(session: LearningSession): {
  readonly session: LearningSession;
  readonly changed: boolean;
} {
  let next = session;
  let changed = false;
  const normalizedGuideArtifacts = normalizeGuideArtifacts(next);
  if (normalizedGuideArtifacts.changed) {
    next = normalizedGuideArtifacts.session;
    changed = true;
  }
  const normalizedReviewArtifacts = normalizeReviewArtifacts(next);
  if (normalizedReviewArtifacts.changed) {
    next = normalizedReviewArtifacts.session;
    changed = true;
  }
  if (next.guide !== undefined && !isReadableLearningGuide(next.guide)) {
    const { guide: _guide, ...rest } = next;
    next = rest;
    changed = true;
  }
  if (next.review !== undefined && !isReadableLearningReview(next.review)) {
    const { review: _review, ...rest } = next;
    next = rest;
    changed = true;
  }
  return { session: next, changed };
}

function isReadableLearningGuide(value: unknown): value is LearningGuide {
  if (!isRecord(value)) return false;
  if (
    typeof value.contentType !== 'string' ||
    typeof value.contentTypeReason !== 'string' ||
    typeof value.suggestedStance !== 'string' ||
    !isFiniteNumber(value.generatedAt) ||
    typeof value.modelUsed !== 'string'
  ) {
    return false;
  }
  if (!isRecord(value.decision)) return false;
  const decision = value.decision;
  return (
    isDecisionRating(decision.rating) &&
    isFiniteNumber(decision.score) &&
    typeof decision.verdict === 'string' &&
    typeof decision.overallMeaning === 'string' &&
    typeof decision.reason === 'string' &&
    isOptionalStringArray(decision.worthReasons) &&
    isStringArray(decision.bestFor) &&
    isStringArray(decision.notFor) &&
    isOptionalStringArray(decision.learningValue) &&
    Array.isArray(decision.timePlans) &&
    Array.isArray(decision.mustWatch) &&
    Array.isArray(decision.canWatch) &&
    Array.isArray(decision.canSkim) &&
    Array.isArray(decision.canSkip) &&
    isStringArray(decision.reservations)
  );
}

function isReadableLearningReview(value: unknown): value is LearningReview {
  if (!isRecord(value)) return false;
  return (
    typeof value.coreSummary === 'string' &&
    Array.isArray(value.keyIdeas) &&
    isStringArray(value.personalInsights) &&
    isStringArray(value.openQuestions) &&
    isStringArray(value.actionItems) &&
    typeof value.finalReflection === 'string' &&
    isFiniteNumber(value.generatedAt) &&
    typeof value.modelUsed === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isOptionalStringArray(value: unknown): boolean {
  return value === undefined || isStringArray(value);
}

function isDecisionRating(value: unknown): boolean {
  return (
    value === 'worth_watching' ||
    value === 'selective' ||
    value === 'quick_browse' ||
    value === 'skip'
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function withoutReview(
  session: LearningSession,
): Omit<LearningSession, 'review' | 'reviewsByLocale'> {
  const { review: _review, reviewsByLocale: _reviewsByLocale, ...rest } = session;
  return rest;
}

function withoutReviewForLocale(session: LearningSession, locale: UiLocale): LearningSession {
  const reviewsByLocale = { ...getReadableReviewsByLocale(session) };
  delete reviewsByLocale[locale];
  const nextReview =
    session.review && getArtifactLocale(session.review) !== locale
      ? session.review
      : pickPreferredLocaleArtifact(reviewsByLocale);
  const { review: _review, reviewsByLocale: _reviewsByLocale, ...rest } = session;
  return {
    ...rest,
    ...(nextReview ? { review: nextReview } : {}),
    ...(hasLocaleArtifacts(reviewsByLocale) ? { reviewsByLocale } : {}),
  };
}

function normalizeGuideArtifacts(session: LearningSession): {
  readonly session: LearningSession;
  readonly changed: boolean;
} {
  const guidesByLocale = getReadableGuidesByLocale(session);
  const guideReadable = session.guide !== undefined && isReadableLearningGuide(session.guide);
  if (guideReadable) {
    guidesByLocale[getArtifactLocale(session.guide)] = session.guide;
  }
  const guide = guideReadable ? session.guide : pickPreferredLocaleArtifact(guidesByLocale);
  const next = withGuideArtifacts(session, guide, guidesByLocale);
  return { session: next, changed: next !== session };
}

function normalizeReviewArtifacts(session: LearningSession): {
  readonly session: LearningSession;
  readonly changed: boolean;
} {
  const reviewsByLocale = getReadableReviewsByLocale(session);
  const reviewReadable = session.review !== undefined && isReadableLearningReview(session.review);
  if (reviewReadable) {
    reviewsByLocale[getArtifactLocale(session.review)] = session.review;
  }
  const review = reviewReadable ? session.review : pickPreferredLocaleArtifact(reviewsByLocale);
  const next = withReviewArtifacts(session, review, reviewsByLocale);
  return { session: next, changed: next !== session };
}

function withGuideArtifacts(
  session: LearningSession,
  guide: LearningGuide | undefined,
  guidesByLocale: Partial<Record<UiLocale, LearningGuide>>,
): LearningSession {
  const compacted = compactLocaleMap(guidesByLocale);
  const { guide: _guide, guidesByLocale: _guidesByLocale, ...rest } = session;
  const next = {
    ...rest,
    ...(guide ? { guide } : {}),
    ...(compacted ? { guidesByLocale: compacted } : {}),
  };
  return areLearningSessionsShallowEqual(session, next) ? session : next;
}

function withReviewArtifacts(
  session: LearningSession,
  review: LearningReview | undefined,
  reviewsByLocale: Partial<Record<UiLocale, LearningReview>>,
): LearningSession {
  const compacted = compactLocaleMap(reviewsByLocale);
  const { review: _review, reviewsByLocale: _reviewsByLocale, ...rest } = session;
  const next = {
    ...rest,
    ...(review ? { review } : {}),
    ...(compacted ? { reviewsByLocale: compacted } : {}),
  };
  return areLearningSessionsShallowEqual(session, next) ? session : next;
}

function getReadableGuidesByLocale(
  session: LearningSession,
): Partial<Record<UiLocale, LearningGuide>> {
  return collectReadableLocaleArtifacts(session.guidesByLocale, isReadableLearningGuide);
}

function getReadableReviewsByLocale(
  session: LearningSession,
): Partial<Record<UiLocale, LearningReview>> {
  return collectReadableLocaleArtifacts(session.reviewsByLocale, isReadableLearningReview);
}

function collectReadableLocaleArtifacts<T>(
  value: unknown,
  isReadable: (item: unknown) => item is T,
): Partial<Record<UiLocale, T>> {
  if (!isRecord(value)) {
    return {};
  }
  const result: Partial<Record<UiLocale, T>> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isUiLocale(key) && isReadable(item)) {
      result[key] = item;
    }
  }
  return result;
}

function compactLocaleMap<T>(
  value: Partial<Record<UiLocale, T>>,
): Partial<Record<UiLocale, T>> | undefined {
  const compacted: Partial<Record<UiLocale, T>> = {};
  if (value['zh-CN'] !== undefined) {
    compacted['zh-CN'] = value['zh-CN'];
  }
  if (value['en-US'] !== undefined) {
    compacted['en-US'] = value['en-US'];
  }
  return hasLocaleArtifacts(compacted) ? compacted : undefined;
}

function pickPreferredLocaleArtifact<T>(
  value: Partial<Record<UiLocale, T>>,
): T | undefined {
  return value[DEFAULT_UI_LOCALE] ?? value['en-US'];
}

function hasLocaleArtifacts<T>(value: Partial<Record<UiLocale, T>> | undefined): boolean {
  return value?.['zh-CN'] !== undefined || value?.['en-US'] !== undefined;
}

function areLearningSessionsShallowEqual(left: LearningSession, right: LearningSession): boolean {
  return (
    left.guide === right.guide &&
    left.review === right.review &&
    left.guidesByLocale === right.guidesByLocale &&
    left.reviewsByLocale === right.reviewsByLocale
  );
}

function normalizeCoach(coach: LearningCoachSettings): LearningCoachSettings {
  const intensity: LearningCoachSettings['intensity'] =
    coach.intensity === 'deep' || coach.intensity === 'off' ? coach.intensity : 'light';
  return {
    enabled: coach.enabled && intensity !== 'off',
    intensity,
    customInstruction: coach.customInstruction.trim().slice(0, 500),
  };
}

function applyGuideDefaultCoach(session: LearningSession): LearningCoachSettings {
  const coach = normalizeCoach(session.coach);
  return coach;
}
