import { useEffect, useState } from 'preact/hooks';
import type { AnswerFieldKey, PublicAnswer, PublicShareState, RoomTemplate } from '../lib/types';
import { CARD_FIELDS } from '../lib/card';

export default function ShareLoader({ shareId }: { shareId: string }) {
  const [state, setState] = useState<PublicShareState | null>(null);
  useEffect(() => {
    let stopped = false;
    void fetch(`/api/shares/${shareId}`)
      .then(async (response) => {
        const payload = (await response.json().catch(() => ({}))) as Partial<PublicShareState>;
        if (stopped) return;
        if (payload.status === 'active' || payload.status === 'revoked' || payload.status === 'expired') {
          setState(payload as PublicShareState);
        } else {
          setState({ status: 'not_found', id: shareId });
        }
      })
      .catch(() => {
        if (!stopped) setState({ status: 'not_found', id: shareId });
      });
    return () => { stopped = true; };
  }, [shareId]);
  if (!state) return <main class="center-page"><p class="loading-copy">正在打开这份双人卡片…</p></main>;
  return <ShareView state={state} />;
}

function ShareView({ state }: { state: PublicShareState }) {
  if (state.status !== 'active') {
    const title = state.status === 'revoked' ? '此分享已被撤销' : state.status === 'expired' ? '此分享已过期' : '没有找到这条分享';
    const copy = state.status === 'revoked'
      ? '创建者已经停止公开这份内容。'
      : state.status === 'expired'
        ? '分享链接固定保留 30 天，相关图片和完整答案已经删除。'
        : '请检查链接是否完整。';
    return (
      <main class="center-page public-share-gone">
        <section class="empty-state paper-panel">
          <span class="eyebrow">SHARE UNAVAILABLE</span>
          <h1>{title}</h1><p>{copy}</p>
          <a class="button button-accent" href="/">创建我的双人卡片 →</a>
        </section>
      </main>
    );
  }

  return (
    <main class="public-share-page">
      <header class="public-share-header">
        <a class="brand" href="/"><span class="brand-mark">两</span><span>TO-GATHER</span></a>
        <span>分享将在 {new Date(state.expiresAt).toLocaleDateString('zh-CN')} 到期</span>
      </header>
      <section class="public-poster-section">
        <div>
          <span class="eyebrow">A TWO-SIDED PORTRAIT</span>
          <h1>{state.template.title}</h1>
          {state.template.subtitle && <p>{state.template.subtitle}</p>}
          <div class="public-poster-actions">
            <a class="button button-dark" href={state.posterUrl} download>下载这张卡片</a>
            <a class="button button-accent" href="/">创建我的双人卡片</a>
          </div>
        </div>
        <img src={state.posterUrl} alt={`${state.host.nickname}和${state.guest.nickname}的双人卡片`} />
      </section>
      <section class="public-results">
        <div class="section-heading">
          <div><span class="eyebrow">FULL RESULTS</span><h1>图片里没放下的，<br />都在这里。</h1></div>
          <p>公开快照生成后不会随房间内容变化。</p>
        </div>
        <div class="public-answer-grid">
          <PublicAnswerCard data={state.host} template={state.template} />
          <PublicAnswerCard data={state.guest} template={state.template} />
        </div>
      </section>
      <footer class="public-share-footer">
        <div><strong>一起揭晓</strong><p>把喜欢、期待和想说的话，做成只属于你们的双人卡片。</p></div>
        <a class="button button-accent" href="/">开始创建 →</a>
      </footer>
    </main>
  );
}

function PublicAnswerCard({ data, template }: { data: PublicAnswer; template: RoomTemplate }) {
  function content(key: AnswerFieldKey) {
    const imageUrl = data.answer.imageUrls[key];
    return (
      <dd>
        {imageUrl && <img src={imageUrl} alt={`${template.fieldLabels[key]}的答案配图`} loading="lazy" />}
        <span>{data.answer[key] || (imageUrl ? '' : '—')}</span>
      </dd>
    );
  }
  return (
    <article class={`public-answer-card slot-${data.slot}`}>
      <header>
        {data.answer.avatarUrl && <img src={data.answer.avatarUrl} alt={`${data.nickname}的头像`} />}
        <div><small>受益（害）者 {data.slot} 号</small><h2>{data.nickname}</h2></div>
      </header>
      <dl>
        {CARD_FIELDS.map((field, index) => (
          <div key={field.key}><dt>{String(index + 1).padStart(2, '0')} {template.fieldLabels[field.key]}</dt>{content(field.key)}</div>
        ))}
        <div><dt>09 {template.fieldLabels.message}</dt>{content('message')}</div>
      </dl>
    </article>
  );
}
