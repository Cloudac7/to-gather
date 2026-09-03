import { useState } from 'preact/hooks';
import { ALL_CARD_FIELDS } from '../lib/card';
import type { AnswerFieldKey, CreateRoomResponse, MusicFieldType, RoomTemplate, RoomVariant } from '../lib/types';
import { DEFAULT_ROOM_TEMPLATE, MUSIC_ROOM_TEMPLATE } from '../lib/types';

function freshTemplate(variant: RoomVariant = 'classic'): RoomTemplate {
  const source = variant === 'music' ? MUSIC_ROOM_TEMPLATE : DEFAULT_ROOM_TEMPLATE;
  return { ...source, fieldLabels: { ...source.fieldLabels }, fieldTypes: { ...source.fieldTypes } };
}

export default function HomeApp() {
  const [nickname, setNickname] = useState('');
  const [template, setTemplate] = useState<RoomTemplate>(freshTemplate);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const defaultTemplate = template.variant === 'music' ? MUSIC_ROOM_TEMPLATE : DEFAULT_ROOM_TEMPLATE;
  const customized = JSON.stringify(template) !== JSON.stringify(defaultTemplate);

  function selectVariant(variant: RoomVariant) {
    setTemplate(freshTemplate(variant));
    setConfirming(false);
    setError('');
  }

  function updateTemplate<K extends 'title' | 'subtitle'>(key: K, value: RoomTemplate[K]) {
    setTemplate((current) => ({ ...current, [key]: value }));
  }

  function updateLabel(key: keyof RoomTemplate['fieldLabels'], value: string) {
    setTemplate((current) => ({
      ...current,
      fieldLabels: { ...current.fieldLabels, [key]: value },
    }));
  }

  function updateFieldType(key: AnswerFieldKey, value: MusicFieldType) {
    setTemplate((current) => ({
      ...current,
      fieldTypes: { ...current.fieldTypes, [key]: value },
    }));
  }

  async function performCreate() {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname, template }),
      });
      const payload = (await response.json()) as CreateRoomResponse & { message?: string };
      if (!response.ok) throw new Error(payload.message ?? '创建失败，请稍后再试');
      sessionStorage.setItem(`duet_invite_${payload.roomId}`, JSON.stringify(payload));
      window.location.assign(`/room/${payload.roomId}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '创建失败，请稍后再试');
      setLoading(false);
      setConfirming(false);
    }
  }

  function createRoom(event: Event) {
    event.preventDefault();
    if (!nickname.trim()) {
      setError('请先输入昵称');
      return;
    }
    if (customized) {
      setConfirming(true);
      return;
    }
    void performCreate();
  }

  return (
    <main class="home-page">
      <nav class="topbar">
        <a class="brand" href="/" aria-label="双人默契卡首页">
          <span class="brand-mark">两</span>
          <span>TO-GATHER</span>
        </a>
        <span class="privacy-pill">房间与分享均保留 30 天</span>
      </nav>

      <section class="hero">
        <div class="hero-copy">
          <span class="eyebrow">NO. 02 / DOUBLE-SIDED PORTRAIT</span>
          <h1>这样的两个人<br /><em>是亲友？</em></h1>
          <p class="hero-subtitle">不知道啊，填完一起看。</p>
          <div class="hero-rules" aria-label="玩法">
            <span>01 一号建房</span><span>02 多人加入</span><span>03 各自发布</span>
          </div>
        </div>

        <form class="create-card paper-panel" onSubmit={createRoom}>
          <span class="card-index">START HERE ↘</span>
          <h2>先占一个位置</h2>
          <fieldset class="template-picker">
            <legend>选一张要填的卡</legend>
            <div>
              <button
                type="button"
                class={template.variant === 'classic' ? 'template-option active' : 'template-option'}
                aria-pressed={template.variant === 'classic'}
                onClick={() => selectVariant('classic')}
              >
                <small>ORIGINAL / 01</small>
                <strong>普通默契卡</strong>
                <span>喜欢、期待和想说的话</span>
              </button>
              <button
                type="button"
                class={template.variant === 'music' ? 'template-option music active' : 'template-option music'}
                aria-pressed={template.variant === 'music'}
                onClick={() => selectVariant('music')}
              >
                <small>MUSIC / 02</small>
                <strong>一起听卡片</strong>
                <span>歌手、专辑和循环最多的歌</span>
              </button>
            </div>
          </fieldset>
          <label for="creator-name">怎么称呼你？</label>
          <input
            id="creator-name"
            value={nickname}
            onInput={(event) => setNickname(event.currentTarget.value)}
            maxLength={24}
            placeholder="输入昵称"
            autocomplete="nickname"
            autofocus
          />

          <details class="template-settings">
            <summary>自定义标题和字段 <span>{customized ? '已修改' : '可选'}</span></summary>
            <div class="template-editor">
              <label for="card-title">主标题 <small>{template.title.length}/24</small></label>
              <input id="card-title" value={template.title} maxLength={24} onInput={(event) => updateTemplate('title', event.currentTarget.value.replace(/[\r\n]/g, ''))} />
              <label for="card-subtitle">副标题 <small>{template.subtitle.length}/40</small></label>
              <input id="card-subtitle" value={template.subtitle} maxLength={40} onInput={(event) => updateTemplate('subtitle', event.currentTarget.value.replace(/[\r\n]/g, ''))} />
              <div class={template.variant === 'music' ? 'template-labels music-field-types' : 'template-labels'}>
                {ALL_CARD_FIELDS.map((key, index) => (
                  <label class={template.variant === 'music' ? 'with-field-type' : ''} key={key}>
                    <span>{String(index + 1).padStart(2, '0')}</span>
                    <input
                      value={template.fieldLabels[key]}
                      maxLength={12}
                      aria-label={`第 ${index + 1} 个字段标题`}
                      onInput={(event) => updateLabel(key, event.currentTarget.value.replace(/[\r\n]/g, ''))}
                    />
                    {template.variant === 'music' && (
                      <select
                        value={template.fieldTypes[key]}
                        aria-label={`第 ${index + 1} 个字段类型`}
                        onChange={(event) => updateFieldType(key, event.currentTarget.value as MusicFieldType)}
                      >
                        <option value="artist">歌手</option>
                        <option value="song">歌曲</option>
                        <option value="album">专辑</option>
                        <option value="custom">自定义</option>
                      </select>
                    )}
                  </label>
                ))}
              </div>
              <button type="button" class="text-button" onClick={() => setTemplate(freshTemplate(template.variant))}>恢复这张卡的默认文案</button>
              <p>房间创建后，以上标题会固定并用于双方填写、结果和分享。</p>
            </div>
          </details>

          {error && <p class="form-error" role="alert">{error}</p>}
          <button class="button button-accent" type="submit" disabled={loading}>
            {loading ? '正在铺开卡片…' : template.variant === 'music' ? '创建一起听卡片' : '创建双人卡片'}<span aria-hidden="true">→</span>
          </button>
          <p class="microcopy">无需注册。创建后可用同一链接、二维码和加入码邀请最多 20 位二号。</p>
        </form>

        <div class="sample-card" aria-hidden="true">
          <div class="sample-half sample-left"><span>最喜欢的动物</span><strong>？</strong><small>受益（害）者 1 号</small></div>
          <div class="sample-half sample-right"><span>最喜欢的动物</span><strong>？</strong><small>受益（害）者 2 号</small></div>
        </div>
      </section>

      <footer class="home-footer">
        <p>默认仅房间参与者可见；公开分享需要再次确认。</p>
        <p>PRIVATE BY DEFAULT · UP TO 20 GUESTS</p>
      </footer>

      {confirming && (
        <div class="modal-backdrop" role="presentation">
          <section class="template-confirm paper-panel" role="dialog" aria-modal="true" aria-labelledby="template-confirm-title">
            <span class="eyebrow">FINAL CHECK / LOCK AFTER CREATION</span>
            <h2 id="template-confirm-title">确认这套房间标题</h2>
            <div class="template-mini-preview">
              <strong>{template.title}</strong>
              {template.subtitle && <p>{template.subtitle}</p>}
              <div>{ALL_CARD_FIELDS.map((key) => <span key={key}>{template.fieldLabels[key]}</span>)}</div>
            </div>
            <p>创建后标题不能修改，并会应用到所有参与者的填写和分享。</p>
            <div class="modal-actions">
              <button class="button" type="button" onClick={() => setConfirming(false)} disabled={loading}>返回修改</button>
              <button class="button button-accent" type="button" onClick={() => void performCreate()} disabled={loading}>
                {loading ? '正在创建…' : '确认并创建'}
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
