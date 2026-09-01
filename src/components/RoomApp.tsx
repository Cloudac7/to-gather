import QRCode from 'qrcode';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type {
  AnswerDraft,
  AnswerFieldKey,
  AuthenticatedRoomState,
  CreateRoomResponse,
  CreateShareResponse,
  JoinRoomResponse,
  RevealedAnswer,
  RoomTemplate,
  RoomState,
  ServerEvent,
  ShareSummary,
} from '../lib/types';
import { createEmptyDraft, EMPTY_ANSWER_IMAGES } from '../lib/types';
import { CARD_FIELDS } from '../lib/card';
import { generatePoster, type PosterInput, type PosterPerson } from '../lib/poster';

interface Props {
  roomId: string;
}

interface ApiError {
  message?: string;
}

const fields = CARD_FIELDS;

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = (await response.json().catch(() => ({}))) as T & ApiError;
  if (!response.ok) throw new Error(payload.message ?? '操作失败，请稍后再试');
  return payload;
}

export default function RoomApp({ roomId }: Props) {
  const [state, setState] = useState<RoomState | null>(null);
  const [error, setError] = useState('');
  const [online, setOnline] = useState<Set<string>>(new Set());
  const [shareInfo, setShareInfo] = useState<CreateRoomResponse | null>(null);
  const [recoveryCode, setRecoveryCode] = useState('');

  async function refresh() {
    try {
      const next = await api<RoomState>(`/api/rooms/${roomId}`);
      setState(next);
      setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '房间加载失败');
    }
  }

  useEffect(() => {
    const stored = sessionStorage.getItem(`duet_invite_${roomId}`);
    if (stored) {
      try {
        setShareInfo(JSON.parse(stored));
      } catch {
        sessionStorage.removeItem(`duet_invite_${roomId}`);
      }
    }
    void refresh();
  }, [roomId]);

  useEffect(() => {
    if (state?.access !== 'participant') return;
    let socket: WebSocket | null = null;
    let retry: number | undefined;
    let stopped = false;
    const connect = () => {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${protocol}//${location.host}/api/rooms/${roomId}/ws`);
      socket.onmessage = (message) => {
        if (message.data === 'pong') return;
        const event = JSON.parse(message.data) as ServerEvent;
        if (event.type === 'presence') {
          setOnline((previous) => {
            const next = new Set(previous);
            event.online ? next.add(event.participantId) : next.delete(event.participantId);
            return next;
          });
          return;
        }
        if (event.type !== 'draft_saved') void refresh();
      };
      socket.onclose = () => {
        setOnline(new Set());
        if (!stopped) retry = window.setTimeout(connect, 1500);
      };
    };
    connect();
    const heartbeat = window.setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN) socket.send('ping');
    }, 25_000);
    const fallback = window.setInterval(() => void refresh(), 20_000);
    return () => {
      stopped = true;
      window.clearInterval(heartbeat);
      window.clearInterval(fallback);
      if (retry) window.clearTimeout(retry);
      socket?.close(1000, '页面离开');
    };
  }, [state?.access, roomId]);

  if (!state) {
    return <LoadingScreen message={error || '正在找到这张卡片…'} />;
  }
  if (state.access === 'not_found' || state.access === 'expired') {
    return <GoneScreen expired={state.access === 'expired'} />;
  }
  if (state.access === 'joinable' || state.access === 'full') {
    return (
      <JoinScreen
        roomId={roomId}
        full={state.access === 'full'}
        onJoined={(code) => {
          setRecoveryCode(code);
          void refresh();
        }}
      />
    );
  }
  if (state.access !== 'participant') {
    return <GoneScreen expired={false} />;
  }

  return (
    <ParticipantRoom
      state={state}
      online={online}
      shareInfo={shareInfo}
      recoveryCode={recoveryCode}
      onDismissSecrets={() => {
        sessionStorage.removeItem(`duet_invite_${roomId}`);
        setShareInfo(null);
        setRecoveryCode('');
      }}
      onRefresh={refresh}
    />
  );
}

function LoadingScreen({ message }: { message: string }) {
  return (
    <main class="center-page">
      <div class="loading-mark" aria-hidden="true"><span>1</span><span>2</span></div>
      <p class="loading-copy">{message}</p>
    </main>
  );
}

function GoneScreen({ expired }: { expired: boolean }) {
  return (
    <main class="center-page">
      <section class="empty-state paper-panel">
        <span class="eyebrow">ROOM UNAVAILABLE</span>
        <h1>{expired ? '这张卡片已经消失' : '没有找到这张卡片'}</h1>
        <p>{expired ? '为了保护隐私，房间在 30 天没有活动后会自动删除。' : '请检查链接是否完整。'}</p>
        <a class="button button-dark" href="/">创建一张新的</a>
      </section>
    </main>
  );
}

export function JoinScreen({ roomId, full, onJoined }: { roomId: string; full: boolean; onJoined: (code: string) => void }) {
  const [mode, setMode] = useState<'join' | 'recover'>(full ? 'recover' : 'join');
  const [nickname, setNickname] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [slot, setSlot] = useState<1 | 2>(full ? 1 : 2);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: Event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (mode === 'join') {
        const result = await api<JoinRoomResponse>(`/api/rooms/${roomId}/join`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nickname, joinCode }),
        });
        onJoined(result.recoveryCode);
      } else {
        await api(`/api/rooms/${roomId}/recover`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nickname, slot, recoveryCode: recoveryCode.toUpperCase() }),
        });
        onJoined('');
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '操作失败');
      setBusy(false);
    }
  }

  return (
    <main class="join-page">
      <a class="brand floating-brand" href="/"><span class="brand-mark">两</span><span>TO-GATHER</span></a>
      <section class="join-visual" aria-hidden="true">
        <div class="portrait-box">1</div>
        <div class="join-line"><span>?</span></div>
        <div class="portrait-box muted">2</div>
      </section>
      <section class="join-panel paper-panel">
        <span class="eyebrow">INVITATION / {roomId.slice(0, 4).toUpperCase()}</span>
        <h1>{full ? '这个房间已经坐满' : '有人在等你入座'}</h1>
        <p>{full ? '原参与者可以用恢复码回来。' : '你将作为二号加入。一号可以邀请多人，但不同二号之间互相不可见。'}</p>

        {!full && (
          <div class="segmented">
            <button class={mode === 'join' ? 'active' : ''} onClick={() => setMode('join')}>加入房间</button>
            <button class={mode === 'recover' ? 'active' : ''} onClick={() => setMode('recover')}>恢复身份</button>
          </div>
        )}

        <form onSubmit={submit}>
          <label for="join-name">你的昵称</label>
          <input id="join-name" value={nickname} onInput={(e) => setNickname(e.currentTarget.value)} maxLength={24} autocomplete="nickname" />
          {mode === 'join' ? (
            <>
              <label for="join-code">六位加入码</label>
              <input key="join-code" id="join-code" class="code-input" inputMode="numeric" pattern="[0-9]*" value={joinCode} onInput={(e) => setJoinCode(e.currentTarget.value.replace(/\D/g, '').slice(0, 6))} placeholder="000000" />
            </>
          ) : (
            <>
              <label>你原来的位置</label>
              <div class="slot-choice">
                <button type="button" class={slot === 1 ? 'active' : ''} onClick={() => setSlot(1)}>1 号</button>
                <button type="button" class={slot === 2 ? 'active' : ''} onClick={() => setSlot(2)}>2 号</button>
              </div>
              <label for="recovery-code">十二位恢复码</label>
              <input key="recovery-code" id="recovery-code" class="code-input recovery-input" value={recoveryCode} onInput={(e) => setRecoveryCode(e.currentTarget.value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 12))} placeholder="ABCD2EFG3HJK" />
            </>
          )}
          {error && <p class="form-error" role="alert">{error}</p>}
          <button class="button button-accent" type="submit" disabled={busy || !nickname.trim() || (mode === 'join' ? joinCode.length !== 6 : recoveryCode.length !== 12)}>
            {busy ? '正在确认…' : mode === 'join' ? '占据 2 号位置' : '恢复我的位置'}
          </button>
        </form>
      </section>
    </main>
  );
}

function ParticipantRoom({ state, online, shareInfo, recoveryCode, onDismissSecrets, onRefresh }: {
  state: AuthenticatedRoomState;
  online: Set<string>;
  shareInfo: CreateRoomResponse | null;
  recoveryCode: string;
  onDismissSecrets: () => void;
  onRefresh: () => Promise<void>;
}) {
  const me = state.participants.find((person) => person.isMe)!;
  const host = state.participants.find((person) => person.slot === 1);
  const guests = state.participants.filter((person) => person.slot === 2);
  const inviteUrl = shareInfo?.inviteUrl ?? new URL(`/room/${state.roomId}`, location.origin).href;
  const onlineGuests = guests.filter((person) => online.has(person.id)).length;
  const statusText = me.slot === 1
    ? guests.length
      ? `${guests.length} 位二号已加入${onlineGuests ? ` · ${onlineGuests} 人在线` : ''}`
      : '等待二号加入'
    : host
      ? online.has(host.id) ? `${host.nickname} 在线` : `${host.nickname} 创建的房间`
      : '已作为二号加入';

  return (
    <main class="room-page">
      <header class="room-header">
        <a class="brand" href="/"><span class="brand-mark">两</span><span>TO-GATHER</span></a>
        <div class="room-meta">
          <span>ROUND {String(state.roundNumber).padStart(2, '0')}</span>
          <span class="status-dot"><i class={onlineGuests > 0 || Boolean(host && online.has(host.id)) ? 'online' : ''}></i>{statusText}</span>
        </div>
      </header>

      {(shareInfo || recoveryCode) && (
        <SecretPanel
          info={shareInfo}
          recoveryCode={recoveryCode || shareInfo?.recoveryCode || ''}
          onDismiss={onDismissSecrets}
        />
      )}

      {me.slot === 1 && guests.length === 0 && <WaitingPanel roomId={state.roomId} shareInfo={shareInfo} />}

      <FillView
        state={state}
        onRefresh={onRefresh}
        inviteUrl={inviteUrl}
      />

      {state.publishedAnswers.length > 0 && <PublishedView state={state} onRefresh={onRefresh} />}

      {state.history.length > 0 && <HistoryList roomId={state.roomId} history={state.history} template={state.template} />}
    </main>
  );
}

function SecretPanel({ info, recoveryCode, onDismiss }: { info: CreateRoomResponse | null; recoveryCode: string; onDismiss: () => void }) {
  return (
    <section class="secret-banner">
      <div>
        <span class="eyebrow">SAVE THIS ONCE</span>
        <strong>请现在保存你的恢复码</strong>
        <code>{recoveryCode}</code>
        <p>换设备或清理浏览器后，需要昵称、位置和这串码才能回来。关闭后不再完整显示。</p>
      </div>
      {info && <CopyButton value={`邀请链接：${info.inviteUrl}\n加入码：${info.joinCode}`}>复制邀请信息</CopyButton>}
      <button class="text-button" onClick={onDismiss}>我已安全保存 ×</button>
    </section>
  );
}

function WaitingPanel({ roomId, shareInfo }: { roomId: string; shareInfo: CreateRoomResponse | null }) {
  const inviteUrl = shareInfo?.inviteUrl ?? location.href;
  return (
    <section class="waiting-layout">
      <div class="waiting-copy">
        <span class="eyebrow">SEAT 01 / START NOW</span>
        <h1>不用等对方，<br />你可以先填。</h1>
        <p>把同一个链接或二维码发给多个人，再单独告诉他们六位加入码。每个二号都会和你形成一份独立结果。</p>
        {shareInfo ? (
          <div class="invite-code"><small>JOIN CODE</small><strong>{shareInfo.joinCode}</strong></div>
        ) : (
          <p class="hint-box">为了安全，加入码只在创建时展示。如果没有保存，请新建房间。</p>
        )}
        <div class="waiting-actions">
          <CopyButton value={inviteUrl}>复制邀请链接</CopyButton>
          <a class="button button-accent" href="#your-card">开始填写 ↓</a>
        </div>
      </div>
      <QrCard value={inviteUrl} roomId={roomId} />
    </section>
  );
}

function QrCard({ value, roomId }: { value: string; roomId: string }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    void QRCode.toDataURL(value, { width: 520, margin: 2, color: { dark: '#111111', light: '#fffef9' }, errorCorrectionLevel: 'M' }).then(setSrc);
  }, [value]);
  return (
    <div class="qr-card paper-panel">
      {src ? <img src={src} alt="房间邀请二维码" /> : <div class="qr-placeholder" />}
      <span>SCAN TO JOIN</span>
      <small>{roomId.toUpperCase()}</small>
      {src && <a class="text-button" href={src} download={`to-gather-${roomId}.png`}>下载二维码</a>}
    </div>
  );
}

export function RoomTemplateHeading({ template }: { template: RoomTemplate }) {
  return (
    <header class="fill-template-heading">
      <span class="eyebrow">ROOM CARD / FIXED TITLE</span>
      <h1>{template.title}</h1>
      {template.subtitle && <p>{template.subtitle}</p>}
    </header>
  );
}

function FillView({ state, onRefresh, inviteUrl }: {
  state: AuthenticatedRoomState;
  onRefresh: () => Promise<void>;
  inviteUrl: string;
}) {
  const me = state.participants.find((person) => person.isMe)!;
  const [draft, setDraft] = useState<AnswerDraft>(state.ownDraft ?? createEmptyDraft());
  const [version, setVersion] = useState(state.version);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadingField, setUploadingField] = useState<AnswerFieldKey | null>(null);
  const submitted = me.submitted;
  const timer = useRef<number | undefined>(undefined);
  const saveChain = useRef<Promise<number>>(Promise.resolve(state.version));

  useEffect(() => {
    if (!dirty) {
      setDraft(state.ownDraft ?? createEmptyDraft());
      setVersion(state.version);
      saveChain.current = Promise.resolve(state.version);
    }
  }, [state.roundNumber, state.version]);

  async function save(nextDraft = draft) {
    if (submitted) return version;
    setSaving(true);
    setError('');
    const operation = saveChain.current.then(async (latestVersion) => {
      const result = await api<{ version: number }>(`/api/rooms/${state.roomId}/draft`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer: nextDraft, version: latestVersion }),
      });
      setVersion(result.version);
      setDirty(false);
      return result.version;
    });
    saveChain.current = operation.catch(() => version);
    try {
      return await operation;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '草稿保存失败');
      throw caught;
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    if (!dirty || submitted) return;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void save(), 800);
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [draft, dirty, submitted]);

  function update(key: AnswerFieldKey, value: string) {
    setDraft((current) => ({ ...current, [key]: value }));
    setDirty(true);
  }

  async function uploadAvatar(file: File) {
    setUploading(true);
    setError('');
    try {
      if (dirty) await save(draft);
      const compressed = await compressSquare(file);
      const result = await api<{ avatarKey: string; version: number }>(`/api/rooms/${state.roomId}/avatar`, {
        method: 'POST',
        headers: { 'Content-Type': compressed.type },
        body: compressed,
      });
      setDraft((current) => ({ ...current, avatarKey: result.avatarKey }));
      setVersion(result.version);
      setDirty(false);
      saveChain.current = Promise.resolve(result.version);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '头像上传失败');
    } finally {
      setUploading(false);
    }
  }

  async function uploadAnswerImage(field: AnswerFieldKey, file: File) {
    setUploadingField(field);
    setError('');
    try {
      if (file.size > 8_000_000) throw new Error('原图片不能超过 8MB');
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
        throw new Error('仅支持 JPEG、PNG 或 WebP 图片');
      }
      if (dirty) await save(draft);
      const compressed = await compressAnswerImage(file);
      const result = await api<{ imageKey: string; version: number }>(
        `/api/rooms/${state.roomId}/answer-image/${field}`,
        { method: 'POST', headers: { 'Content-Type': compressed.type }, body: compressed },
      );
      setDraft((current) => ({
        ...current,
        imageKeys: { ...current.imageKeys, [field]: result.imageKey },
      }));
      setVersion(result.version);
      setDirty(false);
      saveChain.current = Promise.resolve(result.version);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '答案图片上传失败');
    } finally {
      setUploadingField(null);
    }
  }

  async function removeAnswerImage(field: AnswerFieldKey) {
    setUploadingField(field);
    setError('');
    try {
      if (dirty) await save(draft);
      const result = await api<{ imageKey: null; version: number }>(
        `/api/rooms/${state.roomId}/answer-image/${field}`,
        { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) },
      );
      setDraft((current) => ({
        ...current,
        imageKeys: { ...current.imageKeys, [field]: null },
      }));
      setVersion(result.version);
      setDirty(false);
      saveChain.current = Promise.resolve(result.version);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '答案图片删除失败');
    } finally {
      setUploadingField(null);
    }
  }

  async function submit() {
    const hasText = fields.some((field) => Boolean(draft[field.key])) || Boolean(draft.message);
    const hasImage = Object.values(draft.imageKeys).some(Boolean);
    if (!draft.avatarKey || (!hasText && !hasImage)) {
      setError('请上传头像，并至少填写一段文字或上传一张答案图片');
      return;
    }
    if (!window.confirm('发布后内容会锁定。双方都发布后，任意一方都可以生成包含昵称、头像、文字和图片的公开分享。确认发布即表示你同意这项规则。')) return;
    try {
      if (dirty) await save(draft);
      await api(`/api/rooms/${state.roomId}/submit`, { method: 'POST' });
      await onRefresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '提交失败');
    }
  }

  if (submitted) {
    return (
      <PublishedConfirmation
        slot={me.slot}
        title={state.template.title}
        inviteUrl={inviteUrl}
      />
    );
  }

  return (
    <section class="fill-section" id="your-card">
      <RoomTemplateHeading template={state.template} />
      <div class="section-heading">
        <div><span class="eyebrow">ROUND {state.roundNumber} / YOUR SIDE</span><h2>先说说你自己。</h2></div>
        <div class="save-status">{saving ? '正在保存…' : dirty ? '等待保存' : '✓ 已自动保存'}</div>
      </div>
      <div class="answer-sheet">
        <AvatarEditor roomId={state.roomId} draft={draft} nickname={me.nickname} uploading={uploading} onFile={uploadAvatar} />
        <div class="sheet-fields">
          {fields.map((field, index) => (
            <label class={field.long ? 'field-block field-wide' : 'field-block'} key={field.key}>
              <span><b>{String(index + 1).padStart(2, '0')}</b>{state.template.fieldLabels[field.key]}</span>
              <AnswerImageEditor
                roomId={state.roomId}
                field={field.key}
                imageKey={draft.imageKeys[field.key]}
                busy={uploadingField === field.key}
                onFile={(file) => void uploadAnswerImage(field.key, file)}
                onRemove={() => void removeAnswerImage(field.key)}
              />
              {field.long ? (
                <textarea value={draft[field.key]} onInput={(e) => update(field.key, e.currentTarget.value)} maxLength={field.maxLength} placeholder={`${field.placeholder}（文字可选）`} rows={3} />
              ) : (
                <input value={draft[field.key]} onInput={(e) => update(field.key, e.currentTarget.value)} maxLength={field.maxLength} placeholder={`${field.placeholder}（文字可选）`} />
              )}
            </label>
          ))}
          <label class="field-block field-wide message-field">
            <span><b>09</b>{state.template.fieldLabels.message}</span>
            <AnswerImageEditor
              roomId={state.roomId}
              field="message"
              imageKey={draft.imageKeys.message}
              busy={uploadingField === 'message'}
              onFile={(file) => void uploadAnswerImage('message', file)}
              onRemove={() => void removeAnswerImage('message')}
            />
            <textarea value={draft.message} onInput={(e) => update('message', e.currentTarget.value)} maxLength={500} placeholder="还有什么没被上面的问题问到？（文字可选）" rows={5} />
          </label>
        </div>
      </div>
      {error && <p class="form-error submit-error" role="alert">{error}</p>}
      <div class="submit-row">
        <p>发布前只有你能看到草稿；发布后不能修改。</p>
        <button class="button button-accent button-large" onClick={submit} disabled={saving || uploading || Boolean(uploadingField)}>发布我的结果 →</button>
      </div>
    </section>
  );
}

export function PublishedConfirmation({ slot, title, inviteUrl }: {
  slot: 1 | 2;
  title: string;
  inviteUrl: string;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(shareClipboardText(title, inviteUrl));
      setCopyError('');
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopyError('复制失败，请检查浏览器的剪贴板权限后重试。');
    }
  }

  return (
    <section class="submitted-panel paper-panel">
      <div class="stamp">DONE</div>
      <span class="eyebrow">YOUR RESULT IS PUBLISHED</span>
      <h1>你的这一面，<br />已经发布。</h1>
      <p>{slot === 1 ? '所有加入本房间的二号都能看到你；你也能在下方看到每位已发布的二号。' : '一号现在可以看到你的结果；其他二号无法看到。'}</p>
      <div class="submitted-share-action">
        <button class="button button-accent" type="button" onClick={() => void copyInvite()}>
          {copied ? '邀请链接已复制 ✓' : '复制填写邀请链接 ↗'}
        </button>
        <small>邀请链接会带上房间主标题；收到链接的人可以加入房间填写自己的这一面。</small>
      </div>
      {copyError && <p class="submitted-share-hint" role="alert">{copyError}</p>}
    </section>
  );
}

function AnswerImageEditor({ roomId, field, imageKey, busy, onFile, onRemove }: {
  roomId: string;
  field: AnswerFieldKey;
  imageKey: string | null;
  busy: boolean;
  onFile: (file: File) => void;
  onRemove: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div class="answer-image-editor">
      {imageKey ? (
        <div class="answer-image-preview">
          <img src={`/api/rooms/${roomId}/media?key=${encodeURIComponent(imageKey)}`} alt="答案配图预览" />
          <div>
            <button type="button" class="text-button" onClick={() => input.current?.click()} disabled={busy}>{busy ? '处理中…' : '替换图片'}</button>
            <button type="button" class="text-button danger" onClick={onRemove} disabled={busy}>删除</button>
          </div>
        </div>
      ) : (
        <button type="button" class="answer-image-add" onClick={() => input.current?.click()} disabled={busy}>
          {busy ? '正在处理图片…' : '＋ 插入一张图片'}
        </button>
      )}
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) onFile(file);
          event.currentTarget.value = '';
        }}
        aria-label={`上传 ${field} 的答案图片`}
      />
    </div>
  );
}

function AvatarEditor({ roomId, draft, nickname, uploading, onFile }: { roomId: string; draft: AnswerDraft; nickname: string; uploading: boolean; onFile: (file: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div class="avatar-editor">
      <button type="button" onClick={() => input.current?.click()} aria-label="上传头像">
        {draft.avatarKey ? <img src={`/api/rooms/${roomId}/avatar?key=${encodeURIComponent(draft.avatarKey)}`} alt={`${nickname}的头像`} /> : <span>{uploading ? '处理中…' : '＋\n上传头像'}</span>}
      </button>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) onFile(file); event.currentTarget.value = ''; }} />
      <strong>{nickname}</strong>
      <small>受益（害）者 {nickname ? '' : '号'}</small>
    </div>
  );
}

async function compressSquare(file: File) {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const x = (bitmap.width - side) / 2;
  const y = (bitmap.height - side) / 2;
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  canvas.getContext('2d')!.drawImage(bitmap, x, y, side, side, 0, 0, 512, 512);
  bitmap.close();
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('图片处理失败')), 'image/webp', 0.82));
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('图片处理失败'))),
      'image/webp',
      quality,
    );
  });
}

async function compressAnswerImage(file: File) {
  const bitmap = await createImageBitmap(file);
  const maxSide = 1600;
  let scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  let quality = 0.84;
  let blob: Blob | null = null;
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前浏览器无法处理图片');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    blob = await canvasBlob(canvas, quality);
    if (blob.size <= 700_000) break;
    if (quality > 0.58) quality -= 0.08;
    else scale *= 0.82;
  }
  bitmap.close();
  if (!blob || blob.size > 1_000_000) throw new Error('图片压缩后仍然过大，请换一张图片');
  return blob;
}

function roomPosterPerson(roomId: string, answer: RevealedAnswer): PosterPerson {
  const imageUrls = { ...EMPTY_ANSWER_IMAGES } as Record<AnswerFieldKey, string | null>;
  for (const [key, imageKey] of Object.entries(answer.answer.imageKeys) as Array<[AnswerFieldKey, string | null]>) {
    imageUrls[key] = imageKey ? `/api/rooms/${roomId}/media?key=${encodeURIComponent(imageKey)}` : null;
  }
  return {
    nickname: answer.nickname,
    slot: answer.slot,
    avatarUrl: answer.answer.avatarKey
      ? `/api/rooms/${roomId}/media?key=${encodeURIComponent(answer.answer.avatarKey)}`
      : '',
    answer: answer.answer,
    imageUrls,
  };
}

function PublishedView({ state, onRefresh }: { state: AuthenticatedRoomState; onRefresh: () => Promise<void> }) {
  const me = state.participants.find((person) => person.isMe)!;
  const sorted = [...state.publishedAnswers].sort((left, right) => left.slot - right.slot);
  const host = sorted.find((answer) => answer.slot === 1);
  const [selectedGuest, setSelectedGuest] = useState<RevealedAnswer | null>(null);

  function openForParticipant(participantId: string) {
    const guest = me.slot === 1
      ? sorted.find((answer) => answer.slot === 2 && answer.participantId === participantId)
      : sorted.find((answer) => answer.slot === 2 && answer.participantId === me.id);
    if (host && guest) setSelectedGuest(guest);
  }

  return (
    <section class="reveal-section">
      <div class="reveal-heading">
        <span class="eyebrow">PUBLISHED RESULTS</span>
        <h1>{me.slot === 1 ? '这个房间里的，' : '你和一号的，'}<br /><em>已发布结果。</em></h1>
        <p>{me.slot === 1 ? '每个二号独立展示；他们彼此看不到对方。' : '这里只有你和一号发布的内容。'}</p>
      </div>
      <div class="published-grid">
        {sorted.map((answer) => {
          const canCreate = Boolean(
            host &&
            ((me.slot === 1 && answer.slot === 2) ||
              (me.slot === 2 && answer.participantId === me.id && answer.slot === 2)),
          );
          return (
            <div class="published-result" key={answer.participantId}>
              <RevealedCard roomId={state.roomId} data={answer} template={state.template} />
              {canCreate && (
                <button class="button button-dark share-result-button" onClick={() => setSelectedGuest(answer)}>
                  生成双人卡片 ↗
                </button>
              )}
            </div>
          );
        })}
      </div>
      <ShareHistory
        state={state}
        onRefresh={onRefresh}
        onRegenerate={(participantId) => openForParticipant(participantId)}
      />
      {host && selectedGuest && (
        <ShareModal
          state={state}
          host={host}
          guest={selectedGuest}
          onClose={() => setSelectedGuest(null)}
          onRefresh={onRefresh}
        />
      )}
    </section>
  );
}

export function shareClipboardText(title: string, shareUrl: string) {
  return `${title.trim()}\n${shareUrl}`;
}

function RevealedCard({ roomId, data, template }: { roomId: string; data: RevealedAnswer; template: RoomTemplate }) {
  function answerContent(key: AnswerFieldKey) {
    const imageKey = data.answer.imageKeys[key];
    return (
      <dd>
        {imageKey && <img class="revealed-answer-image" src={`/api/rooms/${roomId}/media?key=${encodeURIComponent(imageKey)}`} alt={`${template.fieldLabels[key]}的答案配图`} />}
        <span>{data.answer[key] || (imageKey ? '' : '—')}</span>
      </dd>
    );
  }
  return (
    <article class={`revealed-card slot-${data.slot}`}>
      <header>
        {data.answer.avatarKey ? <img src={`/api/rooms/${roomId}/media?key=${encodeURIComponent(data.answer.avatarKey)}`} alt={`${data.nickname}的头像`} /> : <div class="avatar-fallback">{data.slot}</div>}
        <div><span>受益（害）者 {data.slot} 号</span><h2>{data.nickname}</h2></div>
      </header>
      <dl>
        {fields.map((field, index) => (
          <div key={field.key}><dt>{String(index + 1).padStart(2, '0')} {template.fieldLabels[field.key]}</dt>{answerContent(field.key)}</div>
        ))}
        <div class="message-answer"><dt>09 {template.fieldLabels.message}</dt>{answerContent('message')}</div>
      </dl>
    </article>
  );
}

function ShareModal({ state, host, guest, onClose, onRefresh }: {
  state: AuthenticatedRoomState;
  host: RevealedAnswer;
  guest: RevealedAnswer;
  onClose: () => void;
  onRefresh: () => Promise<void>;
}) {
  const [previewUrl, setPreviewUrl] = useState('');
  const [result, setResult] = useState<ShareSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const posterInput: PosterInput = {
    template: state.template,
    host: roomPosterPerson(state.roomId, host),
    guest: roomPosterPerson(state.roomId, guest),
  };
  const me = state.participants.find((participant) => participant.isMe)!;
  const pairParticipantId = me.slot === 1 ? guest.participantId : host.participantId;

  useEffect(() => {
    let stopped = false;
    let objectUrl = '';
    setError('');
    void generatePoster(posterInput)
      .then((blob) => {
        if (stopped) return;
        objectUrl = URL.createObjectURL(blob);
        setPreviewUrl(objectUrl);
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : '预览生成失败'));
    return () => {
      stopped = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [state.roomId, host.participantId, guest.participantId]);

  async function create(forceNew = false) {
    setBusy(true);
    setError('');
    try {
      const created = await api<CreateShareResponse>(`/api/rooms/${state.roomId}/shares`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairParticipantId, forceNew }),
      });
      let activeShare = created.share;
      if (created.needsPoster) {
        const poster = await generatePoster({ ...posterInput, shareUrl: created.share.shareUrl });
        const uploaded = await api<{ share: ShareSummary }>(
          `/api/rooms/${state.roomId}/shares/${created.share.id}/poster`,
          { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: poster },
        );
        activeShare = uploaded.share;
      }
      setResult(activeShare);
      await onRefresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '分享生成失败');
    } finally {
      setBusy(false);
    }
  }

  async function posterBlob() {
    if (!result?.posterUrl) throw new Error('分享图片尚未生成');
    const response = await fetch(result.posterUrl);
    if (!response.ok) throw new Error('分享图片加载失败');
    return response.blob();
  }

  async function download() {
    try {
      const blob = await posterBlob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `一起揭晓-${host.nickname}-${guest.nickname}.png`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '下载失败');
    }
  }

  async function copyLink() {
    if (!result) return;
    const shareUrl = new URL(result.shareUrl, location.origin).href;
    await navigator.clipboard.writeText(shareClipboardText(state.template.title, shareUrl));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  async function systemShare() {
    if (!result) return;
    try {
      const file = new File([await posterBlob()], `一起揭晓-${host.nickname}-${guest.nickname}.png`, { type: 'image/png' });
      const data: ShareData = {
        title: `${host.nickname} × ${guest.nickname} 的双人卡片`,
        text: '扫码查看完整结果，创建你们的默契卡',
        url: result.shareUrl,
        files: [file],
      };
      if (navigator.canShare?.({ files: [file] })) await navigator.share(data);
      else await navigator.share({ title: data.title, text: data.text, url: data.url });
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setError(caught instanceof Error ? caught.message : '系统分享失败');
    }
  }

  return (
    <div class="modal-backdrop share-modal-backdrop" role="presentation">
      <section class="share-modal paper-panel" role="dialog" aria-modal="true" aria-labelledby="share-modal-title">
        <button class="modal-close" onClick={onClose} aria-label="关闭">×</button>
        <div class="share-preview-wrap">
          {result?.posterUrl ? <img src={result.posterUrl} alt="已生成的双人卡片" /> : previewUrl ? <img src={previewUrl} alt="双人卡片本地预览" /> : <div class="poster-loading">正在排版 1600 × 1600 海报…</div>}
        </div>
        <div class="share-modal-copy">
          <span class="eyebrow">{result ? 'SHARE READY / 30 DAYS' : 'LOCAL PREVIEW / PRIVATE'}</span>
          <h2 id="share-modal-title">{host.nickname} × {guest.nickname}</h2>
          {result ? (
            <>
              <p>公开链接将在 {new Date(result.expiresAt).toLocaleString('zh-CN')} 到期。图片和扫码页面内容保持一致。</p>
              <div class="share-action-grid">
                <button class="button button-dark" onClick={() => void download()}>下载 PNG</button>
                <button class="button" onClick={() => void copyLink()}>{copied ? '已复制 ✓' : '复制链接'}</button>
                {typeof navigator !== 'undefined' && 'share' in navigator && <button class="button button-accent" onClick={() => void systemShare()}>系统分享</button>}
              </div>
              <button class="text-button" onClick={() => void create(true)} disabled={busy}>生成一条新链接</button>
            </>
          ) : (
            <>
              <p>当前预览只在你的浏览器中生成，尚未公开。确认后会创建一条固定有效 30 天的公开链接和二维码。</p>
              <div class="public-consent">
                公开内容包括双方昵称、头像、全部已发布文字和图片。分享页不会被搜索引擎收录。
              </div>
              <button class="button button-accent button-large" onClick={() => void create()} disabled={busy || !previewUrl}>
                {busy ? '正在生成分享…' : '确认公开并生成卡片'}
              </button>
            </>
          )}
          {error && <p class="form-error" role="alert">{error}</p>}
        </div>
      </section>
    </div>
  );
}

function ShareHistory({ state, onRefresh, onRegenerate }: {
  state: AuthenticatedRoomState;
  onRefresh: () => Promise<void>;
  onRegenerate: (participantId: string) => void;
}) {
  const [error, setError] = useState('');
  if (!state.myShares.length) return null;

  async function revoke(share: ShareSummary) {
    if (!window.confirm(`撤销与 ${share.pairNickname} 的这条分享？公开图片和完整快照会被删除。`)) return;
    try {
      await api(`/api/rooms/${state.roomId}/shares/${share.id}`, { method: 'DELETE' });
      await onRefresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '撤销失败');
    }
  }

  async function copy(share: ShareSummary) {
    const shareUrl = new URL(share.shareUrl, location.origin).href;
    await navigator.clipboard.writeText(shareClipboardText(state.template.title, shareUrl));
  }

  const statusLabel: Record<ShareSummary['status'], string> = {
    pending: '生成中', active: '有效', revoked: '已撤销', expired: '已过期',
  };
  return (
    <section class="share-history">
      <div><span class="eyebrow">MY SHARES</span><h2>我的分享</h2><p>你只能管理自己创建的链接。</p></div>
      <div class="share-history-list">
        {state.myShares.map((share) => (
          <article key={share.id}>
            <div>
              <strong>与 {share.pairNickname}</strong>
              <small>{new Date(share.createdAt).toLocaleString('zh-CN')} · {statusLabel[share.status]}</small>
              {share.status === 'active' && <small>到期：{new Date(share.expiresAt).toLocaleString('zh-CN')}</small>}
            </div>
            <div class="share-history-actions">
              {share.status === 'active' ? (
                <>
                  <button class="text-button" onClick={() => void copy(share)}>复制链接</button>
                  {share.posterUrl && <a class="text-button" href={share.posterUrl} download>下载图片</a>}
                  <button class="text-button danger" onClick={() => void revoke(share)}>撤销</button>
                </>
              ) : (
                <button class="text-button" onClick={() => onRegenerate(share.pairParticipantId)}>重新生成</button>
              )}
            </div>
          </article>
        ))}
      </div>
      {error && <p class="form-error" role="alert">{error}</p>}
    </section>
  );
}

function HistoryList({ roomId, history, template }: { roomId: string; history: AuthenticatedRoomState['history']; template: RoomTemplate }) {
  return (
    <section class="history-section">
      <span class="eyebrow">ARCHIVE / PREVIOUS ROUNDS</span>
      <h2>你们的旧卡片</h2>
      {history.map((round) => (
        <details key={round.roundNumber}>
          <summary><span>ROUND {String(round.roundNumber).padStart(2, '0')}</span><time>{new Date(round.revealedAt).toLocaleDateString('zh-CN')}</time><b>展开 ＋</b></summary>
          <div class="comparison-grid compact">
            {round.answers.map((answer) => <RevealedCard roomId={roomId} data={answer} template={template} key={answer.participantId} />)}
          </div>
        </details>
      ))}
    </section>
  );
}

function CopyButton({ value, children }: { value: string; children: ComponentChildren }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }
  return <button class="button button-dark" onClick={copy}>{copied ? '已复制 ✓' : children}</button>;
}
