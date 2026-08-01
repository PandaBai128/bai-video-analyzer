import type { SubtitleCue, VideoMetadata, VideoPlatformChapter } from '@core/types';

export function formatSubtitleTimeRange(cue: SubtitleCue): string {
  const start = formatSeconds(cue.start);
  if (typeof cue.end === 'number' && cue.end > cue.start) {
    return `${start}-${formatSeconds(cue.end)}`;
  }
  return start;
}

export function createChapterDensityGuidance(duration: number | undefined): string {
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
    return '按字幕真实主题切分 chapter；不要为了固定数量而合并无关主题，也不要按固定时长均分章节';
  }
  if (duration < 10 * 60) {
    return '短视频（< 10 分钟）章节少而密，宁可章节少也不要凑 5 章；按真实主题变化切分';
  }
  if (duration >= 60 * 60) {
    return '长视频（>= 60 分钟）建议 8-14 个 chapter；教程类通常每 5-10 分钟出现一次主题变化，但 chapter 起止必须跟随字幕里的真实主题边界，不能按固定时长均分';
  }
  if (duration >= 30 * 60) {
    return '中长视频（30-60 分钟）建议 6-10 个 chapter；按真实主题变化切分，不要压成 3-6 个粗章节，也不要按 5 分钟机械均分';
  }
  return '常规视频建议 3-6 个 chapter；按真实主题变化切分，不要按固定时长均分';
}

export function createSubtitleCoverageGuidance(subtitles: readonly SubtitleCue[] | undefined): string {
  if (!subtitles?.length) {
    return '没有可用字幕编号时，不要编造 cue id；应明确说明无法稳定生成完整时间线。';
  }
  const lastCueId = subtitles.length - 1;
  const nearTailCueId = Math.max(0, lastCueId - 2);
  return [
    `字幕编号范围：#0-#${lastCueId}。`,
    `必须输出 chapter 事件，不能只输出 overview；中长视频不要只覆盖视频前半段。`,
    `第一个 chapter 的 startCueId 必须从 #0 或非常接近开头开始。`,
    `最后一个 chapter 的 endCueId 必须覆盖到最后字幕附近（至少 >= #${nearTailCueId}，通常直接使用 #${lastCueId}）。`,
    `如果最后几条字幕只是结尾寒暄，也要用最后一个 chapter 覆盖过去，并把 title/summary 老实写成总结或收尾。`,
  ].map((line) => `- ${line}`).join('\n');
}

export function createPlatformChapterAnchorBlock(metadata: VideoMetadata): string {
  const chapters = normalizePlatformChapterAnchors(metadata.platformChapters, metadata.duration);
  if (chapters.length === 0) {
    return '';
  }
  const lines = chapters.map((chapter, index) => {
    const end = typeof chapter.end === 'number' ? `-${formatSeconds(chapter.end)}` : '';
    return `#${index + 1} [${formatSeconds(chapter.start)}${end}] ${chapter.title}`;
  });
  return `<platform_chapters>
这些是播放器/平台给出的章节锚点，优先级高于模型自行分段：
${lines.join('\n')}
</platform_chapters>`;
}

export function createPlatformChapterAnchorGuidance(metadata: VideoMetadata): string {
  const chapters = normalizePlatformChapterAnchors(metadata.platformChapters, metadata.duration);
  if (chapters.length === 0) {
    return '';
  }
  return [
    '- <platform_chapters> 是播放器/平台给出的真实章节锚点；生成 chapter 时必须优先贴近这些边界。',
    '- 不要把一个平台章节里的内容合并到下一个平台章节；如果字幕主题判断和平台章节相差十几秒以内，按平台章节边界处理。',
    '- 平台章节只约束 chapter 边界；segment 仍必须按字幕里的真实子话题起点切，不要把平台章节内部粗略二分。',
    '- 每个 <platform_chapters> 条目都应该在输出里有对应 chapter；title 可略微润色，但不能把 Skills / MCP / 自动化任务这类平台章节延后数分钟。',
  ].join('\n');
}

export function createCueBoundaryGuidance(): string {
  return [
    '- segment 标题只能覆盖一个连续子话题；如果标题里出现两个相隔较远的动作/地点/话题（例如“打气球与饭后街景”），必须拆成两个 segment，不能合并。',
    '- segment 的 startCueId 必须指向标题中第一个具体动作/地点/话题第一次真正出现的字幕行；不要从后半段或总结句开始。',
    '- 如果一个动作在 #A 已经出现，另一个动作在 #B 才出现，不能用 #B 作为包含前一个动作的 segment 起点；要么从 #A 开始，要么拆段。',
  ].join('\n');
}

export function createTimelineClassificationGuidance(): string {
  return [
    '- contentTag 是内容类型，不是观看优先级；按该 cue range 的主要内容选择，无法判断时可以省略：',
    '  - concept：概念、原理、机制或定义。',
    '  - method：方法、步骤、框架、操作要点、输出循环、打法或技巧。',
    '  - demo：实际操作演示、实战过程、效果展示或测试过程。',
    '  - case：用于说明观点的案例、示例或具体例子。',
    '  - tool：外部工具、软件、插件、网站、模型或设备的介绍；游戏内武器、装备、配装、影画/命座和配队不属于 tool。',
    '  - setup：安装和参数配置，也包括游戏攻略里的装备、专武、配装、驱动盘、影画/命座、配队、加点和技能配置。',
    '  - comparison：两个或多个方案、角色、产品或结果的对比。',
    '  - experience：作者基于亲历给出的经验、心得或体会；有明确步骤和操作要点时优先用 method。',
    '  - summary：总结、回顾或结论。',
    '  - troubleshooting：报错、失败原因、问题定位或解决过程。',
    '  - transition：只有转场、铺垫或引出下文，且本段没有可独立使用的实质内容。',
    '  - ad：广告、赞助或推广。',
    '- 不要只根据标题中的单个词选 contentTag，要看该 cue range 的主要内容。',
    '- 攻略类示例：“专武与影画提升”应为 setup；“后台输出循环与操作要点”应为 method；“实战演示与结尾”如果主体是实战，应为 demo，不应因为结尾或转场词标成 transition。',
    '- 不要用 contentTag 表达“重点 / 选看 / 可跳”；这类判断只能放 importance。',
  ].join('\n');
}

function normalizePlatformChapterAnchors(
  chapters: readonly VideoPlatformChapter[] | undefined,
  duration: number | undefined,
): readonly VideoPlatformChapter[] {
  if (!chapters?.length) {
    return [];
  }
  return chapters
    .filter((chapter) => chapter.title.trim() && Number.isFinite(chapter.start))
    .map((chapter) => ({
      title: chapter.title.trim(),
      start: Math.max(0, chapter.start),
      ...(typeof chapter.end === 'number' && Number.isFinite(chapter.end) && chapter.end > chapter.start
        ? { end: chapter.end }
        : {}),
    }))
    .filter((chapter) => {
      if (typeof duration !== 'number' || duration <= 0) {
        return true;
      }
      return chapter.start <= duration;
    })
    .sort((left, right) => left.start - right.start);
}

function formatSeconds(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);

  return `${minutes}:${String(rest).padStart(2, '0')}`;
}
