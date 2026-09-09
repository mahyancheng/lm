/**
 * The footprint the Chief of Staff dock occupies on a phone.
 *
 * The dock is `fixed left-3` above the tab bar on every tab (`ChiefOfStaffDock`),
 * so anything else pinned to the bottom of the viewport shares that corner with
 * it. Two fixed elements never scroll clear of one another: whatever is under
 * the dock is under it permanently.
 *
 * A bottom-pinned control therefore reserves this gutter on its left rather
 * than spanning the full width. The reserve is wider than the pill (82px with
 * an empty thread, ~95px carrying a two-digit count) so the dock cannot grow
 * into the control as the conversation gets longer.
 */

/** Left gutter a bottom-pinned control leaves for the dock. Phone only. */
export const DOCK_RESERVE_CLASS = 'h-11 w-24 shrink-0 sm:hidden';

/** The reserved width in pixels, for a test that measures rather than reads. */
export const DOCK_RESERVE_PX = 96;
