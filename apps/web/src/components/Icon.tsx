/**
 * The icon vocabulary, in one place.
 *
 * Re-exported through here rather than imported from lucide-react at each
 * call site, for two reasons. Size and stroke are decided once — twenty
 * controls each picking their own is exactly how an interface ends up with
 * five icon weights — and the set the app uses is legible in one file rather
 * than spread across a dozen imports.
 *
 * Defaults are tuned to sit with Instrument Sans rather than to lucide's own
 * defaults: 16px at 1.75 stroke matches the weight of text at --text-base, so
 * an icon beside a label reads as the same colour of ink. Lucide ships 24px
 * at 2, which looks heavy and slightly too large next to this face.
 *
 * Every icon inherits `currentColor`, which is what keeps them correct in
 * both themes with no per-theme values at all.
 */
import {
  ArrowLeft,
  Bold,
  Braces,
  Check,
  ChevronLeft,
  ChevronRight,
  CloudUpload,
  Layers,
  Code,
  FileText,
  FileType2,
  Inbox,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  List,
  ListOrdered,
  LogOut,
  MessageSquare,
  Monitor,
  MoreHorizontal,
  Moon,
  Pencil,
  Plus,
  Quote,
  Redo2,
  RotateCcw,
  Sparkles,
  Strikethrough,
  Sun,
  Trash2,
  Undo2,
  Upload,
  UserPlus,
  X,
  type LucideProps,
} from "lucide-react";

/** Props every icon in the app takes. `size` is the exception rather than the
 * rule — the toolbar uses 18, everything else should leave it alone. */
export interface IconProps extends Omit<LucideProps, "ref"> {
  size?: number;
}

const DEFAULTS: LucideProps = {
  size: 16,
  strokeWidth: 1.75,
  // Decorative by default: an icon-only control carries its name on the
  // button's aria-label, and an icon beside a visible label would otherwise
  // be announced twice.
  "aria-hidden": true,
  focusable: false,
};

function wrap(Component: React.ComponentType<LucideProps>) {
  return function Wrapped(props: IconProps) {
    return <Component {...DEFAULTS} {...props} />;
  };
}

/* --- text formatting --- */
export const IconBold = wrap(Bold);
export const IconItalic = wrap(Italic);
export const IconStrike = wrap(Strikethrough);
export const IconCode = wrap(Code);
export const IconH1 = wrap(Heading1);
export const IconH2 = wrap(Heading2);
export const IconH3 = wrap(Heading3);
export const IconBulletList = wrap(List);
export const IconOrderedList = wrap(ListOrdered);
export const IconQuote = wrap(Quote);
export const IconCodeBlock = wrap(Braces);
export const IconUndo = wrap(Undo2);
export const IconRedo = wrap(Redo2);

/* --- the two annotators --- */
export const IconAgent = wrap(Sparkles);
export const IconComment = wrap(MessageSquare);
export const IconCards = wrap(Layers);

/* --- documents and sources --- */
export const IconDocument = wrap(FileText);
/* A PDF is the one source kind worth telling apart at a glance: it is the
   only one nobody can read in the editor. */
export const IconFilePdf = wrap(FileType2);
export const IconUpload = wrap(Upload);
export const IconUploadCloud = wrap(CloudUpload);
export const IconEmpty = wrap(Inbox);
export const IconNew = wrap(Plus);
export const IconRename = wrap(Pencil);
export const IconDelete = wrap(Trash2);
export const IconMore = wrap(MoreHorizontal);

/* --- navigation and chrome --- */
export const IconBack = wrap(ArrowLeft);
export const IconInvite = wrap(UserPlus);
export const IconSignOut = wrap(LogOut);
export const IconPrev = wrap(ChevronLeft);
export const IconNext = wrap(ChevronRight);
export const IconRestart = wrap(RotateCcw);
export const IconAccept = wrap(Check);
export const IconDismiss = wrap(X);

/* --- theme --- */
export const IconThemeLight = wrap(Sun);
export const IconThemeDark = wrap(Moon);
export const IconThemeSystem = wrap(Monitor);
