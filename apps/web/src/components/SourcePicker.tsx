/**
 * The Generate button for a guide or quiz, with the choice of sources
 * attached: clicking opens a popover of the space's files, all ready ones
 * ticked, and Generate inside it makes the request.
 *
 * Portalled and positioned like RowMenu, for the same reasons recorded
 * there. The list is fetched when the popover opens rather than shared with
 * SourcesPanel: it is read once per click, and the panel's poll stops once
 * its files settle.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { apiFetch } from "../lib/api";
import { readySources, selectionToRequest } from "../lib/sourceSelection";
import type { Source } from "../lib/types";
import Orb from "./Orb";

const WIDTH = 280;

export default function SourcePicker({
  spaceId,
  label,
  disabled,
  onGenerate,
}: {
  spaceId: string;
  label: string;
  disabled: boolean;
  onGenerate: (sourceIds?: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const [sources, setSources] = useState<Source[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const left = Math.min(r.left, window.innerWidth - WIDTH - 8);
    setAt({ top: r.bottom + 6, left: Math.max(8, left) });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setSources(null);
    setError(null);
    apiFetch<Source[]>(`/study-spaces/${spaceId}/sources`)
      .then((rows) => {
        if (!active) return;
        setSources(rows);
        setChecked(new Set(readySources(rows).map((s) => s.id)));
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : "Could not load sources");
      });
    return () => {
      active = false;
    };
  }, [open, spaceId]);

  // Focus moves into the popover once it has content.
  useEffect(() => {
    if (open && sources) {
      panelRef.current?.querySelector<HTMLElement>("input:not(:disabled), button")?.focus();
    }
  }, [open, sources]);

  // Escape returns focus to the trigger; a click outside, a page scroll or a
  // resize just closes it, as RowMenu does.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onScroll = (e: Event) => {
      // The list scrolls inside the popover; that must not close it.
      if (panelRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  const ready = sources ? readySources(sources) : [];
  const waiting = sources
    ? sources.filter((s) => s.status === "pending" || s.status === "processing")
    : [];
  const request = selectionToRequest(ready, checked);
  const canGenerate = ready.length > 0 && (request === undefined || request.length > 0);

  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function generate() {
    setOpen(false);
    triggerRef.current?.focus();
    onGenerate(request);
  }

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {label}
      </button>
      {open &&
        at &&
        createPortal(
          <div
            ref={panelRef}
            className="source-picker"
            role="dialog"
            aria-label={`Sources for the ${label.toLowerCase()}`}
            style={{ top: at.top, left: at.left, width: WIDTH }}
          >
            <p className="source-picker-title">Build from</p>
            {error && <p className="error">{error}</p>}
            {!sources && !error && (
              <p className="source-picker-loading">
                <Orb activity="syncing" /> Loading sources
              </p>
            )}
            {sources && ready.length === 0 && waiting.length === 0 && (
              <p className="source-picker-empty">No sources yet. Upload one first.</p>
            )}
            {sources && (ready.length > 0 || waiting.length > 0) && (
              <ul className="source-picker-list">
                {ready.map((s) => (
                  <li key={s.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={checked.has(s.id)}
                        onChange={() => toggle(s.id)}
                      />
                      <span className="source-picker-name" title={s.filename}>
                        {s.filename}
                      </span>
                    </label>
                  </li>
                ))}
                {waiting.map((s) => (
                  <li key={s.id} className="is-waiting">
                    <label>
                      <input type="checkbox" disabled checked={false} readOnly />
                      <span className="source-picker-name" title={s.filename}>
                        {s.filename}
                      </span>
                      <span className="source-picker-note">Processing</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {ready.length > 1 && (
              <div className="source-picker-quick">
                <button
                  type="button"
                  className="link-button"
                  onClick={() => setChecked(new Set(ready.map((s) => s.id)))}
                >
                  All
                </button>
                <button type="button" className="link-button" onClick={() => setChecked(new Set())}>
                  None
                </button>
              </div>
            )}
            <button
              type="button"
              className="source-picker-go"
              disabled={!canGenerate}
              onClick={generate}
            >
              Generate
            </button>
          </div>,
          document.body
        )}
    </>
  );
}
