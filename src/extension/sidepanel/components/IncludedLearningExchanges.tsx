import type { LearningExchange } from '@core/types';
import { useUiText } from '@extension/ui/locale-context';

export interface IncludedLearningExchangesProps {
  readonly exchanges: readonly LearningExchange[];
  readonly onRemove: (exchange: LearningExchange) => void;
}

export function IncludedLearningExchanges(props: IncludedLearningExchangesProps): JSX.Element {
  const t = useUiText();
  return (
    <section className="space-y-2 rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold">
          {t('已加入笔记的问答', 'Q&A Added to Notes')}
        </p>
        <span className="text-xs text-muted-foreground">{props.exchanges.length}/8</span>
      </div>
      <div className="space-y-2">
        {props.exchanges
          .slice()
          .reverse()
          .map((exchange) => (
            <LearningExchangeCard
              key={exchange.id}
              exchange={exchange}
              onRemove={() => props.onRemove(exchange)}
              t={t}
            />
          ))}
      </div>
    </section>
  );
}

function LearningExchangeCard(props: {
  readonly exchange: LearningExchange;
  readonly onRemove: () => void;
  readonly t: (zh: string, en: string) => string;
}): JSX.Element {
  return (
    <article className="rounded-md bg-muted/50 p-2 text-xs">
      <p className="font-medium leading-5">
        {props.t('问：', 'Q: ')}
        {props.exchange.question}
      </p>
      <p className="mt-1 max-h-16 overflow-hidden leading-5 text-muted-foreground">
        {props.t('答：', 'A: ')}
        {props.exchange.answer}
      </p>
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          className="rounded-md border border-border bg-background px-2 py-1 text-xs font-medium hover:bg-accent"
          onClick={props.onRemove}
        >
          {props.t('移出笔记', 'Remove from Notes')}
        </button>
      </div>
    </article>
  );
}
