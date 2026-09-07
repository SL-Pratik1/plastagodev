# Two origins, one product

Matt asked for the driver surface to have its own sign-in and its own address
(29:04, 29:19):

| Origin | App | Who signs in |
| --- | --- | --- |
| `portal.plastago.com.au` | `apps/web` | Office, allocators, customers, site supervisors |
| `drivers.plastago.com.au` | `apps/driver` | Drivers |

## Why it is two origins and not one route

A browser installs the PWA for **the page it is on**. Served from one origin,
a driver adding PlastaGo to their home screen gets an icon that opens an office
sign-in screen — and there is no way to install "just the driver part" of an
origin. The split is what makes the driver app installable as itself.

It also means a driver on a building site never sees a screen that can take them
somewhere they have no business being.

## Configuration

`apps/web` needs one variable:

```
VITE_DRIVER_APP_URL=https://drivers.plastago.com.au
```

Leave it **empty in development**. Both surfaces are then served by `apps/web`
at `/driver`, and nothing tries to leave for an origin that is not running.

With it set:

- A driver-only user signing in at the office origin is sent straight to the
  driver origin (`root-redirect.tsx`).
- The role switcher opens the driver app as a page load rather than a route
  change (`admin-shell.tsx`), because it is a different origin.

## Ports in development

| App | Port |
| --- | --- |
| `apps/web` | 5173 |
| `apps/driver` | 5174 |

## What still needs deciding

Sessions do not currently cross the two origins — a user who switches role signs
in again on the other side. Options, cheapest first:

1. **Accept it.** Only one person holds two roles today (Matt, 27:36), and they
   switch rarely — when someone calls in sick.
2. **Cookie on the parent domain.** Issue the session cookie for
   `.plastago.com.au` so both subdomains see it. Needs the API to set the wider
   `Domain` attribute, and both origins behind the same API.
3. **A hand-off token.** More work, and not worth it for one user.

Option 1 until Matt says otherwise.
