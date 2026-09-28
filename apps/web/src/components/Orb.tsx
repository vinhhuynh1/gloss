/**
 * The one loading indicator, for everything the app waits on.
 *
 * A spinner says "wait" and nothing else. Each activity here gets its own
 * motion from thinking-orbs, so which wait this is can be told apart before
 * the label beside it is read: a queue breathes, a file being read is
 * scanned, an upload wires itself up.
 *
 * Callers name what is happening, not how it should look, the same way
 * Icon.tsx names icons by job. Swapping a state is a one-line change here
 * rather than a hunt through every screen.
 *
 * Colour follows the same rule as the rest of the palette: plum is the agent
 * and nothing else. Work the agent is doing is tinted plum; waits that belong
 * to you or to the connection stay in the library's grey ink.
 *
 * The library handles reduced motion (a still frame), pauses offscreen and in
 * hidden tabs, and follows data-theme / prefers-color-scheme on its own.
 */
import { useSyncExternalStore } from "react";
import { ThinkingOrb, type OrbSize, type OrbState } from "thinking-orbs";

export type Activity =
  // The agent
  | "queued"
  | "reading"
  | "thinking"
  | "writing"
  | "checking"
  | "building"
  // You, or the connection
  | "uploading"
  | "syncing"
  | "listening"
  | "busy";

const STATE: Record<Activity, OrbState> = {
  queued: "breathing",
  reading: "searching",
  thinking: "working",
  writing: "composing",
  checking: "solving",
  building: "shaping",
  uploading: "connecting",
  syncing: "connecting",
  listening: "listening",
  busy: "weaving",
};

const AGENT = new Set<Activity>([
  "queued",
  "reading",
  "thinking",
  "writing",
  "checking",
  "building",
]);

/* --- the accent, read back from CSS ---
   The library takes a colour string, not a custom property, and --accent
   changes with the theme. One shared subscription for every orb on screen:
   the root's data-theme attribute and the OS scheme are the only two things
   that can change it. */
function readAccent(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
}

function subscribeAccent(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  const scheme = window.matchMedia("(prefers-color-scheme: dark)");
  scheme.addEventListener("change", onChange);
  return () => {
    observer.disconnect();
    scheme.removeEventListener("change", onChange);
  };
}

function useAccent(): string {
  return useSyncExternalStore(subscribeAccent, readAccent);
}

export default function Orb({
  activity,
  size = 20,
  label,
  className,
}: {
  activity: Activity;
  /** 20 sits in a line of text, 64 stands on its own. */
  size?: OrbSize;
  /** Only when nothing beside the orb says what it is waiting on. Otherwise
   * it is decorative, and announcing it would repeat the visible label. */
  label?: string;
  className?: string;
}) {
  const accent = useAccent();
  return (
    <ThinkingOrb
      state={STATE[activity]}
      size={size}
      color={AGENT.has(activity) && accent ? accent : undefined}
      className={className ? `orb ${className}` : "orb"}
      {...(label ? { "aria-label": label } : { "aria-hidden": true })}
    />
  );
}
