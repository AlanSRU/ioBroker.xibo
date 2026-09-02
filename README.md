# ioBroker.xibo

Play a layout on a Xibo display group, and put it back to its schedule.

Built for driving LED walls from a StreamDeck: a button writes a layout id to a
display group, the display changes immediately, and a revert button hands it back
to the schedule.

## What it does

- **Inventory** — display groups, displays and layouts, refreshed on a timer
- **Control** — change layout, overlay layout, revert to schedule, collect now
- **Status** — how many displays in a group are online, and what they report playing

Layouts are the unit of control. Media in the CMS library cannot be scheduled on
its own; a layout is what a display can be told to show.

## Configuration

| Field | Notes |
|---|---|
| CMS URL | The CMS root, **without** `/api` |
| Client ID / Secret | Administration → Applications in the CMS. The application must allow the `client_credentials` grant. |
| Layout folder | Only offer layouts in this folder **and below**. Leave empty for the whole CMS. |
| Default duration | Seconds a layout stays before the display returns to its schedule. `0` means until reverted. |

The adapter authenticates as an application, not as a person, so CMS folder
permissions do not constrain it — those govern people using the Xibo UI.

## State tree (`xibo.0.*`)

### info / inventory

- `info.connection` — CMS reachable and credentials valid
- `info.lastError`, `info.lastSync`, `info.cmsUrl`
- `inventory.{displayGroupsJson, displaysJson, layoutsJson}` — full lists as JSON
- `inventory.{displayGroupCount, displayCount, layoutCount}`

### Per display group

`xibo.0.displayGroups.<sanitised name>`, with `native.displayGroupId` carrying
the CMS id. Display-specific groups — Xibo's internal one-per-display groups —
are omitted, because they are never what an operator picks.

| State | Notes |
|---|---|
| `id`, `name` | CMS identity |
| `displayCount`, `displaysOnline` | How many displays, and how many are logged in |
| `currentLayout` | What the first display in the group reports playing |
| `playLayoutId` | **Writable.** Write a layout id to play it on this group. |
| `revert` | **Writable.** Return this group to its schedule. |

`playLayoutId` is the one a StreamDeck button writes.

### Commands

Callers write JSON to `commands.<name>` un-acked; the adapter executes it and
clears the state, so an identical follow-up request still triggers.

| Command | Payload |
|---|---|
| `refresh` | boolean button |
| `changeLayout` | `{displayGroupId, layoutId, duration?}` |
| `overlayLayout` | `{displayGroupId, layoutId, duration?}` — refused in `schedule` mode |
| `revertToSchedule` | `{displayGroupId}` |
| `collectNow` | `{displayGroupId}` |

`commands.lastResult` records `{ok, command, payload, error?, ts}`.

## How a layout reaches the player

**Setting: "How a layout reaches the player"** — `schedule` (default) or `action`.

The CMS's own `changeLayout` action is delivered over XMR and applied instantly
— by a player that implements that message. **Arexibo and gaxibo do not.** The
action arrives, is logged as an unsupported XMR action and dropped, while the
CMS reports success. Nothing moves and nothing fails, which is the worst way for
this to break.

So `schedule` mode does not use the action. It:

1. resolves the layout's **campaign** (the schedule names a campaign, never a
   layout);
2. deletes the event it created last time on that display group;
3. creates one "always" layout event at `schedulePriority`, which outranks the
   group's ordinary schedule;
4. sends `collectNow` — the one XMR action these players *do* implement, which
   is what makes the change land in seconds rather than at the next poll.

A `duration` becomes a custom day part bounded by `toDt`, which the player
enforces locally, so the sign comes down on time without hearing from the CMS
again.

`revertToSchedule` in this mode **deletes that event** rather than posting the
XMR revert action, because the event is the thing overriding the schedule.

Two constraints follow:

- **`schedulePriority` must be a priority nothing else uses.** The CMS gives a
  schedule event no name or tag to stamp, so the priority is the only marker
  available for "the adapter owns this one and may replace it".
- **`overlayLayout` is refused in `schedule` mode**, rather than attempted.
  These players render no overlay by either route, so posting the action would
  report success and show nothing.

Pick `action` only for the official Xibo player, where it is instant.

### `currentLayout` lags

`displayGroups.<group>.currentLayout` is what the *player* last reported, and
gaxibo reports it from a field its GUI thread updates asynchronously — so the
collect that applies a new layout usually still reports the previous one.
Measured at anything from 4 seconds to 5 minutes behind. It is a status field,
not a confirmation that a command worked, and binding a deck's active highlight
to it will light the wrong key.

## Notes

**A layout change replaces the schedule and stays** until something else changes
it or the group is reverted — `changeMode: replace` with no duration. In a live
venue what you pressed should be what is showing, and it should not expire
halfway through a match. Set a default duration if you want the opposite.

**`downloadRequired` is set**, so the player fetches the layout before showing
it rather than flashing an empty screen while it downloads.

**Folder scoping covers the subtree.** The CMS `folderId` filter matches one
folder exactly, so scoping to a root folder alone finds nothing when layouts sit
in per-project subfolders — which is how Pixelmabob files them. The adapter walks
the folder tree and filters against it.

## Changelog

<!--
	Placeholder for the next version (at the beginning of the line):
	### __WORK IN PROGRESS__
-->
### __WORK IN PROGRESS__

- Release tooling: `npm run release` now drives the version bump, so
  `package.json`, `io-package.json` and this changelog cannot drift apart.
- Integration test that starts the adapter under a real js-controller.

### 0.2.0

- **Layout changes now reach Arexibo and gaxibo players.** Those players do not
  implement the CMS's `changeLayout` XMR action — it arrives, is logged as
  unsupported and dropped, while the CMS reports success — so a layout change
  did nothing and nothing failed. The new default `schedule` mode books a
  priority schedule event and sends `collectNow` instead, which every player
  honours. Verified through to a live display.
- `layoutPlayMode` setting: `schedule` (default, works on any player) or
  `action` (instant, official Xibo player only).
- `schedulePriority` setting, which is also the marker for the events the
  adapter owns and may replace.
- `revertToSchedule` deletes the adapter's own schedule event in `schedule`
  mode, rather than posting an XMR action the player would ignore.
- `overlayLayout` is refused in `schedule` mode rather than silently doing
  nothing, since those players render no overlay by either route.

### 0.1.0

- Initial release: display group and layout inventory, and change layout /
  overlay layout / revert to schedule / collect now commands.

## Related

- **Pixelmabob** — authors the designs and publishes the layouts this adapter plays
- **ioBroker.streamdeck** — the decks that drive it

Both are separate repositories in the same estate.

## License

MIT — see [LICENSE](LICENSE).

Copyright (c) 2026 Alan Paris
