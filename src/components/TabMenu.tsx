import { useEffect, useRef } from "react";

export type TabMenuItem = { label: string; onSelect: () => void; disabled?: boolean } | "separator";

/** Right-click menu for any tab strip. Disabled items stay visible so the menu never changes shape. */
export function TabMenu({ x, y, items, onClose }: { x: number; y: number; items: TabMenuItem[]; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const away = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) onClose(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  return <div ref={box} role="menu" className="tab-menu"
    style={{ left: Math.min(x, window.innerWidth - 230), top: Math.min(y, window.innerHeight - 40 - items.length * 30) }}>
    {items.map((item, index) => item === "separator"
      ? <div key={index} className="tab-menu__sep" role="separator" />
      : <button key={item.label} type="button" role="menuitem" disabled={item.disabled}
          onClick={() => { onClose(); item.onSelect(); }}>{item.label}</button>)}
  </div>;
}
