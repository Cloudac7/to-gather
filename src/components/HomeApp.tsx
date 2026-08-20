import { useState } from 'preact/hooks';
import type { CreateRoomResponse } from '../lib/types';

export default function HomeApp() {
  const [nickname, setNickname] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function createRoom(event: Event) {
    event.preventDefault();
    if (!nickname.trim()) {
      setError('请先输入昵称');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname }),
      });
      const payload = (await response.json()) as CreateRoomResponse & { message?: string };
      if (!response.ok) throw new Error(payload.message ?? '创建失败，请稍后再试');
      sessionStorage.setItem(`duet_invite_${payload.roomId}`, JSON.stringify(payload));
      window.location.assign(`/room/${payload.roomId}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '创建失败，请稍后再试');
      setLoading(false);
    }
  }

  return (
    <main class="home-page">
      <nav class="topbar">
        <a class="brand" href="/" aria-label="双人默契卡首页">
          <span class="brand-mark">两</span>
          <span>TOGETHER CARD</span>
        </a>
        <span class="privacy-pill">30 天后自动消失</span>
      </nav>

      <section class="hero">
        <div class="hero-copy">
          <span class="eyebrow">NO. 02 / DOUBLE-SIDED PORTRAIT</span>
          <h1>
            这样的两个人
            <br />
            <em>是亲友？</em>
          </h1>
          <p class="hero-subtitle">不知道啊，填完一起看。</p>
          <div class="hero-rules" aria-label="玩法">
            <span>01 一号建房</span>
            <span>02 多人加入</span>
            <span>03 各自发布</span>
          </div>
        </div>

        <form class="create-card paper-panel" onSubmit={createRoom}>
          <span class="card-index">START HERE ↘</span>
          <h2>先占一个位置</h2>
          <label for="creator-name">怎么称呼你？</label>
          <input
            id="creator-name"
            value={nickname}
            onInput={(event) => setNickname((event.currentTarget as HTMLInputElement).value)}
            maxLength={24}
            placeholder="输入昵称"
            autocomplete="nickname"
            autofocus
          />
          {error && <p class="form-error" role="alert">{error}</p>}
          <button class="button button-accent" type="submit" disabled={loading}>
            {loading ? '正在铺开卡片…' : '创建双人卡片'}
            <span aria-hidden="true">→</span>
          </button>
          <p class="microcopy">无需注册。创建后可用同一链接、二维码和加入码邀请多个二号。</p>
        </form>

        <div class="sample-card" aria-hidden="true">
          <div class="sample-half sample-left">
            <span>最喜欢的动物</span>
            <strong>？</strong>
            <small>受益（害）者 1 号</small>
          </div>
          <div class="sample-half sample-right">
            <span>最喜欢的动物</span>
            <strong>？</strong>
            <small>受益（害）者 2 号</small>
          </div>
        </div>
      </section>

      <footer class="home-footer">
        <p>答案不会公开，也不会出现在搜索结果里。</p>
        <p>PRIVATE BY DEFAULT · TWO SEATS ONLY</p>
      </footer>
    </main>
  );
}
