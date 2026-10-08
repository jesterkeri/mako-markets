// @vitest-environment jsdom
// The page shown when any page throws (Joshua, 2026-10-08): the 404 card's design inside the site header, a retry that
// re-renders the page, funds-safe copy, and the crash reported to Sentry.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('@sentry/nextjs', () => sentry);
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

import ErrorPage from '@/app/error';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('error page', () => {
  it('says what happened and that funds are safe, retries, and reports the crash', () => {
    const retry = vi.fn();
    const err = new Error('boom');
    render(<ErrorPage error={err} unstable_retry={retry} />);
    expect(screen.getAllByRole('heading', { name: 'Something broke on this page.' }).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/safe on-chain, and nothing was lost/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole('button', { name: 'Try again' })[0]);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('link', { name: 'Browse Pools' })[0].getAttribute('href')).toBe('/pools');
    expect(sentry.captureException).toHaveBeenCalledWith(err);
    // A client error has no reference; its message is never shown.
    expect(document.body.textContent).not.toMatch(/boom|Reference/);
  });

  it('shows a server error\'s reference (it matches the server log), never its message', () => {
    const err = Object.assign(new Error('db connection string here'), { digest: '4231987' });
    render(<ErrorPage error={err} unstable_retry={() => {}} />);
    expect(screen.getAllByText('Reference 4231987').length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/connection string/);
  });

  it('copy rules: no em dash, no we/our/us', () => {
    render(<ErrorPage error={new Error('x')} unstable_retry={() => {}} />);
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/—/);
    expect(text).not.toMatch(/\b(we|our|us)\b/i);
  });
});
