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
| `overlayLayout` | `{displayGroupId, layoutId, duration?}` |
| `revertToSchedule` | `{displayGroupId}` |
| `collectNow` | `{displayGroupId}` |

`commands.lastResult` records `{ok, command, payload, error?, ts}`.

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
