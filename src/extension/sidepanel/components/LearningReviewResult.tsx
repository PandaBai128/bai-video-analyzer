import type { LearningExchange, LearningMoment, LearningSession } from '@core/types';
import { useUiText } from '@extension/ui/locale-context';

export interface LearningReviewResultProps {
  readonly review: NonNullable<LearningSession['review']>;
  readonly moments: readonly LearningMoment[];
  readonly includedExchanges: readonly LearningExchange[];
  readonly onSeek: (timestamp: number) => void;
}

export function LearningReviewResult(props: LearningReviewResultProps): JSX.Element {
  const { review } = props;
  const t = useUiText();
  const hasRecords = props.moments.length > 0 || props.includedExchanges.length > 0;
  return (
    <div className="space-y-4 border-t border-border pt-3 text-sm">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('1. 视频讲了什么', '1. What the Video Says')}
        </p>
        <p className="mt-1 leading-6">{review.coreSummary}</p>
      </div>

      <div>
        <p className="font-semibold">{t('2. 我得到了什么', '2. What I Got')}</p>
        <div className="mt-2 space-y-3">
          <div>
            <p className="text-xs font-semibold text-muted-foreground">
              {t('我得到了什么', 'What I Got')}
            </p>
            <p className="mt-1 whitespace-pre-wrap font-medium leading-6">
              {review.finalReflection}
            </p>
            {review.personalInsights.length > 0 ? (
              <ReviewNumberedList items={review.personalInsights} />
            ) : (
              <p className="mt-2 text-muted-foreground">
                {t(
                  '暂无明确收获，可补充记录后重新生成。',
                  'No clear takeaways yet. Add records and regenerate notes.',
                )}
              </p>
            )}
          </div>
          <div>
            <p className="text-xs font-semibold text-muted-foreground">
              {t('我可以根据这个做什么', 'How I Can Use This')}
            </p>
            <p className="mt-1 whitespace-pre-wrap leading-6 text-muted-foreground">
              {review.transferReflection?.trim() ||
                t(
                  '暂无明确迁移方式，可补充记录后重新生成。',
                  'No clear transfer path yet. Add records and regenerate notes.',
                )}
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold text-muted-foreground">
              {t('下一步怎么做', 'Next Steps')}
            </p>
            {review.actionItems.length > 0 ? (
              <ReviewNumberedList items={review.actionItems} />
            ) : (
              <p className="mt-1 text-muted-foreground">
                {t('暂无必须执行的下一步。', 'No required next steps.')}
              </p>
            )}
          </div>
        </div>
      </div>

      <div>
        <p className="font-semibold">
          {t('3. 哪些观点值得参考', '3. Ideas Worth Referencing')}
        </p>
        {review.keyIdeas.length > 0 ? (
          <div className="mt-2 space-y-2">
            {review.keyIdeas.map((idea, index) => {
              const evidenceTimestamp = idea.evidenceTimestamp;
              return (
                <article key={`${idea.title}-${index}`} className="rounded-md bg-background p-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-medium leading-5">{idea.title}</p>
                    {evidenceTimestamp !== undefined ? (
                      <button
                        type="button"
                        className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/20"
                        onClick={() => props.onSeek(evidenceTimestamp)}
                      >
                        {formatSeconds(evidenceTimestamp)}
                      </button>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{idea.explanation}</p>
                </article>
              );
            })}
          </div>
        ) : (
          <p className="mt-1 text-muted-foreground">
            {t('暂无明确观点。', 'No specific ideas yet.')}
          </p>
        )}
      </div>

      <div>
        <p className="font-semibold">
          {t('4. 哪些我需要保留判断', '4. What I Need to Reserve Judgment On')}
        </p>
        {review.openQuestions.length > 0 ? (
          <ReviewList items={review.openQuestions} />
        ) : (
          <p className="mt-1 text-muted-foreground">
            {t('暂无需要特别保留判断的地方。', 'No major reservations yet.')}
          </p>
        )}
      </div>

      <div>
        <p className="font-semibold">{t('5. 我的记录', '5. My Records')}</p>
        {hasRecords ? (
          <div className="mt-2 space-y-2">
            {props.moments.map((moment) => {
              const timestamp = moment.timestamp;
              return (
                <article key={moment.id} className="rounded-md bg-background p-3 text-xs leading-5">
                  <div className="mb-1 flex items-center gap-2 text-muted-foreground">
                    <span className="rounded bg-muted px-1.5 py-0.5">
                      {formatMomentKind(moment.kind, t)}
                    </span>
                    {timestamp !== undefined ? (
                      <button
                        type="button"
                        className="font-medium text-primary hover:underline"
                        onClick={() => props.onSeek(timestamp)}
                      >
                        {formatSeconds(timestamp)}
                      </button>
                    ) : null}
                  </div>
                  <p className="whitespace-pre-wrap text-foreground">{moment.content}</p>
                </article>
              );
            })}
            {props.includedExchanges.map((exchange, index) => (
              <article key={exchange.id} className="rounded-md bg-background p-3 text-xs leading-5">
                <p className="font-semibold">
                  {t(`问答 ${index + 1}`, `Q&A ${index + 1}`)}
                </p>
                <p className="mt-1 text-muted-foreground">
                  {t('我问：', 'Question: ')}
                  {exchange.question}
                </p>
                <p className="mt-1 whitespace-pre-wrap">{exchange.answer}</p>
              </article>
            ))}
          </div>
        ) : (
          <p className="mt-1 text-muted-foreground">
            {t(
              '暂无手动记录或加入笔记的问答。',
              'No manual records or Q&A added to notes yet.',
            )}
          </p>
        )}
      </div>
    </div>
  );
}

function ReviewList(props: {
  readonly items: readonly string[];
}): JSX.Element | null {
  if (props.items.length === 0) return null;
  return (
    <div className="mt-1">
      <ul className="space-y-1 pl-4 text-muted-foreground">
        {props.items.map((item, index) => (
          <li key={`${item}-${index}`} className="list-disc leading-6">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReviewNumberedList(props: {
  readonly items: readonly string[];
}): JSX.Element | null {
  if (props.items.length === 0) return null;
  return (
    <ol className="mt-1 space-y-1 pl-4 text-muted-foreground">
      {props.items.map((item, index) => (
        <li key={`${item}-${index}`} className="list-decimal leading-6">
          {item}
        </li>
      ))}
    </ol>
  );
}

function formatMomentKind(
  kind: LearningMoment['kind'],
  t: (zh: string, en: string) => string,
): string {
  return {
    note: t('记录', 'Note'),
    insight: t('发现', 'Insight'),
    question: t('疑问', 'Question'),
    action: t('行动', 'Action'),
  }[kind];
}

function formatSeconds(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}
