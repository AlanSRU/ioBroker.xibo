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
    { id: "inventory", name: "Displays, display groups and layouts" },
    { id: "commands", name: "Commands" },
    { id: "displayGroups", name: "Per display group" },
];

export const STATE_DEFINITIONS: StateDefinition[] = [
    { id: "info.connection", name: "CMS reachable and credentials valid", type: "boolean", role: "indicator.connected", read: true, write: false, def: false },
    { id: "info.lastError", name: "Last error", type: "string", role: "text", read: true, write: false, def: "" },
    { id: "info.lastSync", name: "Last successful inventory refresh", type: "string", role: "text", read: true, write: false, def: "" },
    { id: "info.cmsUrl", name: "CMS URL", type: "string", role: "text", read: true, write: false, def: "" },

    { id: "inventory.displayGroupsJson", name: "Display groups as JSON", type: "string", role: "json", read: true, write: false, def: "[]" },
    { id: "inventory.displaysJson", name: "Displays as JSON", type: "string", role: "json", read: true, write: false, def: "[]" },
    { id: "inventory.layoutsJson", name: "Layouts as JSON", type: "string", role: "json", read: true, write: false, def: "[]" },
    { id: "inventory.displayGroupCount", name: "Display group count", type: "number", role: "value", read: true, write: false, def: 0 },
    { id: "inventory.displayCount", name: "Display count", type: "number", role: "value", read: true, write: false, def: 0 },
    { id: "inventory.layoutCount", name: "Layout count", type: "number", role: "value", read: true, write: false, def: 0 },

    // Written un-acked by callers; the adapter executes and clears them, so an
    // identical follow-up request still triggers.
    { id: "commands.refresh", name: "Refresh inventory now", type: "boolean", role: "button", read: false, write: true, def: false },
    { id: "commands.changeLayout", name: "Play a layout on a display group: {displayGroupId, layoutId, duration?}", type: "string", role: "json", read: false, write: true, def: "" },
    { id: "commands.overlayLayout", name: "Overlay a layout on a display group: {displayGroupId, layoutId, duration?}", type: "string", role: "json", read: false, write: true, def: "" },
    { id: "commands.revertToSchedule", name: "Return a display group to its schedule: {displayGroupId}", type: "string", role: "json", read: false, write: true, def: "" },
    { id: "commands.collectNow", name: "Ask a display group to collect now: {displayGroupId}", type: "string", role: "json", read: false, write: true, def: "" },
    { id: "commands.lastResult", name: "Result of the last command", type: "string", role: "json", read: true, write: false, def: "" },
];

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
