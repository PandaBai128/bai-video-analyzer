import { useEffect, useState } from 'react';
import { cn } from '@lib/utils';
import type { LearningMoment, LearningMomentKind } from '@core/types';
import { useUiText } from '@extension/ui/locale-context';

export interface LearningMomentCardProps {
  readonly moment: LearningMoment;
  readonly processing?: boolean;
  readonly onSeek: (timestamp: number) => void;
  readonly onUpdate: (input: {
    readonly kind: LearningMomentKind;
    readonly content: string;
  }) => void;
  readonly onProcess?: () => void;
  readonly onRemove: () => void;
}

export function LearningMomentCard(props: LearningMomentCardProps): JSX.Element {
  const { moment } = props;
  const t = useUiText();
  const [isEditing, setIsEditing] = useState(false);
  const [editKind, setEditKind] = useState<LearningMomentKind>(moment.kind);
  const [editContent, setEditContent] = useState(moment.content);

  useEffect(() => {
    setEditKind(moment.kind);
    setEditContent(moment.content);
    setIsEditing(false);
  }, [moment.id, moment.kind, moment.content]);

  const saveEdit = (): void => {
    const content = editContent.trim();
    if (!content) return;
    props.onUpdate({ kind: editKind, content });
    setIsEditing(false);
  };

  return (
    <article className="space-y-2 rounded-md bg-muted/60 p-2 text-xs">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <button
          type="button"
          className="shrink-0 font-medium text-primary"
          onClick={() =>
            moment.timestamp !== undefined ? props.onSeek(moment.timestamp) : undefined
          }
        >
          {moment.timestamp !== undefined
            ? formatSeconds(moment.timestamp)
            : formatMomentKind(moment.kind, t)}
        </button>
        <span className="rounded bg-background px-1.5 py-0.5 font-medium">
          {formatMomentKind(moment.kind, t)}
        </span>
        {moment.source ? (
          <span className="rounded bg-blue-50 px-1.5 py-0.5 font-medium text-blue-700">
            {formatMomentSource(moment, t)}
          </span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {isEditing ? null : (
            <button
              type="button"
              className="hover:text-foreground"
              onClick={() => setIsEditing(true)}
            >
              {t('编辑', 'Edit')}
            </button>
          )}
          <button
            type="button"
            aria-label={t('删除记录', 'Delete record')}
            className="hover:text-destructive"
            onClick={props.onRemove}
          >
            ×
          </button>
        </div>
      </div>

      {isEditing ? (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1">
            {(['note', 'insight', 'question', 'action'] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                className={cn(
                  'rounded-full px-2 py-0.5 text-[11px]',
                  editKind === kind
                    ? 'bg-foreground text-background'
                    : 'bg-background text-muted-foreground',
                )}
                onClick={() => setEditKind(kind)}
              >
                {formatMomentKind(kind, t)}
              </button>
            ))}
          </div>
          <textarea
            className="min-h-16 w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-xs leading-5"
            value={editContent}
            onChange={(event) => setEditContent(event.target.value)}
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!editContent.trim()}
              className="rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background disabled:opacity-50"
              onClick={saveEdit}
            >
              {t('保存修改', 'Save Changes')}
            </button>
            <button
              type="button"
              className="rounded-md border border-border bg-background px-2 py-1 text-xs hover:bg-accent"
              onClick={() => {
                setEditKind(moment.kind);
                setEditContent(moment.content);
                setIsEditing(false);
              }}
            >
              {t('取消', 'Cancel')}
            </button>
          </div>
        </div>
      ) : (
        <p className="whitespace-pre-wrap leading-5">{moment.content}</p>
      )}

      {!isEditing && moment.coach ? (
        <div className="rounded-md border border-border bg-background p-2 leading-5">
          <p className="text-[11px] font-medium text-muted-foreground">
            {t('补充说明', 'Extra note')}
          </p>
          <p className="mt-1 whitespace-pre-wrap">{moment.coach.response}</p>
          {moment.coach.nextAction ? (
            <p className="mt-2 rounded bg-muted/50 px-2 py-1 text-muted-foreground">
              {t('下一步：', 'Next step: ')}
              {moment.coach.nextAction}
            </p>
          ) : null}
        </div>
      ) : isEditing || !props.onProcess ? null : (
        <button
          type="button"
          disabled={props.processing}
          className="rounded-md border border-border bg-background px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
          onClick={props.onProcess}
        >
          {props.processing ? t('处理中...', 'Processing...') : t('补充说明', 'Add note')}
        </button>
      )}
    </article>
  );
}

function formatMomentSource(
  moment: LearningMoment,
  t: (zh: string, en: string) => string,
): string {
  if (moment.source === 'mentor_card') {
    return t('加入笔记', 'Added to notes');
  }
  return t('手动记录', 'Manual record');
}

function formatMomentKind(
  kind: LearningMomentKind,
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
