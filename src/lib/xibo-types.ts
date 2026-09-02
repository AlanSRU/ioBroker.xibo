/**
 * Configuration, CMS DTOs and the static object tree.
 *
 * Endpoints and field names come from the CMS's own OpenAPI document
 * (`web/swagger.json` in xibo-cms): API base `/api`, token at
 * `/api/authorize/access_token`, `client_credentials` grant.
 */

/**
 * How a "play this layout" request reaches a player.
 *
 * `action` posts the CMS's own `changeLayout` action. The CMS delivers it over
 * XMR and a player that implements that message applies it instantly — but
 * one that does not simply logs it and carries on, while the CMS still reports
 * success. Our gaxibo/Arexibo players are in the second category, so nothing
 * moves and nothing fails.
 *
 * `schedule` writes a priority schedule event instead and asks the group to
 * collect. Every player honours its schedule, so this works regardless of
 * which XMR actions the player implements. It costs a collect round trip —
 * seconds rather than instant — and leaves an event in the CMS schedule.
 */
export type LayoutPlayMode = "action" | "schedule";

export interface XiboConfig {
    /** CMS root without the /api suffix, e.g. https://signage.internal */
    url: string;
    clientId: string;
    clientSecret: string;
    /** Full inventory refresh, ms. */
    inventoryPollInterval: number;
    /** Per-display status refresh, ms. */
    statusPollInterval: number;
    requestTimeout: number;
    /**
     * Only surface layouts in this CMS folder (and below). Pixelmabob publishes
     * into one root folder, and a deck should offer those rather than every
     * layout in the CMS.
     */
    layoutFolder: string;
    /** Seconds a changeLayout stays in effect; 0 means until reverted. */
    defaultChangeDuration: number;
    /** How a layout request reaches the player. See {@link LayoutPlayMode}. */
    layoutPlayMode: LayoutPlayMode;
    /**
     * Priority of the schedule events this adapter creates, in `schedule` mode.
     *
     * Doubles as the marker for what the adapter owns: a layout event at this
     * priority on a group it drives is treated as its own and replaced on the
     * next request. It must therefore be a priority nothing else uses, and
     * must be above anything it needs to override.
     */
    schedulePriority: number;
    /** Keys of the CMS collections mirrored into `inventory.*`. */
    inventoryCollections: string[];
}

export interface AdapterLogger {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}

// ------------------------------------------------------------------ CMS DTOs

export interface XiboDisplayGroup {
    displayGroupId: number;
    displayGroup: string;
    description?: string;
    isDisplaySpecific: number;
    folderId?: number;
}

export interface XiboDisplay {
    displayId: number;
    display: string;
    displayGroupId?: number;
    loggedIn: number;
    lastAccessed?: string;
    /** Xibo reports this as a string of the layout currently playing. */
    currentLayoutId?: number;
    currentLayout?: string;
    mediaInventoryStatus?: number;
}

export interface XiboLayout {
    layoutId: number;
    layout: string;
    /**
     * The single-layout campaign this layout is scheduled by.
     *
     * A schedule event names a campaign, never a layout, so this is what has
     * to be sent when scheduling — a layoutId in its place quietly schedules
     * whichever layout happens to own that campaign id.
     */
    campaignId?: number;
    width: number;
    height: number;
    folderId?: number;
    duration?: number;
    publishedStatusId?: number;
}

export interface XiboDayPart {
    dayPartId: number;
    name: string;
    isAlways: number;
    isCustom: number;
}

export interface XiboScheduleEvent {
    eventId: number;
    eventTypeId: number;
    campaignId: number;
    isPriority: number;
    dayPartId: number;
}

export interface XiboFolder {
    id: number;
    text: string;
    parentId: number;
    isRoot?: number;
    children?: unknown;
}

// ------------------------------------------------------------- object tree

export interface ChannelDefinition {
    id: string;
    name: string;
}

export interface StateDefinition {
    id: string;
    name: string;
    type: ioBroker.CommonType;
    role: string;
    read: boolean;
    write: boolean;
    def?: unknown;
}

export const CHANNEL_DEFINITIONS: ChannelDefinition[] = [
    { id: "info", name: "Connection and diagnostics" },
    { id: "inventory", name: "Mirrored CMS collections" },
    { id: "commands", name: "Commands" },
    { id: "displayGroups", name: "Per display group" },
];

export const STATE_DEFINITIONS: StateDefinition[] = [
    { id: "info.connection", name: "CMS reachable and credentials valid", type: "boolean", role: "indicator.connected", read: true, write: false, def: false },
    { id: "info.lastError", name: "Last error", type: "string", role: "text", read: true, write: false, def: "" },
    { id: "info.lastSync", name: "Last successful inventory refresh", type: "string", role: "text", read: true, write: false, def: "" },
    { id: "info.cmsUrl", name: "CMS URL", type: "string", role: "text", read: true, write: false, def: "" },

    // The inventory states are generated from the selected collections; see
    // {@link inventoryStateDefinitions}.

    // Written un-acked by callers; the adapter executes and clears them, so an
    // identical follow-up request still triggers.
    { id: "commands.refresh", name: "Refresh inventory now", type: "boolean", role: "button", read: false, write: true, def: false },
    { id: "commands.changeLayout", name: "Play a layout on a display group: {displayGroupId, layoutId, duration?}", type: "string", role: "json", read: false, write: true, def: "" },
    { id: "commands.overlayLayout", name: "Overlay a layout on a display group: {displayGroupId, layoutId, duration?}", type: "string", role: "json", read: false, write: true, def: "" },
    { id: "commands.revertToSchedule", name: "Return a display group to its schedule: {displayGroupId}", type: "string", role: "json", read: false, write: true, def: "" },
    { id: "commands.collectNow", name: "Ask a display group to collect now: {displayGroupId}", type: "string", role: "json", read: false, write: true, def: "" },
    { id: "commands.lastResult", name: "Result of the last command", type: "string", role: "json", read: true, write: false, def: "" },
    /**
     * The escape hatch, for the operations this adapter does not model.
     *
     * A state cannot hand a response body back to its caller, so the result
     * lands in `commands.lastResult`. A script that needs the body should use
     * `sendTo("xibo.0", "api", { method, path, params })` instead, which
     * returns it directly.
     */
    { id: "commands.api", name: "Call any CMS operation: {method, path, params?}", type: "string", role: "json", read: false, write: true, def: "" },
];

/**
 * The `inventory.*` states for a set of mirrored collections.
 *
 * Generated rather than listed, so a collection cannot be added to the
 * catalogue and then quietly never get its states created. The ids come from
 * `collectionStateIds`, which preserves the ones 0.2.0 already published.
 */
export function inventoryStateDefinitions(
    collections: Array<{ key: string; countKey?: string; name: string }>,
): StateDefinition[] {
    const definitions: StateDefinition[] = [];
    for (const c of collections) {
        definitions.push({
            id: `inventory.${c.key}Json`,
            name: `${c.name} as JSON`,
            type: "string",
            role: "json",
            read: true,
            write: false,
            def: "[]",
        });
        definitions.push({
            id: `inventory.${c.countKey ?? `${c.key}Count`}`,
            name: `${c.name} count`,
            type: "number",
            role: "value",
            read: true,
            write: false,
            def: 0,
        });
    }
    return definitions;
}

/** Per display group, under `displayGroups.<sanitised name>`. */
export const DISPLAY_GROUP_STATE_SUFFIXES: StateDefinition[] = [
    { id: "id", name: "Display group id", type: "number", role: "value", read: true, write: false, def: 0 },
    { id: "name", name: "Display group name", type: "string", role: "text", read: true, write: false, def: "" },
    { id: "displayCount", name: "Displays in this group", type: "number", role: "value", read: true, write: false, def: 0 },
    { id: "displaysOnline", name: "Displays currently logged in", type: "number", role: "value", read: true, write: false, def: 0 },
    { id: "currentLayout", name: "Layout reported by the first display in the group", type: "string", role: "text", read: true, write: false, def: "" },
    // Writable: the whole point of the adapter — press a button, play a layout.
    { id: "playLayoutId", name: "Write a layoutId to play it on this group", type: "number", role: "level", read: true, write: true, def: 0 },
    { id: "revert", name: "Return this group to its schedule", type: "boolean", role: "button", read: false, write: true, def: false },
];

/**
 * Object-id-safe form of a CMS name.
 *
 * ioBroker ids may not contain `.` or spaces, and the CMS allows both, so a name
 * is folded rather than used directly. Collisions are resolved by the caller
 * appending the id, because two display groups may legitimately fold together.
 */
export function sanitizeId(value: string): string {
    const cleaned = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
    return cleaned.length > 0 ? cleaned : "unnamed";
}

// ------------------------------------------------------------------- health

/**
 * Consecutive status-poll failures before `info.connection` goes false.
 *
 * Two, so a single timeout or blip does not tell every watchdog the CMS has
 * gone away, while a real outage is still reported within two poll intervals.
 */
export const CONNECTION_FAILURE_THRESHOLD = 2;

export interface HealthInputs {
    /** Whether a status poll has ever succeeded. */
    statusEverSucceeded: boolean;
    /** Consecutive status-poll failures. */
    statusFailures: number;
    /** Outstanding status-poll error, if any. */
    statusError: string | null;
    /** Outstanding inventory-refresh error, if any. */
    inventoryError: string | null;
}

/**
 * What `info.connection` and `info.lastError` should say.
 *
 * Pure and exported so the two rules that were previously wrong can be
 * pinned. Liveness is the status poll alone: it is the frequent, cheap,
 * authenticated request that actually answers "is the CMS reachable with our
 * credentials". A partial inventory failure — a Xibo application scoped
 * without Layout access gets a permanent 403 on `/layout` — is real and
 * belongs in `lastError`, but it is not a disconnection. When both pollers
 * wrote this flag, that 403 made them contradict each other for ever.
 */
export function evaluateHealth(inputs: HealthInputs): { connected: boolean; lastError: string } {
    return {
        // Never true unproven, and never false on a single blip.
        connected: inputs.statusEverSucceeded && inputs.statusFailures < CONNECTION_FAILURE_THRESHOLD,
        // A live status failure is the more urgent of the two, so it wins.
        lastError: inputs.statusError ?? inputs.inventoryError ?? "",
    };
}

/**
 * The requested duration in seconds, or `fallback` when none was given.
 *
 * Validated rather than coerced. `Number("30s")` is `NaN`, and both play
 * routes treat `NaN` as "no duration given" — so a plausible hand-written
 * payload like `{"layoutId":41,"duration":"30s"}` used to book an indefinite
 * event instead of a 30-second one, leaving the layout up until someone
 * reverted it by hand, while `lastResult` recorded `ok:true` and nothing was
 * logged. Every other field in that payload was checked; this one was not.
 */
export function parseDurationSeconds(value: unknown, fallback: number): number {
    if (value === undefined || value === null) return fallback;
    // `Number("")` is 0, not NaN, and 0 here means "until reverted" — so a
    // blank would quietly become an indefinite play rather than being refused.
    if (typeof value === "string" && value.trim().length === 0) {
        throw new Error(`"duration" must be a number of seconds, got ${JSON.stringify(value)}`);
    }
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0) {
        throw new Error(`"duration" must be a number of seconds, got ${JSON.stringify(value)}`);
    }
    return seconds;
}

/**
 * The `command` and `payload` a failed write should be recorded under.
 *
 * `commands.lastResult` is documented as `{ok, command, payload, error?, ts}`
 * and is the state a deck reads to find out whether its press worked. The
 * success and failure paths used to describe the same write differently: a
 * working `commands.changeLayout` recorded `command: "changeLayout"` with the
 * parsed payload, while a failing one recorded `command:
 * "commands.changeLayout"` with the raw string, and a failing per-group write
 * recorded `command: "displayGroups.led_walls.playLayoutId"` with a bare
 * number. A consumer matching `command === "changeLayout"` to decide whether
 * its own press succeeded therefore matched every success and no failure, and
 * reported a failed press as still pending.
 *
 * So both paths name the write the same way: the last id segment, which is
 * already what the success paths pass.
 */
export function describeWrite(local: string, value: unknown): { command: string; payload: unknown } {
    const segments = local.split(".");
    const command = segments[segments.length - 1] ?? local;

    // A command payload is JSON, and the caller wants it back in the shape it
    // sent — but the throw may have been the parse itself, so an unparseable
    // value is recorded verbatim rather than lost.
    if (segments[0] === "commands" && typeof value === "string" && value.trim().length > 0) {
        try {
            return { command, payload: JSON.parse(value) };
        } catch {
            return { command, payload: value };
        }
    }
    // A per-group write is a bare value, so the group it was aimed at is the
    // only context worth keeping.
    if (segments[0] === "displayGroups" && segments.length >= 3) {
        return { command, payload: { displayGroup: segments[1], value } };
    }
    return { command, payload: value };
}
