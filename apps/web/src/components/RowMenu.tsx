/**
 * The "…" menu that hangs off a list row.
 *
 * Portalled to document.body, which is not optional here: `.left-rail` has
 * `overflow-y: auto`, so a menu positioned inside it is clipped at the rail's
 * edge the moment it is taller than the space below the row. Portalling also
 * keeps it out of any stacking context the rail introduces later.
 *
 * Positioned from the trigger's rect and `position: fixed`, so it needs no
 * scroll maths — and it closes on scroll rather than trying to follow, since
 * a menu that chases its row while the list moves underneath reads as broken.
 *
 * Roving focus rather than a full menubar implementation: this is a handful
 * of actions on a row, and the accessible contract that matters is that it
 * opens, moves and closes from the keyboard and returns focus where it came
 * from.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { IconMore } from "./Icon";

export interface RowMenuItem {
  label: string;
  /** Rendered before the label. */
  icon?: React.ReactNode;
  onSelect: () => void;
  /** Reds the item and moves it below a divider. */
  destructive?: boolean;
  disabled?: boolean;
}

export default function RowMenu({
  items,
  label,
}: {
  items: RowMenuItem[];
  /** Names the trigger for screen readers, e.g. "Actions for Week 6". */
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const [active, setActive] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const usable = items.filter((i) => !i.disabled);

  // Measured in a layout effect so the menu is placed before it paints —
  // measuring in a normal effect shows it at 0,0 for a frame first.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const width = 168;
    // Flip to stay on screen rather than letting the menu run off the right
    // edge; the rail is near the window edge on a narrow viewport.
    const left = Math.min(r.right - width, window.innerWidth - width - 8);
    setAt({ top: r.bottom + 4, left: Math.max(8, left) });
    setActive(0);
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      // A click on the trigger is the toggle's job, not the dismiss's —
      // handling both would open and immediately close it.
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => (i + 1) % usable.length);
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => (i - 1 + usable.length) % usable.length);
      }
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const item = usable[active];
        if (item) {
          setOpen(false);
          triggerRef.current?.focus();
          item.onSelect();
        }
      }
    };
    // Capture, so a scroll inside the rail closes it before the menu has a
    // chance to look detached from its row.
    const onScroll = () => setOpen(false);

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, usable, active]);

  return (
    <>
      <button
        ref={triggerRef}
        className={`icon-button is-small row-menu-trigger${open ? " is-open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={(e) => {
          // The row underneath is itself a button; opening the menu must not
          // also select the document.
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        <IconMore size={14} />
      </button>

      {open &&
        at &&
        createPortal(
          <div
            ref={menuRef}
            className="row-menu"
            role="menu"
            style={{ top: at.top, left: at.left }}
          >
            {items.map((item, i) => {
              const index = usable.indexOf(item);
              return (
                <button
                  key={item.label}
                  role="menuitem"
                  disabled={item.disabled}
                  className={[
                    "row-menu-item",
                    item.destructive ? "is-destructive" : "",
                    index === active && !item.disabled ? "is-active" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onMouseEnter={() => index >= 0 && setActive(index)}
                  onClick={() => {
                    setOpen(false);
                    item.onSelect();
                  }}
                >
                  {item.icon}
                  {item.label}
                </button>
              );
            })}
          </div>,
          document.body
        )}
    </>
  );
}
