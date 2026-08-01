import type { LearningGuideValueCriterion, LearningGuideValueProfileKind } from '@core/types';
import { DEFAULT_UI_LOCALE, type UiLocale } from '@shared/locale-settings';

export interface ValueProfileCriterionDefinition {
  readonly label: string;
  readonly standard: string;
  readonly aliases?: readonly string[];
}

export const VALUE_PROFILE_CRITERIA_BY_KIND: Record<
  LearningGuideValueProfileKind,
  readonly ValueProfileCriterionDefinition[]
> = {
  learning_tutorial: [
    {
      label: '结构清晰',
      standard: '内容是否有清楚的目标、顺序和层次，用户能否快速跟上。',
    },
    {
      label: '可迁移方法',
      standard: '是否提供能迁移到其他任务或场景的方法，而不是只讲个例。',
      aliases: ['可迁移性', '方法迁移'],
    },
    {
      label: '步骤完整',
      standard: '关键步骤、前置条件和结论是否交代完整，是否方便照着做。',
    },
    {
      label: '时效可控',
      standard: '内容是否不依赖易过时的版本、政策、工具界面或短期信息；高分表示时效风险可控。',
      aliases: ['过时风险'],
    },
    {
      label: '实践成本',
      standard: '用户看完后实际尝试所需时间、资源和门槛是否合理。',
    },
  ],
  interview_qa: [
    {
      label: '人物/事件稀缺性',
      standard: '受访者、事件节点或回答场景是否稀缺，是否值得专门听。',
      aliases: ['人物与品牌稀缺性', '人物或事件稀缺性', '稀缺性', '内容稀缺度'],
    },
    {
      label: '回答信息量',
      standard: '回答是否提供具体信息，而不是泛泛表态、玩梗或重复寒暄。',
    },
    {
      label: '真实细节',
      standard: '是否有亲历细节、幕后过程、具体数字或可验证上下文。',
    },
    {
      label: '观点启发',
      standard: '回答是否带来新看法、判断框架或对人物/事件的理解增量。',
      aliases: ['观点与启发价值'],
    },
    {
      label: '闲聊控制',
      standard:
        '闲聊、粉丝互动和情绪性内容是否被控制在合理范围；高分表示闲聊不明显影响单位时间回报。',
      aliases: ['闲聊占比'],
    },
  ],
  opinion_commentary: [
    {
      label: '论点清晰度',
      standard: '作者核心立场和判断链路是否清楚，是否容易把握主张。',
      aliases: ['论点清晰'],
    },
    {
      label: '例子支撑',
      standard: '观点是否有案例、片段、对比或上下文支撑，而不是只下结论。',
      aliases: ['论据支撑', '例子与论据支撑'],
    },
    {
      label: '视角新鲜度',
      standard: '是否提供不同于常见评论的角度、专业背景或独到观察。',
      aliases: ['视角新鲜'],
    },
    {
      label: '证据边界清晰',
      standard: '主观偏好、证据不足或立场倾向是否被清楚交代；高分表示边界清晰、误导风险可控。',
      aliases: ['偏见/证据缺口', '偏见与证据缺口'],
    },
    {
      label: '表达效率',
      standard: '观点表达是否紧凑，铺垫、重复和情绪输出是否过多。',
    },
  ],
  product_review: [
    {
      label: '实测证据',
      standard: '是否有真实测试、样张、数据、场景体验或问题复现。',
    },
    {
      label: '对比充分性',
      standard: '是否和同价位、同用途或关键竞品做了足够对比。',
    },
    {
      label: '购买决策帮助',
      standard: '是否能帮助用户判断适不适合买、适合谁买、什么时候不买。',
    },
    {
      label: '利益相关可控',
      standard: '广告、带货、品牌合作或样本选择等利益相关因素是否披露充分；高分表示偏差风险可控。',
      aliases: ['利益相关风险'],
    },
  ],
  news_context: [
    {
      label: '背景完整度',
      standard: '事件来龙去脉、关键参与方和必要背景是否交代清楚。',
    },
    {
      label: '信息时效性',
      standard: '信息是否跟得上当前事件状态；高分表示没有明显过时风险。',
    },
    {
      label: '来源可靠性',
      standard: '是否说明来源、数据或一手材料，是否区分事实和推测。',
    },
    {
      label: '影响解释',
      standard: '是否解释事件影响、后续可能性和与用户相关的判断点。',
    },
    {
      label: '立场边界',
      standard: '是否交代不确定性和立场限制，避免把单一判断当事实。',
    },
  ],
  entertainment_reaction: [
    {
      label: '情绪价值',
      standard: '是否能提供放松、好笑、惊喜、共鸣或陪伴感。',
    },
    {
      label: '节目效果',
      standard: '节奏、包袱、反差、剪辑和互动是否支撑观看体验。',
    },
    {
      label: '人物魅力',
      standard: '人物表达、关系互动或品牌气质是否是主要吸引力。',
    },
    {
      label: '剪辑节奏',
      standard: '是否紧凑顺畅，是否存在拖沓、空转或重复片段。',
    },
    {
      label: '放松观看适配',
      standard: '是否适合轻松观看，是否不需要严肃学习或做笔记。',
      aliases: ['是否适合放松观看', '放松观看'],
    },
  ],
  gameplay_walkthrough: [
    {
      label: '路线完整度',
      standard: '流程、关卡、任务或剧情推进是否清楚完整。',
    },
    {
      label: '实操可跟随',
      standard: '操作、配装、路线或关键选择是否方便玩家跟做。',
    },
    {
      label: '关键节点覆盖',
      standard: '是否覆盖难点、坑点、奖励、机制或剧情关键节点。',
    },
    {
      label: '体验/剧情价值',
      standard: '是否提供有趣体验、剧情理解或玩家视角价值。',
    },
    {
      label: '重复成本控制',
      standard: '刷怪、跑图、失败尝试或低价值重复是否被控制在合理范围；高分表示重复成本低。',
      aliases: ['重复成本'],
    },
  ],
  mixed: [
    {
      label: '类型识别清晰',
      standard: '视频混合多个目的时，主线和观看目的是否仍然清楚。',
    },
    {
      label: '重点集中度',
      standard: '高价值内容是否集中，用户是否容易挑出该看的部分。',
    },
    {
      label: '信息/娱乐平衡',
      standard: '信息、观点、情绪和节目效果之间是否平衡。',
    },
    {
      label: '证据支撑',
      standard: '关键判断是否有字幕、案例、实测或上下文支撑。',
    },
    {
      label: '时间取舍',
      standard: '按视频长度和内容密度看，是否值得投入完整观看时间。',
    },
  ],
};

const VALUE_PROFILE_CRITERIA_EN_BY_KIND: Record<
  LearningGuideValueProfileKind,
  readonly ValueProfileCriterionDefinition[]
> = {
  learning_tutorial: [
    {
      label: 'Structure clarity',
      standard: 'Whether the content has a clear goal, order, and hierarchy so the viewer can follow quickly.',
    },
    {
      label: 'Transferable methods',
      standard: 'Whether it provides methods that can transfer to other tasks or scenes instead of only a single case.',
      aliases: ['Transferability', 'Method transfer'],
    },
    {
      label: 'Complete steps',
      standard: 'Whether key steps, prerequisites, and conclusions are complete enough to follow.',
    },
    {
      label: 'Time relevance',
      standard: 'Whether the content is not overly dependent on fragile versions, policies, tool UIs, or short-lived news; higher means lower freshness risk.',
      aliases: ['Outdated risk'],
    },
    {
      label: 'Practice cost',
      standard: 'Whether the time, resources, and threshold needed to try it after watching are reasonable.',
    },
  ],
  interview_qa: [
    {
      label: 'Person/event rarity',
      standard: 'Whether the speaker, event moment, or answer context is scarce enough to be worth listening to.',
      aliases: ['Rarity', 'Content rarity'],
    },
    {
      label: 'Answer density',
      standard: 'Whether the answers provide concrete information instead of vague statements, jokes, or repeated small talk.',
    },
    {
      label: 'Concrete details',
      standard: 'Whether there are firsthand details, behind-the-scenes context, specific numbers, or verifiable information.',
    },
    {
      label: 'Insight value',
      standard: 'Whether the answers provide new views, judgment frames, or added understanding of the person or event.',
    },
    {
      label: 'Small-talk control',
      standard: 'Whether small talk, fan interaction, and emotional filler stay within a reasonable range; higher means they do not hurt time value much.',
    },
  ],
  opinion_commentary: [
    {
      label: 'Argument clarity',
      standard: 'Whether the author\'s core stance and reasoning path are clear and easy to grasp.',
    },
    {
      label: 'Example support',
      standard: 'Whether the opinions are backed by cases, clips, comparisons, or context instead of only conclusions.',
    },
    {
      label: 'Fresh perspective',
      standard: 'Whether it offers an angle, background, or observation beyond common commentary.',
    },
    {
      label: 'Evidence boundaries',
      standard: 'Whether subjective preference, missing evidence, or stance bias is clearly bounded; higher means lower risk of misleading.',
    },
    {
      label: 'Expression efficiency',
      standard: 'Whether the argument is compact, with limited setup, repetition, or emotional padding.',
    },
  ],
  product_review: [
    {
      label: 'Test evidence',
      standard: 'Whether there are real tests, samples, data, scenario experience, or reproduced issues.',
    },
    {
      label: 'Comparison depth',
      standard: 'Whether it compares enough with similar-price, same-use, or key competing options.',
    },
    {
      label: 'Purchase decision help',
      standard: 'Whether it helps the viewer decide whether to buy, who it fits, and when not to buy.',
    },
    {
      label: 'Conflict-of-interest control',
      standard: 'Whether ads, affiliate incentives, brand cooperation, or sample selection are disclosed enough; higher means bias risk is controlled.',
      aliases: ['Conflict of interest control', 'Conflict risk control'],
    },
  ],
  news_context: [
    {
      label: 'Background completeness',
      standard: 'Whether the event context, key actors, and necessary background are explained clearly.',
    },
    {
      label: 'Timeliness',
      standard: 'Whether the information keeps up with the current event state; higher means no obvious outdated risk.',
    },
    {
      label: 'Source reliability',
      standard: 'Whether sources, data, or primary material are explained and facts are separated from speculation.',
    },
    {
      label: 'Impact explanation',
      standard: 'Whether it explains the event impact, possible next steps, and user-relevant judgment points.',
    },
    {
      label: 'Position boundaries',
      standard: 'Whether uncertainty and stance limits are stated instead of presenting one judgment as fact.',
    },
  ],
  entertainment_reaction: [
    {
      label: 'Emotional value',
      standard: 'Whether it provides relaxation, humor, surprise, resonance, or companionship.',
    },
    {
      label: 'Show effect',
      standard: 'Whether pacing, jokes, contrast, editing, and interaction support the watching experience.',
    },
    {
      label: 'Persona appeal',
      standard: 'Whether the speaker, relationship dynamic, or brand temperament is the main attraction.',
    },
    {
      label: 'Editing rhythm',
      standard: 'Whether the editing is compact and smooth without much dragging, empty time, or repetition.',
    },
    {
      label: 'Relaxed viewing fit',
      standard: 'Whether it fits casual viewing and does not require serious study or note-taking.',
      aliases: ['Relaxed viewing'],
    },
  ],
  gameplay_walkthrough: [
    {
      label: 'Route completeness',
      standard: 'Whether the process, level, quest, or story progression is clear and complete.',
    },
    {
      label: 'Follow-along practicality',
      standard: 'Whether operations, builds, routes, or key choices are easy for players to follow.',
    },
    {
      label: 'Key node coverage',
      standard: 'Whether it covers hard points, traps, rewards, mechanics, or key story nodes.',
    },
    {
      label: 'Experience/story value',
      standard: 'Whether it provides interesting experience, story understanding, or player-perspective value.',
    },
    {
      label: 'Repetition cost control',
      standard: 'Whether grinding, running around, failed attempts, or low-value repetition are controlled; higher means lower repetition cost.',
      aliases: ['Repetition cost'],
    },
  ],
  mixed: [
    {
      label: 'Type clarity',
      standard: 'Whether the main thread and watching purpose are still clear when the video mixes several intents.',
    },
    {
      label: 'Focus',
      standard: 'Whether high-value content is concentrated and easy to pick out.',
    },
    {
      label: 'Information/entertainment balance',
      standard: 'Whether information, opinions, emotion, and show effect are balanced.',
    },
    {
      label: 'Evidence support',
      standard: 'Whether key judgments have subtitle evidence, cases, tests, or context.',
    },
    {
      label: 'Time tradeoff',
      standard: 'Whether the video length and density make the viewing time worthwhile.',
    },
  ],
};

export function getValueProfileCriteriaDefinitions(
  kind: LearningGuideValueProfileKind,
  locale: UiLocale = DEFAULT_UI_LOCALE,
): readonly ValueProfileCriterionDefinition[] {
  const source =
    locale === 'en-US' ? VALUE_PROFILE_CRITERIA_EN_BY_KIND : VALUE_PROFILE_CRITERIA_BY_KIND;
  return source[kind] ?? source.mixed;
}

export function normalizeValueProfileCriteria(input: {
  readonly kind: LearningGuideValueProfileKind;
  readonly criteria: readonly {
    readonly label?: string | undefined;
    readonly score?: number | undefined;
  }[];
  readonly fallbackScore: number;
  readonly outputLocale?: UiLocale;
}): readonly LearningGuideValueCriterion[] {
  const outputLocale = input.outputLocale ?? DEFAULT_UI_LOCALE;
  const definitions = getValueProfileCriteriaDefinitions(input.kind, outputLocale);
  const zhDefinitions = getValueProfileCriteriaDefinitions(input.kind, 'zh-CN');
  const enDefinitions = getValueProfileCriteriaDefinitions(input.kind, 'en-US');
  const scoresByLabel = new Map<string, number | undefined>();
  for (const criterion of input.criteria) {
    const label = criterion.label?.trim();
    if (!label) continue;
    scoresByLabel.set(normalizeCriterionLabel(label), criterion.score);
  }

  return definitions.map((definition, index) => {
    const scoreFromKnownLabel = [
      ...getCriterionLabelKeys(definition),
      ...getCriterionLabelKeys(zhDefinitions[index]),
      ...getCriterionLabelKeys(enDefinitions[index]),
    ]
      .map((label) => scoresByLabel.get(label))
      .find((score) => score !== undefined);
    const positionalCriterion = input.criteria[index];
    const scoreFromBlankLabelPosition =
      scoreFromKnownLabel === undefined && isBlankCriterionLabel(positionalCriterion?.label)
        ? positionalCriterion?.score
        : undefined;

    return {
      label: definition.label,
      score: clampCriteriaScore(
        scoreFromKnownLabel ?? scoreFromBlankLabelPosition,
        input.fallbackScore,
      ),
      reason: definition.standard,
    };
  });
}

function getCriterionLabelKeys(
  definition: ValueProfileCriterionDefinition | undefined,
): readonly string[] {
  if (!definition) return [];
  return [definition.label, ...(definition.aliases ?? [])].map(normalizeCriterionLabel);
}

function normalizeCriterionLabel(label: string): string {
  return label.replace(/\s+/g, '');
}

function isBlankCriterionLabel(label: string | undefined): boolean {
  return !label?.trim();
}

function clampCriteriaScore(rawScore: number | undefined, fallbackScore: number): number {
  if (typeof rawScore === 'number' && Number.isFinite(rawScore)) {
    return Math.round(Math.max(0, Math.min(100, rawScore)));
  }
  return fallbackScore;
}
