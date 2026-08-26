import { Outlet } from 'react-router';

/**
 * Chrome-less page container for routes that sit outside a surface shell —
 * the scaffold landing page, sign-in, and 404. Used as a pathless layout route
 * so those pages get consistent gutters without each one re-declaring them.
 */
export function PlainLayout() {
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-10">
      <Outlet />
    </div>
  );
}
