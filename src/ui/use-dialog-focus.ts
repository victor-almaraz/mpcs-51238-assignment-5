'use client';

// Modal dialog focus (doc/ui.md, Style): Tab and Shift-Tab cycle inside the dialog, and focus
// returns to the element that had it when the dialog closes.

import { useEffect, type KeyboardEvent, type RefObject } from 'react';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Restores focus on unmount; returns the keydown handler that keeps Tab inside `ref`. */
export function useDialogFocus(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    return () => { if (before && before.isConnected) before.focus(); };
  }, []);
  return (e: KeyboardEvent) => {
    if (e.key !== 'Tab' || !ref.current) return;
    const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (items.length === 0) { e.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const at = document.activeElement;
    if (e.shiftKey && (at === first || !ref.current.contains(at))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (at === last || !ref.current.contains(at))) { e.preventDefault(); first.focus(); }
  };
}
