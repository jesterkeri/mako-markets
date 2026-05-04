// ----------------------------------------------------------------------------
// avatar-circle.test.tsx
//
// DOM-level tests for the AvatarCircle component. Pure logic
// (initials + palette) is covered by avatar-glyph.test.ts; this file
// covers the component's actual rendering + the img→initials
// fallback on broken URLs.
// ----------------------------------------------------------------------------

import { afterEach, describe, expect, it } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';

import { AvatarCircle } from '../../components/AvatarCircle';

afterEach(cleanup);

const EOA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const EMAIL = 'joshua@example.com';

describe('AvatarCircle', () => {
  it('renders an <img> when avatarUrl is non-null', () => {
    const { container } = render(
      <AvatarCircle
        displayName="Joshua"
        email={EMAIL}
        magicEoa={EOA}
        avatarUrl="https://example.com/a.png"
      />,
    );
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('https://example.com/a.png');
    expect(img!.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('renders initials fallback when avatarUrl is null', () => {
    const { container } = render(
      <AvatarCircle
        displayName="Joshua"
        email={EMAIL}
        magicEoa={EOA}
        avatarUrl={null}
      />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('J');
  });

  it('img onError flips to initials fallback', () => {
    const { container } = render(
      <AvatarCircle
        displayName="Joshua"
        email={EMAIL}
        magicEoa={EOA}
        avatarUrl="https://example.com/broken.png"
      />,
    );
    const img = container.querySelector('img')!;
    expect(img).not.toBeNull();
    fireEvent.error(img);
    // After onError fires, the component re-renders with initials.
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('J');
  });

  it('initials use email when displayName is null', () => {
    const { container } = render(
      <AvatarCircle
        displayName={null}
        email="alice@example.com"
        magicEoa={EOA}
        avatarUrl={null}
      />,
    );
    expect(container.textContent).toContain('A');
  });

  it('a fresh URL after a prior failure is given a new attempt (prop-change reset)', () => {
    function Wrapper() {
      const [url, setUrl] = useState<string | null>(
        'https://example.com/broken.png',
      );
      return (
        <div>
          <button
            type="button"
            data-testid="set-new-url"
            onClick={() => setUrl('https://example.com/fresh.png')}
          >
            new url
          </button>
          <AvatarCircle
            displayName="Joshua"
            email={EMAIL}
            magicEoa={EOA}
            avatarUrl={url}
          />
        </div>
      );
    }
    const { container, getByTestId } = render(<Wrapper />);

    // First render: img is present, fail it.
    const firstImg = container.querySelector('img')!;
    fireEvent.error(firstImg);
    expect(container.querySelector('img')).toBeNull();

    // Change the URL — the component must re-attempt with the new src.
    fireEvent.click(getByTestId('set-new-url'));
    const secondImg = container.querySelector('img');
    expect(secondImg).not.toBeNull();
    expect(secondImg!.getAttribute('src')).toBe(
      'https://example.com/fresh.png',
    );
  });

  it('palette colors are deterministic per EOA across renders', () => {
    const { container, rerender } = render(
      <AvatarCircle
        displayName={null}
        email={EMAIL}
        magicEoa={EOA}
        avatarUrl={null}
      />,
    );
    const firstClasses = container.firstElementChild!.className;
    rerender(
      <AvatarCircle
        displayName={null}
        email={EMAIL}
        magicEoa={EOA}
        avatarUrl={null}
      />,
    );
    const secondClasses = container.firstElementChild!.className;
    expect(secondClasses).toBe(firstClasses);
  });
});
