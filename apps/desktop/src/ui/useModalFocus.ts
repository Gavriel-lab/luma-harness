import { useEffect, useRef } from 'react';

/** 抽屉和确认框打开时锁定 Tab 范围，关闭后回到原入口。 */
export function useModalFocus(selector: string, active: boolean) {
  const previousRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!active) return;
    const modal = document.querySelector<HTMLElement>(selector);
    if (!modal) return;
    previousRef.current = document.activeElement as HTMLElement | null;
    const focusable = () => Array.from(modal.querySelectorAll<HTMLElement>('button, input, textarea, select, [tabindex="0"]'))
      .filter((element) => !element.hasAttribute('disabled') && element.getClientRects().length > 0);
    focusable()[0]?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const elements = focusable();
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (!first || !last) return;
      if (!modal.contains(document.activeElement) || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener('keydown', trap);
    return () => {
      document.removeEventListener('keydown', trap);
      if (previousRef.current?.isConnected) previousRef.current.focus();
    };
  }, [selector, active]);
}
