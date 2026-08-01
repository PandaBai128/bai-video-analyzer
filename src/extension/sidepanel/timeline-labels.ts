import type { TimelineContentTag, TimelineNode, VideoChapter } from '@core/types';

export interface TimelineDisplayTag {
  readonly kind: string;
  readonly label: string;
  readonly className: string;
}

type Translate = (zh: string, en: string) => string;

interface TimelineContentItem {
  readonly title: string;
  readonly summary: string;
  readonly contentTag?: TimelineContentTag | undefined;
}

export function getTimelineChapterPriorityTag(
  chapter: TimelineContentItem & { readonly importance?: VideoChapter['importance'] | undefined },
  t: Translate,
): TimelineDisplayTag | null {
  const text = `${chapter.title} ${chapter.summary}`;
  if (/广告|赞助|推广/u.test(text) || chapter.importance === 'skip') {
    return {
      kind: 'skip',
      label: /广告|赞助|推广/u.test(text) ? t('广告', 'Ad') : t('可跳', 'Skip'),
      className: 'bg-slate-100 text-slate-700',
    };
  }
  if (chapter.importance === 'must-watch') {
    return { kind: 'must_watch', label: t('重点', 'Key'), className: 'bg-emerald-600 text-white' };
  }
  if (chapter.importance === 'optional') {
    return { kind: 'optional', label: t('选看', 'Optional'), className: 'bg-muted text-muted-foreground' };
  }
  return null;
}

export function getTimelineSegmentPriorityTag(
  node: TimelineContentItem & {
    readonly importance?: TimelineNode['importance'] | undefined;
    readonly reasoning?: string | undefined;
    readonly watchPrompt?: string | undefined;
  },
  t: Translate,
): TimelineDisplayTag | null {
  const text = [node.title, node.summary, node.reasoning, node.watchPrompt]
    .filter(Boolean)
    .join(' ');
  if (/广告|赞助|推广/u.test(text) || node.importance === 'skip') {
    return {
      kind: 'skip',
      label: /广告|赞助|推广/u.test(text) ? t('广告', 'Ad') : t('可跳', 'Skip'),
      className: 'bg-slate-100 text-slate-700',
    };
  }
  if (node.importance === 'must-watch') {
    return { kind: 'must_watch', label: t('重点', 'Key'), className: 'bg-emerald-600 text-white' };
  }
  if (node.importance === 'optional') {
    return { kind: 'optional', label: t('选看', 'Optional'), className: 'bg-muted text-muted-foreground' };
  }
  return null;
}

export function getTimelineContentTag(
  item: TimelineContentItem,
  t: Translate,
): TimelineDisplayTag | null {
  const text = `${item.title} ${item.summary}`;
  const refinedTag = item.contentTag ? refineExplicitTag(item.contentTag, text) : undefined;
  return refinedTag
    ? getTimelineExplicitContentTag(refinedTag, t)
    : inferTimelineContentTag(text, t);
}

function refineExplicitTag(tag: TimelineContentTag, text: string): TimelineContentTag {
  if (
    tag === 'tool' &&
    /专武|武器|装备|配装|驱动盘|圣遗物|遗器|影画|命座|星魂|配队|加点|技能(?:升级|等级|配置)|天赋/u.test(text)
  ) {
    return 'setup';
  }
  if (tag === 'experience' && /操作要点|操作技巧|输出循环|手法|打法|步骤|流程/u.test(text)) {
    return 'method';
  }
  if (tag === 'transition' && /实战(?:演示|测试|过程)?|演示|操作展示|效果展示|测试过程/u.test(text)) {
    return 'demo';
  }
  return tag;
}

function getTimelineExplicitContentTag(
  tag: TimelineContentTag,
  t: Translate,
): TimelineDisplayTag {
  switch (tag) {
    case 'concept':
      return { kind: 'concept', label: t('概念', 'Concept'), className: 'bg-cyan-100 text-cyan-800' };
    case 'method':
      return { kind: 'method', label: t('方法', 'Method'), className: 'bg-emerald-100 text-emerald-800' };
    case 'demo':
      return { kind: 'demo', label: t('演示', 'Demo'), className: 'bg-zinc-100 text-zinc-800' };
    case 'case':
      return { kind: 'case', label: t('案例', 'Case'), className: 'bg-amber-100 text-amber-800' };
    case 'tool':
      return { kind: 'tool', label: t('工具', 'Tool'), className: 'bg-teal-100 text-teal-800' };
    case 'setup':
      return { kind: 'setup', label: t('配置', 'Setup'), className: 'bg-teal-100 text-teal-800' };
    case 'comparison':
      return { kind: 'comparison', label: t('对比', 'Compare'), className: 'bg-rose-100 text-rose-800' };
    case 'experience':
      return { kind: 'experience', label: t('经验', 'Experience'), className: 'bg-orange-100 text-orange-800' };
    case 'summary':
      return { kind: 'summary', label: t('总结', 'Summary'), className: 'bg-lime-100 text-lime-800' };
    case 'troubleshooting':
      return { kind: 'troubleshooting', label: t('排错', 'Troubleshoot'), className: 'bg-rose-100 text-rose-800' };
    case 'transition':
      return { kind: 'transition', label: t('过渡', 'Transition'), className: 'bg-muted text-muted-foreground' };
    case 'ad':
      return { kind: 'ad', label: t('广告', 'Ad'), className: 'bg-slate-100 text-slate-700' };
  }
}

function inferTimelineContentTag(text: string, t: Translate): TimelineDisplayTag | null {
  if (/广告|赞助|推广/u.test(text)) return getTimelineExplicitContentTag('ad', t);
  if (/专武|武器|装备|配装|驱动盘|圣遗物|遗器|影画|命座|星魂|配队|加点|技能(?:升级|等级|配置)|天赋/u.test(text)) {
    return getTimelineExplicitContentTag('setup', t);
  }
  if (/安装|配置|登录|环境|权限|设置/u.test(text)) return getTimelineExplicitContentTag('setup', t);
  if (/排错|调试|失败|报错|问题定位/u.test(text)) return getTimelineExplicitContentTag('troubleshooting', t);
  if (/对比|比较|区别|差异/u.test(text)) return getTimelineExplicitContentTag('comparison', t);
  if (/操作要点|操作技巧|输出循环|手法|打法|方法|步骤|框架|技巧|流程/u.test(text)) {
    return getTimelineExplicitContentTag('method', t);
  }
  if (/案例|示例|例子/u.test(text)) return getTimelineExplicitContentTag('case', t);
  if (/实战|演示|实操|操作展示|效果展示|测试过程/u.test(text)) return getTimelineExplicitContentTag('demo', t);
  if (/工具|插件|软件|模型|MCP|CLI|API/u.test(text)) return getTimelineExplicitContentTag('tool', t);
  if (/经验|心得|分享|体会/u.test(text)) return getTimelineExplicitContentTag('experience', t);
  if (/总结|回顾|结论/u.test(text)) return getTimelineExplicitContentTag('summary', t);
  if (/概念|原理|定义|机制/u.test(text)) return getTimelineExplicitContentTag('concept', t);
  if (/铺垫|过渡|引出|背景/u.test(text)) return getTimelineExplicitContentTag('transition', t);
  return null;
}
