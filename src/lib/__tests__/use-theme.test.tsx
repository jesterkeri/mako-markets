// Theme: Light / Dark / Auto (redesign, Settings > Appearance). The boot script sets <html data-theme> before
// first paint; the provider takes over from there, and Auto follows the device live.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import * as React from 'react';

import { THEME_BOOT_SCRIPT, ThemeProvider, useTheme, type ThemePreference } from '../use-theme';

/// A controllable prefers-color-scheme: flip `dark` and fire `change`.
function mockDevice(initialDark: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: initialDark,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  vi.spyOn(window, 'matchMedia').mockImplementation(() => query as unknown as MediaQueryList);
  return {
    set(dark: boolean) {
      query.matches = dark;
      for (const fn of [...listeners]) fn();
    },
    listenerCount: () => listeners.size,
  };
}

const boot = () => new Function(THEME_BOOT_SCRIPT)();
const html = () => document.documentElement.dataset;

let seen: { theme: string; preference: ThemePreference; setTheme: (t: 'light' | 'dark') => void; setPreference: (p: ThemePreference) => void };
function Probe() {
  seen = useTheme();
  return null;
}

beforeEach(() => {
  localStorage.clear();
  delete html().theme;
  delete html().themePref;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('THEME_BOOT_SCRIPT', () => {
  it('uses a stored light or dark choice, whatever the device prefers', () => {
    mockDevice(true);
    localStorage.setItem('mako-theme', 'light');
    boot();
    expect([html().theme, html().themePref]).toEqual(['light', 'light']);
  });

  it('follows the device when the choice is auto', () => {
    mockDevice(false);
    localStorage.setItem('mako-theme', 'auto');
    boot();
    expect([html().theme, html().themePref]).toEqual(['light', 'auto']);
  });

  it('treats nothing stored as auto', () => {
    mockDevice(true);
    boot();
    expect([html().theme, html().themePref]).toEqual(['dark', 'auto']);
  });

  it('falls back to dark when storage throws', () => {
    mockDevice(false);
    // Blocked storage (e.g. some private modes) throws on access to localStorage itself.
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('blocked');
    });
    boot();
    expect([html().theme, html().themePref]).toEqual(['dark', 'auto']);
  });
});

describe('ThemeProvider', () => {
  it('starts from what the boot script set', () => {
    mockDevice(true);
    localStorage.setItem('mako-theme', 'light');
    boot();
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect([seen.theme, seen.preference]).toEqual(['light', 'light']);
  });

  it('on auto, follows the device when it switches', () => {
    const device = mockDevice(true);
    boot();
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect([seen.theme, seen.preference]).toEqual(['dark', 'auto']);
    act(() => device.set(false));
    expect(seen.theme).toBe('light');
    expect(html().theme).toBe('light');
  });

  it('an explicit choice stops following the device, and is stored', () => {
    const device = mockDevice(true);
    boot();
    render(<ThemeProvider><Probe /></ThemeProvider>);
    act(() => seen.setTheme('light'));
    expect([seen.theme, seen.preference, localStorage.getItem('mako-theme')]).toEqual(['light', 'light', 'light']);
    expect(device.listenerCount()).toBe(0);
    act(() => device.set(true));
    expect(html().theme).toBe('light');
  });

  it('choosing auto again resolves from the device now and stores auto', () => {
    mockDevice(false);
    localStorage.setItem('mako-theme', 'dark');
    boot();
    render(<ThemeProvider><Probe /></ThemeProvider>);
    act(() => seen.setPreference('auto'));
    expect([seen.theme, seen.preference, html().theme, html().themePref]).toEqual(['light', 'auto', 'light', 'auto']);
    expect(localStorage.getItem('mako-theme')).toBe('auto');
  });
});
