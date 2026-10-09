/**
 * The icon vocabulary, in one place.
 *
 * Re-exported through here rather than imported from @phosphor-icons/react at
 * each call site, for two reasons. Size and weight are decided once (twenty
 * controls each picking their own is exactly how an interface ends up with
 * five icon weights) and the set the app uses is legible in one file rather
 * than spread across a dozen imports.
 *
 * Defaults are tuned to sit with Instrument Sans: 16px at the regular weight
 * matches the weight of text at --text-base, so an icon beside a label reads
 * as the same colour of ink. Bold looks heavy next to this face and light
 * disappears at 16px.
 *
 * Every icon inherits `currentColor`, which is what keeps them correct in
 * both themes with no per-theme values at all.
 */
import {
  ArrowCounterClockwise,
  ArrowLeft,
  ArrowUp,
  ArrowUUpLeft,
  ArrowUUpRight,
  BracketsCurly,
  CaretDown,
  CaretLeft,
  CaretRight,
  CaretUp,
  ChatCenteredText,
  Check,
  CloudArrowUp,
  Code,
  DotsThree,
  Eye,
  EyeSlash,
  Feather,
  FilePdf,
  FileText,
  ListBullets,
  ListChecks,
  ListNumbers,
  Monitor,
  Moon,
  Paperclip,
  PencilSimple,
  Plus,
  Quotes,
  SignOut,
  Sun,
  TextB,
  TextHOne,
  TextHThree,
  TextHTwo,
  TextItalic,
  TextStrikethrough,
  Trash,
  Tray,
  UploadSimple,
  UserPlus,
  Warning,
  X,
  type Icon as PhosphorIcon,
  type IconProps as PhosphorProps,
} from "@phosphor-icons/react";

/** Props every icon in the app takes. `size` is the exception rather than the
 * rule: the toolbar uses 18, everything else should leave it alone. */
export interface IconProps extends Omit<PhosphorProps, "ref"> {
  size?: number;
}

const DEFAULTS: PhosphorProps = {
  size: 16,
  weight: "regular",
  // Decorative by default: an icon-only control carries its name on the
  // button's aria-label, and an icon beside a visible label would otherwise
  // be announced twice.
  "aria-hidden": true,
  focusable: false,
};

function wrap(Component: PhosphorIcon) {
  return function Wrapped(props: IconProps) {
    return <Component {...DEFAULTS} {...props} />;
  };
}

/* --- text formatting --- */
export const IconBold = wrap(TextB);
export const IconItalic = wrap(TextItalic);
export const IconStrike = wrap(TextStrikethrough);
export const IconCode = wrap(Code);
export const IconH1 = wrap(TextHOne);
export const IconH2 = wrap(TextHTwo);
export const IconH3 = wrap(TextHThree);
export const IconBulletList = wrap(ListBullets);
export const IconOrderedList = wrap(ListNumbers);
export const IconQuote = wrap(Quotes);
export const IconCodeBlock = wrap(BracketsCurly);
export const IconUndo = wrap(ArrowUUpLeft);
export const IconRedo = wrap(ArrowUUpRight);

/* --- the two annotators --- */
/* A quill, not sparkles: the agent writes in the margin, it does not do magic. */
export const IconAgent = wrap(Feather);
export const IconComment = wrap(ChatCenteredText);
export const IconQuiz = wrap(ListChecks);
/* Send, in the chat bar. Up rather than a paper plane: it is the one action
   the bar has, and an arrow reads as "go" without a label. */
export const IconSend = wrap(ArrowUp);
export const IconAttach = wrap(Paperclip);
export const IconMoveUp = wrap(CaretUp);
export const IconMoveDown = wrap(CaretDown);

/* --- documents and sources --- */
export const IconDocument = wrap(FileText);
/* A PDF is the one source kind worth telling apart at a glance: it is the
   only one nobody can read in the editor. */
export const IconFilePdf = wrap(FilePdf);
export const IconUpload = wrap(UploadSimple);
export const IconUploadCloud = wrap(CloudArrowUp);
export const IconEmpty = wrap(Tray);
export const IconNew = wrap(Plus);
export const IconRename = wrap(PencilSimple);
export const IconDelete = wrap(Trash);
export const IconMore = wrap(DotsThree);

/* --- navigation and chrome --- */
export const IconBack = wrap(ArrowLeft);
export const IconInvite = wrap(UserPlus);
export const IconSignOut = wrap(SignOut);
export const IconPrev = wrap(CaretLeft);
export const IconNext = wrap(CaretRight);
export const IconRestart = wrap(ArrowCounterClockwise);
export const IconAccept = wrap(Check);
export const IconDismiss = wrap(X);
export const IconWarn = wrap(Warning);
export const IconShow = wrap(Eye);
export const IconHide = wrap(EyeSlash);

/* --- theme --- */
export const IconThemeLight = wrap(Sun);
export const IconThemeDark = wrap(Moon);
export const IconThemeSystem = wrap(Monitor);
