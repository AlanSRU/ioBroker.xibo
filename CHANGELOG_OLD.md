# Older changes

## 0.2.0

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

## 0.1.0

- Initial release: display group and layout inventory, and change layout /
  overlay layout / revert to schedule / collect now commands.
