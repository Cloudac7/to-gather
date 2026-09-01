// @vitest-environment happy-dom

import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { RoomTemplateHeading } from '../src/components/RoomApp';
import { DEFAULT_ROOM_TEMPLATE } from '../src/lib/types';

describe('fill page room title', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('shows the fixed room title and subtitle above the form', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);

    render(
      <RoomTemplateHeading
        template={{ ...DEFAULT_ROOM_TEMPLATE, title: '我们的默契卡', subtitle: '认真填，也可以大胆一点' }}
      />,
      container,
    );

    expect(container.querySelector('h1')?.textContent).toBe('我们的默契卡');
    expect(container.querySelector('p')?.textContent).toBe('认真填，也可以大胆一点');
  });

  it('does not reserve subtitle space when the subtitle is empty', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);

    render(<RoomTemplateHeading template={{ ...DEFAULT_ROOM_TEMPLATE, subtitle: '' }} />, container);

    expect(container.querySelector('p')).toBeNull();
  });
});
