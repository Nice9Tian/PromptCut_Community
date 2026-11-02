export interface ContextMenuItem {
  label: string;
  action: () => void;
  disabled?: boolean;
  /** Hover hint (a grayed-out item explains why it can't be clicked; a grayed-out item that has it still receives hover, and clicking it still does nothing) */
  title?: string;
  /** Small text in the right column: things like a parameter summary or a count */
  hint?: string;
  /** This item has a submenu: hovering expands it on the right. An item that has it does not run action itself */
  sub?: ContextMenuItem[];
  /** Dangerous item (delete, remove) drawn in the warning color */
  danger?: boolean;
  /** Dimmed + name struck through: a disabled overlay card, still there but not in effect */
  dim?: boolean;
}

/**
 * Menu header: which segment / which card is being acted on.
 *
 * Written only when it **is the whole menu itself**: for the menu popped up from one card in a strip, the
 * header is the only evidence of "who is being acted on", so it is filled in with the track color of that
 * segment as background, and a wrong pick is visible at a glance.
 * Submenu panels reached level by level do not write a header: the parent level is still on screen, and
 * writing it again just takes up a row.
 */
export interface ContextMenuHead {
  title: string;
  /** The right half when filled in: which segment this card is attached to */
  of?: string;
  /** The track color is taken by it (the value of clipTrackKind) */
  trackKind?: string;
}
