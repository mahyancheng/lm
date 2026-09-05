/**
 * The node canvas: geometry, model, renderer.
 *
 * One barrel so a screen imports the canvas rather than four files, and so the
 * boundary between "pure and testable" (geometry, model) and "renders"
 * (`Canvas`) stays visible from outside.
 */

export * from './geometry';
export * from './model';
export { Canvas, clip, initials } from './Canvas';
export type { CanvasProps } from './Canvas';
