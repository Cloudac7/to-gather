import QRCode from 'qrcode';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type {
  AnswerDraft,
  AuthenticatedRoomState,
  CreateRoomResponse,
  JoinRoomResponse,
  RevealedAnswer,
  RoomState,
  ServerEvent,
} from '../lib/types';
import { EMPTY_DRAFT } from '../lib/types';

interface Props {
  roomId: string;
}

interface ApiError {
  message?: string;
}

const fields: Array<{
  key: Exclude<keyof AnswerDraft, 'avatarKey' | 'message'>;
  label: string;
  placeholder: string;
  long?: boolean;
}> = [
  { key: 'favoriteAnimal', label: '最喜欢的动物', placeholder: '猫、海獭、卡皮巴拉…' },
  { key: 'favoriteColor', label: '最喜欢的颜色', placeholder: '落日橙、克莱因蓝…' },
  { key: 'favoritePerson', label: '最喜欢的人物', placeholder: '真人或虚构人物都可以' },
  { key: 'favoriteSong', label: '最喜欢的歌', placeholder: '最近循环的那一首' },
  { key: 'mbti', label: 'MBTI', placeholder: '比如 ENFP（不知道也没关系）' },
  { key: 'recentProduct', label: '最近买的产品', placeholder: '一件让你想安利或吐槽的东西' },
  { key: 'dreamActivity', label: '最想和对方一起做的事情', placeholder: '认真说，也可以大胆一点', long: true },
  { key: 'curiousAbout', label: '想入坑但一直没认真了解的', placeholder: '某项运动、游戏、爱好或知识', long: true },
];

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

function JoinScreen({ roomId, full, onJoined }: { roomId: string; full: boolean; onJoined: (code: string) => void }) {
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
      <a class="brand floating-brand" href="/"><span class="brand-mark">两</span><span>TOGETHER CARD</span></a>
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
              <input id="join-code" class="code-input" inputMode="numeric" pattern="[0-9]*" value={joinCode} onInput={(e) => setJoinCode(e.currentTarget.value.replace(/\D/g, '').slice(0, 6))} placeholder="000000" />
            </>
          ) : (
            <>
              <label>你原来的位置</label>
              <div class="slot-choice">
                <button type="button" class={slot === 1 ? 'active' : ''} onClick={() => setSlot(1)}>1 号</button>
                <button type="button" class={slot === 2 ? 'active' : ''} onClick={() => setSlot(2)}>2 号</button>
              </div>
              <label for="recovery-code">十二位恢复码</label>
              <input id="recovery-code" class="code-input recovery-input" value={recoveryCode} onInput={(e) => setRecoveryCode(e.currentTarget.value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 12))} placeholder="ABCD2EFG3HJK" />
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
        <a class="brand" href="/"><span class="brand-mark">两</span><span>TOGETHER CARD</span></a>
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

      <FillView state={state} onRefresh={onRefresh} />

      {state.publishedAnswers.length > 0 && <PublishedView state={state} />}

      {state.history.length > 0 && <HistoryList roomId={state.roomId} history={state.history} />}
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
      {src && <a class="text-button" href={src} download={`together-card-${roomId}.png`}>下载二维码</a>}
    </div>
  );
}

function FillView({ state, onRefresh }: { state: AuthenticatedRoomState; onRefresh: () => Promise<void> }) {
  const me = state.participants.find((person) => person.isMe)!;
  const [draft, setDraft] = useState<AnswerDraft>(state.ownDraft ?? { ...EMPTY_DRAFT });
  const [version, setVersion] = useState(state.version);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const submitted = me.submitted;
  const timer = useRef<number | undefined>(undefined);
  const saveChain = useRef<Promise<number>>(Promise.resolve(state.version));

  useEffect(() => {
    if (!dirty) {
      setDraft(state.ownDraft ?? { ...EMPTY_DRAFT });
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

  function update(key: keyof AnswerDraft, value: string) {
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

  async function submit() {
    if (!draft.avatarKey || !Object.entries(draft).some(([key, value]) => key !== 'avatarKey' && Boolean(value))) {
      setError('请上传头像并至少填写一个答案');
      return;
    }
    if (!window.confirm('发布后答案会锁定，并立即对有权限的配对对象可见。确定发布吗？')) return;
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
      <section class="submitted-panel paper-panel">
        <div class="stamp">DONE</div>
        <span class="eyebrow">YOUR RESULT IS PUBLISHED</span>
        <h1>你的这一面，<br />已经发布。</h1>
        <p>{me.slot === 1 ? '所有加入本房间的二号都能看到你；你也能在下方看到每位已发布的二号。' : '一号现在可以看到你的结果；其他二号无法看到。'}</p>
      </section>
    );
  }

  return (
    <section class="fill-section" id="your-card">
      <div class="section-heading">
        <div><span class="eyebrow">ROUND {state.roundNumber} / YOUR SIDE</span><h1>先说说你自己。</h1></div>
        <div class="save-status">{saving ? '正在保存…' : dirty ? '等待保存' : '✓ 已自动保存'}</div>
      </div>
      <div class="answer-sheet">
        <AvatarEditor roomId={state.roomId} draft={draft} nickname={me.nickname} uploading={uploading} onFile={uploadAvatar} />
        <div class="sheet-fields">
          {fields.map((field, index) => (
            <label class={field.long ? 'field-block field-wide' : 'field-block'} key={field.key}>
              <span><b>{String(index + 1).padStart(2, '0')}</b>{field.label}</span>
              {field.long ? (
                <textarea value={draft[field.key]} onInput={(e) => update(field.key, e.currentTarget.value)} maxLength={240} placeholder={field.placeholder} rows={3} />
              ) : (
                <input value={draft[field.key]} onInput={(e) => update(field.key, e.currentTarget.value)} maxLength={field.key === 'mbti' ? 16 : field.key === 'recentProduct' ? 120 : 80} placeholder={field.placeholder} />
              )}
            </label>
          ))}
          <label class="field-block field-wide message-field">
            <span><b>09</b>自由发言（搏击）区</span>
            <textarea value={draft.message} onInput={(e) => update('message', e.currentTarget.value)} maxLength={500} placeholder="还有什么没被上面的问题问到？" rows={5} />
          </label>
        </div>
      </div>
      {error && <p class="form-error submit-error" role="alert">{error}</p>}
      <div class="submit-row">
        <p>发布前只有你能看到草稿；发布后不能修改。</p>
        <button class="button button-accent button-large" onClick={submit} disabled={saving || uploading}>发布我的结果 →</button>
      </div>
    </section>
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

function PublishedView({ state }: { state: AuthenticatedRoomState }) {
  const me = state.participants.find((person) => person.isMe)!;
  const sorted = [...state.publishedAnswers].sort((left, right) => left.slot - right.slot);
  return (
    <section class="reveal-section">
      <div class="reveal-heading">
        <span class="eyebrow">PUBLISHED RESULTS</span>
        <h1>{me.slot === 1 ? '这个房间里的，' : '你和一号的，'}<br /><em>已发布结果。</em></h1>
        <p>{me.slot === 1 ? '每个二号独立展示；他们彼此看不到对方。' : '这里只有你和一号发布的内容。'}</p>
      </div>
      <div class="published-grid">
        {sorted.map((answer) => (
          <RevealedCard roomId={state.roomId} data={answer} key={answer.participantId} />
        ))}
      </div>
    </section>
  );
}

function RevealedCard({ roomId, data }: { roomId: string; data: RevealedAnswer }) {
  return (
    <article class={`revealed-card slot-${data.slot}`}>
      <header>
        {data.answer.avatarKey ? <img src={`/api/rooms/${roomId}/avatar?key=${encodeURIComponent(data.answer.avatarKey)}`} alt={`${data.nickname}的头像`} /> : <div class="avatar-fallback">{data.slot}</div>}
        <div><span>受益（害）者 {data.slot} 号</span><h2>{data.nickname}</h2></div>
      </header>
      <dl>
        {fields.map((field, index) => (
          <div key={field.key}><dt>{String(index + 1).padStart(2, '0')} {field.label}</dt><dd>{data.answer[field.key] || '—'}</dd></div>
        ))}
        <div class="message-answer"><dt>09 自由发言（搏击）区</dt><dd>{data.answer.message || '—'}</dd></div>
      </dl>
    </article>
  );
}

function HistoryList({ roomId, history }: { roomId: string; history: AuthenticatedRoomState['history'] }) {
  return (
    <section class="history-section">
      <span class="eyebrow">ARCHIVE / PREVIOUS ROUNDS</span>
      <h2>你们的旧卡片</h2>
      {history.map((round) => (
        <details key={round.roundNumber}>
          <summary><span>ROUND {String(round.roundNumber).padStart(2, '0')}</span><time>{new Date(round.revealedAt).toLocaleDateString('zh-CN')}</time><b>展开 ＋</b></summary>
          <div class="comparison-grid compact">
            {round.answers.map((answer) => <RevealedCard roomId={roomId} data={answer} key={answer.participantId} />)}
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
