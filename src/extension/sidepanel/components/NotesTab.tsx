import { useState, type Ref, type UIEventHandler } from 'react';
import { cn } from '@lib/utils';
import type {
  LearningExchange,
  LearningMomentKind,
  LearningMomentSource,
  LearningSession,
} from '@core/types';
import { LearningMomentCard } from './LearningMomentCard';
import { LearningReviewResult } from './LearningReviewResult';
import { IncludedLearningExchanges } from './IncludedLearningExchanges';
import { useUiText } from '@extension/ui/locale-context';

export interface NotesTabProps {
  readonly session: LearningSession | null;
  readonly hasContentContext: boolean;
  readonly currentTime?: number;
  readonly isPreparing: boolean;
  readonly isMutating: boolean;
  readonly isGenerating: boolean;
  readonly isExporting: boolean;
  readonly exportedFolderName: string;
  readonly scrollContainerRef?: Ref<HTMLDivElement>;
  readonly onScroll?: UIEventHandler<HTMLDivElement>;
  readonly onPrepareContentContext: () => void;
  readonly onAddMoment: (input: {
    readonly kind: LearningMomentKind;
    readonly content: string;
    readonly source?: LearningMomentSource;
    readonly originTitle?: string;
    readonly timestamp?: number;
  }) => Promise<LearningSession | null>;
  readonly onUpdateMoment: (input: {
    readonly momentId: string;
    readonly kind: LearningMomentKind;
    readonly content: string;
  }) => Promise<void>;
  readonly onRemoveMoment: (momentId: string) => Promise<void>;
  readonly onToggleExchangeInReview: (
    exchange: LearningExchange,
    includedInReview: boolean,
  ) => Promise<void>;
  readonly onGenerateReview: (forceRefresh?: boolean) => Promise<void>;
  readonly onExport: () => Promise<void>;
  readonly onSeek: (timestamp: number) => void;
}

export function NotesTab(props: NotesTabProps): JSX.Element {
  const t = useUiText();
  const [noteKind, setNoteKind] = useState<LearningMomentKind>('note');
  const [noteDraft, setNoteDraft] = useState('');
  const noteOptions: readonly {
    readonly value: LearningMomentKind;
    readonly label: string;
    readonly placeholder: string;
  }[] = [
    { value: 'note', label: t('记录', 'Note'), placeholder: t('把当前片段加入笔记…', 'Add the current segment to notes...') },
    { value: 'insight', label: t('发现', 'Insight'), placeholder: t('这一段对我有启发的是…', 'What this segment helps me realize...') },
    { value: 'question', label: t('疑问', 'Question'), placeholder: t('这里我还需要确认的是…', 'What I still need to verify here...') },
    { value: 'action', label: t('行动', 'Action'), placeholder: t('看完后我准备尝试的是…', 'After watching, I plan to try...') },
  ];

  const submitNote = async (): Promise<void> => {
    const content = noteDraft.trim();
    if (!content) return;
    const saved = await props.onAddMoment({
      kind: noteKind,
      content,
      ...(props.currentTime !== undefined ? { timestamp: props.currentTime } : {}),
    });
    if (saved) {
      setNoteDraft('');
    }
  };

  if (!props.hasContentContext) {
    return (
      <div
        ref={props.scrollContainerRef}
        className="h-full min-h-0 space-y-3 overflow-y-auto pt-3"
        data-scroll-tab="notes"
        data-testid="notes-no-context"
        onScroll={props.onScroll}
      >
        <div className="rounded-md border border-dashed border-border bg-muted/40 p-3 text-sm leading-6 text-muted-foreground">
          {t('需要先读取当前视频字幕，才能整理学习笔记。', 'Read the current video subtitles before organizing study notes.')}
        </div>
        <button
          type="button"
          disabled={props.isPreparing}
          className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
          onClick={props.onPrepareContentContext}
        >
          {props.isPreparing ? t('正在开启...', 'Opening...') : t('开启笔记', 'Open Notes')}
        </button>
      </div>
    );
  }

  const review = props.session?.review;
  const currentNoteOption =
    noteOptions.find((option) => option.value === noteKind) ?? noteOptions[0]!;
  const includedReviewExchanges =
    props.session?.exchanges.filter((exchange) => exchange.includedInReview === true) ?? [];

  return (
    <div
      ref={props.scrollContainerRef}
      className="min-h-0 flex-1 space-y-4 overflow-y-auto pt-3"
      data-scroll-tab="notes"
      data-testid="notes-tab"
      onScroll={props.onScroll}
    >
      <section className="space-y-2 rounded-md border border-border p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-sm font-semibold">{t('1. 加入笔记', '1. Add to Notes')}</p>
            <p className="text-xs text-muted-foreground">
              {props.currentTime !== undefined
                ? t(
                    `会附带当前时间 ${formatSeconds(props.currentTime)}`,
                    `Includes current time ${formatSeconds(props.currentTime)}`,
                  )
                : t('尚未获取播放位置', 'Playback position not available')}
            </p>
          </div>
          <span className="text-xs text-muted-foreground">
            {t(`${props.session?.moments.length ?? 0} 条`, `${props.session?.moments.length ?? 0} items`)}
          </span>
        </div>

        <div className="flex gap-1">
          {noteOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              className={cn(
                'rounded-full px-2.5 py-1 text-xs',
                option.value === noteKind
                  ? 'bg-foreground text-background'
                  : 'bg-muted text-muted-foreground',
              )}
              onClick={() => setNoteKind(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <textarea
          className="min-h-20 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm"
          value={noteDraft}
          placeholder={currentNoteOption.placeholder}
          onChange={(event) => setNoteDraft(event.target.value)}
          data-testid="learning-note-input"
        />
        <button
          type="button"
          disabled={props.isMutating || !noteDraft.trim()}
          className="w-full rounded-md bg-foreground px-3 py-2 text-sm font-medium text-background disabled:opacity-50"
          onClick={() => void submitNote()}
        >
          {t('加入笔记', 'Add to Notes')}
        </button>

        {props.session?.moments.length ? (
          <div className="space-y-2 border-t border-border pt-2">
            {props.session.moments
              .slice()
              .reverse()
              .map((moment) => (
                <LearningMomentCard
                  key={moment.id}
                  moment={moment}
                  onSeek={props.onSeek}
                  onUpdate={(input) =>
                    void props.onUpdateMoment({
                      momentId: moment.id,
                      ...input,
                    })
                  }
                  onRemove={() => void props.onRemoveMoment(moment.id)}
                />
              ))}
          </div>
        ) : null}
      </section>

      {includedReviewExchanges.length ? (
        <IncludedLearningExchanges
          exchanges={includedReviewExchanges}
          onRemove={(exchange) => void props.onToggleExchangeInReview(exchange, false)}
        />
      ) : null}

      <section className="space-y-3 rounded-md border border-primary/30 bg-accent/40 p-3">
        <div>
          <p className="text-sm font-semibold">{review ? t('学习笔记', 'Study Notes') : t('生成学习笔记', 'Generate Study Notes')}</p>
          <p className="text-xs leading-5 text-muted-foreground">
            {t(
              '笔记整理视频讲了什么、我得到了什么、值得参考的观点、需要保留判断的地方和我的记录。',
              'Notes organize what the video says, what I got, useful ideas, reservations, and my records.',
            )}
          </p>
        </div>
        <button
          type="button"
          disabled={props.isGenerating || props.isMutating}
          className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
          onClick={() => void props.onGenerateReview(Boolean(review))}
        >
          {props.isGenerating
            ? t('正在整理学习笔记...', 'Organizing study notes...')
            : review
              ? t('重新生成笔记', 'Regenerate Notes')
              : t('生成学习笔记', 'Generate Study Notes')}
        </button>

        {review ? (
          <LearningReviewResult
            review={review}
            moments={props.session?.moments ?? []}
            includedExchanges={includedReviewExchanges}
            onSeek={props.onSeek}
          />
        ) : null}
      </section>

      <section className="space-y-2 border-t border-border pb-1 pt-3">
        <button
          type="button"
          disabled={!review || props.isExporting}
          className="w-full rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
          onClick={() => void props.onExport()}
        >
          {props.isExporting ? t('导出中...', 'Exporting...') : t('导出 Markdown 笔记', 'Export Markdown Notes')}
        </button>
        <p className="text-xs text-muted-foreground">
          {props.exportedFolderName
            ? t(`已导出到：${props.exportedFolderName}`, `Exported to: ${props.exportedFolderName}`)
            : t(
                '输出一个标准 Markdown 文件，包含视频信息、学习笔记和加入笔记的内容。',
                'Outputs a standard Markdown file with video info, study notes, and saved note content.',
              )}
        </p>
      </section>
    </div>
  );
}

function formatSeconds(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}
