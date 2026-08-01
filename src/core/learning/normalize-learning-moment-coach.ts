import type { LearningGuide, LearningMoment, LearningMomentCoach } from '@core/types';

export function normalizeLearningMomentCoach(input: {
  readonly coach: LearningMomentCoach;
  readonly moment: LearningMoment;
  readonly guide: LearningGuide | undefined;
}): LearningMomentCoach {
  if (input.coach.handling !== 'keep') return input.coach;
  if (input.moment.kind === 'question') {
    return { ...input.coach, handling: inferQuestionHandling(input.moment.content) };
  }
  if (input.moment.kind === 'action') {
    return { ...input.coach, handling: 'apply' };
  }
  if (looksLikeVerification(input.moment.content)) {
    return { ...input.coach, handling: 'verify' };
  }
  if (isLightContent(input.guide) && input.moment.kind === 'note') {
    return { ...input.coach, handling: 'release' };
  }
  return input.coach;
}

function inferQuestionHandling(content: string): LearningMomentCoach['handling'] {
  return looksLikeVerification(content) ? 'verify' : 'ask';
}

function looksLikeVerification(content: string): boolean {
  return /证据|依据|真假|靠谱不|靠谱吗|是否成立|能不能|能否|是不是真的|事实|宣传|边界/.test(
    content,
  );
}

function isLightContent(guide: LearningGuide | undefined): boolean {
  if (!guide) return false;
  return /娱乐|整活|reaction|vlog|吐槽|生活|游戏实况|灵感|审美/.test(
    `${guide.contentType} ${guide.suggestedStance}`,
  );
}
