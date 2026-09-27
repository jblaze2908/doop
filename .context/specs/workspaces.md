# Workspaces

Status: shipped 2026-09-11; Stripe billing removed 2026-09-27. Code: `server/workspaces.ts`,
`src/pages/Workspace.tsx`, `src/components/WorkspaceModals.tsx`.

## Problem

Canvas access was per canvas (owner + invited members + optional edit link). An org with many
canvases had to invite the same people to each one.

## Shape

- A **workspace** is a named container of canvases with members and roles (`owner`, `admin`,
  `member`). Every member opens every canvas in it. `canvases.workspace_id` is nullable; null is
  the owner's personal space, which behaves exactly as before.
- Access: `canAccessCanvas` gains one clause — workspace membership. `hasDurableCanvasAccess`
  likewise. `canManageCanvas` (delete, move out) = canvas owner or workspace owner/admin.
- Membership lives in memory next to the store (`server/workspaces.ts`), hydrated at boot before
  the first request, written through to `workspace_members`. The owner is a row too.
- Invites for emails without an account are rows in `workspace_invites`; they are accepted in the
  auth hooks (after signup when no mailer exists, after email verification when one does).
- Removing a member revokes access to workspace canvases they do not own; canvases they own stay
  filed in the workspace and stay theirs. Deleting a workspace detaches every canvas back to its
  owner.

## Leftover columns

`workspaces.status`, `plan`, `interval`, `seats`, `stripe_*`, `current_period_end`,
`cancel_at_period_end` and `billing_event_at` are the old Stripe mirror. Nothing reads or writes
them; they stay until a migration drops them.

## Tests

`tests/workspaces.test.ts`: membership, access over REST and WS, moves, roles, invites accepted at
signup, restart, delete.

## Deliberately not done

- No ownership transfer; the owner cannot leave — delete instead.
- Per-canvas invites and link sharing are untouched and still work inside a workspace.
