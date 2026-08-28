import type { AnswerDraft, AnswerFieldKey, GridAnswerFieldKey, RoomTemplate } from './types';

export interface CardField {
  key: GridAnswerFieldKey;
  placeholder: string;
  maxLength: number;
  long?: boolean;
}

export const CARD_FIELDS: CardField[] = [
  { key: 'favoriteAnimal', placeholder: '猫、海獭、卡皮巴拉…', maxLength: 80 },
  { key: 'favoriteColor', placeholder: '落日橙、克莱因蓝…', maxLength: 80 },
  { key: 'favoritePerson', placeholder: '真人或虚构人物都可以', maxLength: 80 },
  { key: 'favoriteSong', placeholder: '最近循环的那一首', maxLength: 80 },
  { key: 'mbti', placeholder: '比如 ENFP（不知道也没关系）', maxLength: 16 },
  { key: 'recentProduct', placeholder: '一件让你想安利或吐槽的东西', maxLength: 120 },
  { key: 'dreamActivity', placeholder: '认真说，也可以大胆一点', maxLength: 240, long: true },
  { key: 'curiousAbout', placeholder: '一件很想知道、但还没认真聊过的事', maxLength: 240, long: true },
];

export const ALL_CARD_FIELDS: AnswerFieldKey[] = [...CARD_FIELDS.map((field) => field.key), 'message'];

export function answerText(answer: AnswerDraft, key: AnswerFieldKey) {
  return answer[key];
}

export function templateLabel(template: RoomTemplate, key: AnswerFieldKey) {
  return template.fieldLabels[key];
}
