/**
 * next/link shim for the single-file artifact build: renders a plain anchor
 * against the hash router in the next-navigation shim.
 */
import { forwardRef, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { navigate } from './next-navigation';

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  readonly href: string;
  readonly children?: ReactNode;
  readonly prefetch?: boolean;
  readonly replace?: boolean;
  readonly scroll?: boolean;
};

const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  { href, children, prefetch: _prefetch, replace: _replace, scroll: _scroll, onClick, ...rest },
  ref,
) {
  return (
    <a
      {...rest}
      ref={ref}
      href={`#${href}`}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        event.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
});

export default Link;
