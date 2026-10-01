// RefCapture: the campaign tag in the page's query string lands in the mako_ref cookie, the latest valid tag wins,
// and an invalid one changes nothing.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import * as React from 'react';

const nav = vi.hoisted(() => ({ search: new URLSearchParams() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => nav.search }));

import { RefCapture } from '@/components/shell/RefCapture';

const refCookie = () => document.cookie.split('; ').find((c) => c.startsWith('mako_ref='))?.slice('mako_ref='.length) ?? null;

afterEach(() => {
  cleanup();
  // A past expiry, not Max-Age=0: jsdom can keep a Max-Age=0 cookie (with an empty value) within the same millisecond.
  document.cookie = 'mako_ref=; expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/';
});

describe('RefCapture', () => {
  it('stores utm_campaign, lower-cased', () => {
    nav.search = new URLSearchParams('utm_source=x&utm_campaign=Post3');
    render(<RefCapture />);
    expect(refCookie()).toBe('post3');
  });

  it('keeps the previous tag when the new one is invalid, and takes the next valid one', () => {
    nav.search = new URLSearchParams('ref=post3');
    const { rerender } = render(<RefCapture />);
    expect(refCookie()).toBe('post3');
    nav.search = new URLSearchParams('ref=bad_tag');
    rerender(<RefCapture />);
    expect(refCookie()).toBe('post3');
    nav.search = new URLSearchParams('utm_campaign=post4');
    rerender(<RefCapture />);
    expect(refCookie()).toBe('post4');
  });

  it('writes nothing without a tag', () => {
    nav.search = new URLSearchParams('utm_source=x');
    render(<RefCapture />);
    expect(refCookie()).toBeNull();
  });
});
