import { useEffect, useId, useRef, useState } from 'react';
import { BookOpen, ChevronDown, ClipboardList, DoorOpen, Feather, MessageSquare } from 'lucide-react';

export type NavigationDestination = 'chat' | 'diary' | 'study' | 'workbench' | 'entrance';

const DESTINATIONS = [
  { id: 'diary', label: '日记馆', note: '翻看家人的手记', icon: BookOpen },
  { id: 'study', label: '书房', note: '接力小说手稿匣', icon: Feather },
  { id: 'chat', label: '聊天', note: '回到当前会话', icon: MessageSquare },
  { id: 'workbench', label: '工作桌', note: '查看工单与进度', icon: ClipboardList },
  { id: 'entrance', label: '入口画', note: '回到小屋门口', icon: DoorOpen },
] as const;

export function NavigationMenu({ disabled, onNavigate }: {
  disabled: boolean;
  onNavigate: (destination: NavigationDestination) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    wrapper.current?.querySelector<HTMLButtonElement>('.topbar-nav__item')?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !wrapper.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <div className="topbar-nav desktop-only" ref={wrapper} onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
    }}>
      <button type="button" className="topbar__space topbar-nav__trigger" ref={trigger}
        disabled={disabled} aria-expanded={open} aria-controls={panelId}
        onClick={() => setOpen(value => !value)}>
        导航入口 <ChevronDown size={13} aria-hidden />
      </button>
      {open && (
        <nav className="topbar-nav__panel" id={panelId} aria-label="小屋导航">
          {DESTINATIONS.map(({ id, label, note, icon: Icon }) => (
            <button type="button" className="topbar-nav__item" key={id} onClick={() => {
              setOpen(false);
              onNavigate(id);
            }}>
              <Icon size={18} aria-hidden />
              <span><strong>{label}</strong><small>{note}</small></span>
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}
