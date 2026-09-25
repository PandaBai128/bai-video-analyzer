import type { LearningGuideDecision } from '@core/types';
import { useUiText } from '@extension/ui/locale-context';

export interface ContentOverviewProps {
  readonly decision: LearningGuideDecision;
  readonly contentType: string;
  readonly duration?: number | undefined;
  readonly isGenerating: boolean;
  readonly onSeek?: ((timestamp: number) => void) | undefined;
  readonly onRegenerate: () => void;
}

function formatTime(seconds: number): string {
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

function splitSummary(text: string): string[] {
  return text.split(/(?<=[。！？])|(?<=[.!?])\s+(?=\S)|\n+/u).map((part) => part.trim()).filter(Boolean);
}

function renderEmphasis(text: string): (string | JSX.Element)[] {
  return text.split(/(\*\*[^*]+\*\*)/gu).map((part, index) =>
    part.startsWith('**') && part.endsWith('**')
      ? <strong key={index} className="font-semibold text-foreground">{part.slice(2, -2)}</strong>
      : part,
  );
}

function emphasizeSummary(text: string): string {
  const plain = text.replace(/\*\*([^*]+)\*\*/gu, '$1');
  const shortMarks = [...text.matchAll(/\*\*([^*]+)\*\*/gu)]
    .map((match) => match[1]?.trim() ?? '')
    .filter((phrase) => phrase.length > 0 && phrase.length <= 18 && phrase.length <= plain.length / 4)
    .slice(0, 2);
  if (shortMarks.length > 0) {
    return shortMarks.reduce((marked, phrase) => marked.replace(phrase, `**${phrase}**`), plain);
  }
  const product = plain.match(/\b[A-Za-z][A-Za-z0-9+.-]{2,}(?:\s+[A-Za-z0-9+.-]+){0,2}/u)?.[0];
  const topic = plain.match(/(?:讨论|讲述|讲解|讲|介绍|分析|围绕|对比)([^，。！？；]{3,18})(?=[，。！？；]|$)/u)?.[1]?.trim();
  const highlight = product ?? topic;
  return highlight ? plain.replace(highlight, `**${highlight}**`) : plain;
}

function sharedTopicScore(a: string, b: string): number {
  const ignored = new Set(['作者', '观点', '建议', '视频', '内容', '细节', '问题', '选择']);
  const bigrams = new Set<string>();
  for (const group of a.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    for (let index = 0; index < group.length - 1; index += 1) {
      const pair = group.slice(index, index + 2);
      if (!ignored.has(pair)) bigrams.add(pair);
    }
  }
  return [...bigrams].filter((pair) => b.includes(pair)).length;
}

export function ContentOverview(props: ContentOverviewProps): JSX.Element {
  const t = useUiText();
  const points = props.decision.contentPoints ?? [];
  const isLegacy = points.length === 0;
  const needsRefresh = isLegacy || props.decision.coreViewpoints === undefined;
  const legacyPoints = isLegacy ? [...new Set(props.decision.worthReasons ?? [])].slice(0, 5) : [];
  const viewpoints = props.decision.coreViewpoints?.length
    ? props.decision.coreViewpoints
    : props.decision.learningValue ?? [];
  const jumps = (props.decision.quickJumps ?? []).filter(
    (jump) =>
      Number.isFinite(jump.timestamp) &&
      jump.timestamp >= 0 &&
      (props.duration === undefined || jump.timestamp <= props.duration),
  );
  const summary = props.decision.overallMeaning || props.decision.verdict || props.decision.reason;
  const summaryParts = splitSummary(emphasizeSummary(summary));
  const validTimestamp = (timestamp: number | undefined): timestamp is number =>
    timestamp !== undefined &&
    Number.isFinite(timestamp) &&
    timestamp >= 0 &&
    (props.duration === undefined || timestamp <= props.duration);
  const pointTimestamp = (point: (typeof points)[number]): number | undefined => {
    if (validTimestamp(point.timestamp)) return point.timestamp;
    if (point.timestamp !== undefined) return undefined;
    const matches = jumps
      .filter((jump) => !points.some((candidate) => candidate.timestamp === jump.timestamp))
      .map((jump) => ({ jump, score: sharedTopicScore(jump.title, `${point.title} ${point.detail}`) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score);
    const match = matches[0];
    if (!match) return undefined;
    const equallyMatchedPoints = points.filter(
      (candidate) => sharedTopicScore(match.jump.title, `${candidate.title} ${candidate.detail}`) === match.score,
    );
    return equallyMatchedPoints.length === 1 && equallyMatchedPoints[0] === point
      ? match.jump.timestamp
      : undefined;
  };

  return (
    <div className="space-y-3 pb-3" data-testid="content-overview">
      <section className="bai-content-card border border-border bg-card p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold tracking-wide text-primary">
            {t('内容速览', 'Content Overview')}
          </span>
          {props.contentType.trim() ? (
            <span className="bai-content-type-pill rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
              {props.contentType}
            </span>
          ) : null}
          {props.isGenerating ? (
            <span className="text-xs text-muted-foreground">{t('更新中…', 'Updating…')}</span>
          ) : null}
        </div>
        <h2 className="flex items-center gap-2 text-sm font-bold text-foreground">
          <span aria-hidden="true">🎬</span> {t('概述', 'Overview')}
        </h2>
        <div className="mt-2.5 space-y-2 break-words text-[13px] leading-[1.7] text-foreground">
          {summaryParts.map((part, index) => (
            <p key={`${part}-${index}`}>
              {renderEmphasis(part)}
            </p>
          ))}
        </div>
      </section>

      <section className="bai-content-card border border-border bg-card p-4">
        <h2 className="flex items-center gap-2 text-sm font-bold text-foreground">
          <span aria-hidden="true">🧭</span> {t('主要内容', 'Main content')}
        </h2>
        {points.length > 0 || legacyPoints.length > 0 ? (
          <ol className="mt-2 divide-y divide-border/70">
            {points.length
              ? points.map((point, index) => {
                  const timestamp = pointTimestamp(point);
                  return (
                    <li key={`${point.title}-${index}`} className="flex items-start gap-2 py-2.5 first:pt-2 last:pb-0">
                      <span aria-hidden="true" className="shrink-0 pt-0.5 text-[11px] font-semibold tabular-nums text-primary">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <h3 className="min-w-0 flex-1 break-words text-[13px] font-semibold leading-5 text-foreground">{point.title}</h3>
                          {timestamp !== undefined && props.onSeek ? (
                            <button
                              type="button"
                              className="shrink-0 rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-primary hover:bg-primary/20 focus-visible:outline-2 focus-visible:outline-primary"
                              aria-label={t(`跳转到 ${formatTime(timestamp)}：${point.title}`, `Jump to ${formatTime(timestamp)}: ${point.title}`)}
                              onClick={() => props.onSeek?.(timestamp)}
                            >
                              {formatTime(timestamp)}
                            </button>
                          ) : (
                            <span className="shrink-0 text-[10px] text-muted-foreground">{t('未定位', 'No time')}</span>
                          )}
                        </div>
                        <p className="mt-1 break-words text-[12px] leading-[1.65] text-muted-foreground">{point.detail}</p>
                      </div>
                    </li>
                  );
                })
              : legacyPoints.map((point, index) => (
                  <li key={`${point}-${index}`} className="py-2 text-[12px] leading-[1.65] text-foreground">
                    {point}
                  </li>
                ))}
          </ol>
        ) : (
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            {t('旧版结果缺少分段内容，重新生成后可查看。', 'This older result lacks segments. Regenerate to see them.')}
          </p>
        )}
        {needsRefresh && !props.isGenerating ? (
          <button
            type="button"
            className="mt-3 text-xs font-medium text-primary underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-primary"
            onClick={props.onRegenerate}
          >
            {t('重新生成，补全分段与观点', 'Regenerate segments and viewpoints')}
          </button>
        ) : null}
      </section>

      <section className="bai-content-card border border-border bg-card p-4">
        <h2 className="flex items-center gap-2 text-sm font-bold text-foreground">
          <span aria-hidden="true">💡</span> {t('核心观点', 'Core viewpoints')}
        </h2>
        {viewpoints.length > 0 ? (
          <ul className="mt-2 space-y-2.5">
            {viewpoints.slice(0, 4).map((viewpoint, index) => (
              <li key={`${viewpoint}-${index}`} className="flex gap-2 text-[12px] leading-[1.65] text-foreground">
                <span aria-hidden="true" className="shrink-0 text-primary">•</span>
                <span className="break-words">{renderEmphasis(viewpoint)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            {t('视频中没有可确认的明确观点。', 'No clear viewpoint could be confirmed from this video.')}
          </p>
        )}
      </section>

      <section className="bai-content-card border border-border bg-muted/25 p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <span aria-hidden="true">⚠️</span> {t('需要留意', 'Keep in mind')}
          </h2>
        {props.decision.reservations.length > 0 ? (
          <ul className="mt-2 space-y-1.5 text-xs leading-[1.65] text-muted-foreground">
            {props.decision.reservations.slice(0, 2).map((item, index) => (
              <li key={`${item}-${index}`} className="break-words">{renderEmphasis(item)}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">{t('暂无明确的补充提醒。', 'No specific caveats to add.')}</p>
        )}
      </section>
    </div>
  );
}
