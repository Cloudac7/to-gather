import type { AnswerDraft, AnswerFieldKey } from '../lib/types';
import { ANSWER_FIELD_KEYS } from '../lib/types';

export interface ForkMediaContext {
  sourceRoomId: string;
  sourceParticipantId: string;
  targetRoomId: string;
  targetParticipantId: string;
}

type CopyMedia = (sourceKey: string, targetKey: string) => Promise<void>;

function avatarExtension(key: string) {
  const extension = key.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  return extension && ['jpg', 'jpeg', 'png', 'webp'].includes(extension) ? extension : 'webp';
}

function assertOwnedMedia(key: string, context: ForkMediaContext) {
  const prefix = `${context.sourceRoomId}/${context.sourceParticipantId}/`;
  if (!key.startsWith(prefix)) throw new Error('源房间图片归属无效');
}

export async function forkAnswerMedia(
  source: AnswerDraft,
  context: ForkMediaContext,
  copyMedia: CopyMedia,
): Promise<AnswerDraft> {
  const answer: AnswerDraft = {
    ...source,
    avatarKey: null,
    imageKeys: { ...source.imageKeys },
  };

  if (source.avatarKey) {
    assertOwnedMedia(source.avatarKey, context);
    const targetKey = `${context.targetRoomId}/${context.targetParticipantId}/${crypto.randomUUID()}.${avatarExtension(source.avatarKey)}`;
    await copyMedia(source.avatarKey, targetKey);
    answer.avatarKey = targetKey;
  }

  for (const field of ANSWER_FIELD_KEYS as readonly AnswerFieldKey[]) {
    const sourceKey = source.imageKeys[field];
    if (!sourceKey) {
      answer.imageKeys[field] = null;
      continue;
    }
    assertOwnedMedia(sourceKey, context);
    const targetKey = `${context.targetRoomId}/${context.targetParticipantId}/answers/${field}/${crypto.randomUUID()}.webp`;
    await copyMedia(sourceKey, targetKey);
    answer.imageKeys[field] = targetKey;
  }

  return answer;
}
