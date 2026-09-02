import * as utils from "@iobroker/adapter-core";
import { XiboClient } from "./lib/xibo-client";
import {
    CHANNEL_DEFINITIONS, DISPLAY_GROUP_STATE_SUFFIXES, evaluateHealth, inventoryStateDefinitions,
    parseDurationSeconds, sanitizeId, STATE_DEFINITIONS, StateDefinition, XiboConfig, XiboDisplayGroup,
} from "./lib/xibo-types";
import {
    COLLECTIONS, CollectionDefinition, collectionRows, collectionStateIds, selectedCollections,
} from "./lib/xibo-collections";

/** Keeps a configured number inside sane bounds, falling back when unusable. */
function clamp(value: unknown, min: number, max: number, fallback: number): number {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(max, Math.max(min, n));
}

interface GroupIndexEntry {
    objectId: string;
    displayGroupId: number;
    name: string;
}

class XiboAdapter extends utils.Adapter {
    private client: XiboClient | null = null;
    private inventoryTimer: ioBroker.Timeout | undefined;
    private statusTimer: ioBroker.Timeout | undefined;
    /**
     * Set before anything else in onUnload.
     *
     * A poll that is mid-request when the instance stops would otherwise carry
     * on after `client` is cleared and write state against a dead adapter.
     */
    private unloaded = false;
    /** Retry delay after a failed inventory refresh, doubling to the poll interval. */
    private inventoryRetryMs = 0;
    /** Consecutive status-poll failures. See {@link publishHealth}. */
    private statusFailures = 0;
    /** Whether a status poll has ever succeeded, so the flag is never true unproven. */
    private statusEverSucceeded = false;
    /** Outstanding errors, owned one per poller so they cannot overwrite each other. */
    private statusError: string | null = null;
    private inventoryError: string | null = null;
    /** Display group id -> where it lives in the object tree. */
    private groupIndex = new Map<number, GroupIndexEntry>();
    private layoutFolderId: number | null = null;
    /** Whether the configured layout folder has been resolved once already. */
    private layoutFolderChecked = false;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: "xibo" });
        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("message", this.onMessage.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }

    private get settings(): XiboConfig {
        const c = this.config as unknown as Partial<XiboConfig>;
        return {
            url: (c.url ?? "").trim(),
            clientId: (c.clientId ?? "").trim(),
            clientSecret: (c.clientSecret ?? "").trim(),
            // Clamped at both ends in code, not just in the admin UI: an
            // instance object can be written by a restored backup or a script,
            // and a value at or above 2^31 makes Node fall back to a 1 ms timer
            // — which would poll the CMS continuously, or abort every request
            // before it could answer.
            inventoryPollInterval: clamp(c.inventoryPollInterval, 30_000, 86_400_000, 300_000),
            statusPollInterval: clamp(c.statusPollInterval, 5_000, 3_600_000, 30_000),
            requestTimeout: clamp(c.requestTimeout, 2_000, 120_000, 30_000),
            layoutFolder: (c.layoutFolder ?? "").trim(),
            defaultChangeDuration: Math.max(0, Number(c.defaultChangeDuration) || 0),
            // An unset or empty selection means the defaults, not nothing: an
            // instance upgrading from 0.2.0 has no such setting, and mirroring
            // nothing would empty the three states its scripts already read.
            inventoryCollections: selectedCollections(
                (this.config as unknown as { inventoryCollections?: unknown }).inventoryCollections,
            ).map((collection) => collection.key),
            // Defaults to `schedule` because it is the mode that works on any
            // player: a schedule is honoured universally, whereas the XMR
            // action is silently ignored by players that do not implement it.
            // `action` is the optimisation, not the safe choice.
            layoutPlayMode: c.layoutPlayMode === "action" ? "action" : "schedule",
            schedulePriority: clamp(c.schedulePriority, 1, 1000, 10),
        };
    }

    private async onReady(): Promise<void> {
        await this.createStateStructure();

        const config = this.settings;
        await this.setState("info.cmsUrl", { val: config.url, ack: true });

        if (!config.url || !config.clientId || !config.clientSecret) {
            this.log.error("CMS URL, client id and client secret are all required — configure the instance.");
            this.inventoryError = "Not configured";
            await this.publishHealth();
            return;
        }

        this.client = new XiboClient(config, this.log);

        await this.subscribeStatesAsync("commands.*");
        await this.subscribeStatesAsync("displayGroups.*");

        // Each pass re-arms itself when it finishes, so a slow CMS delays the
        // next poll rather than stacking a second one on top of it. With
        // setInterval a pass that outlives its interval overlaps the next, and
        // the pile-up grows for as long as the CMS is unwell.
        void this.pollInventory();
        void this.pollStatus();
    }

    private async pollInventory(): Promise<void> {
        const ok = await this.refreshInventory();
        if (this.unloaded) return;

        // A failed startup refresh leaves no display groups, so every button
        // press would be rejected until the full interval elapsed. Retry sooner,
        // backing off to the normal interval.
        const config = this.settings;
        if (ok) {
            this.inventoryRetryMs = 0;
        } else {
            this.inventoryRetryMs = Math.min(
                config.inventoryPollInterval,
                this.inventoryRetryMs === 0 ? 15_000 : this.inventoryRetryMs * 2,
            );
        }
        const delay = this.inventoryRetryMs || config.inventoryPollInterval;
        this.inventoryTimer = this.setTimeout(() => void this.pollInventory(), delay);
    }

    private async pollStatus(): Promise<void> {
        await this.refreshStatus();
        if (this.unloaded) return;
        this.statusTimer = this.setTimeout(() => void this.pollStatus(), this.settings.statusPollInterval);
    }

    private onUnload(callback: () => void): void {
        try {
            // First, so a poll already past its own guard stops before it
            // writes state or dereferences a cleared client.
            this.unloaded = true;
            if (this.inventoryTimer) this.clearTimeout(this.inventoryTimer);
            if (this.statusTimer) this.clearTimeout(this.statusTimer);
            this.client = null;
            callback();
        } catch {
            callback();
        }
    }

    // ------------------------------------------------------------- objects

    private async createStateStructure(): Promise<void> {
        // Parent channels are created explicitly: the runtime tolerates missing
        // parents, so a nested state would look fine while the object tree is
        // actually broken.
        for (const channel of CHANNEL_DEFINITIONS) {
            await this.setObjectNotExistsAsync(channel.id, {
                type: "channel",
                common: { name: channel.name },
                native: {},
            });
        }

        const mirrored = this.mirroredCollections();
        const states: StateDefinition[] = [...STATE_DEFINITIONS, ...inventoryStateDefinitions(mirrored)];
        for (const state of states) {
            await this.setObjectNotExistsAsync(state.id, {
                type: "state",
                common: {
                    name: state.name,
                    type: state.type,
                    role: state.role,
                    read: state.read,
                    write: state.write,
                    def: state.def as never,
                },
                native: {},
            });
        }

        await this.pruneDeselectedCollections(mirrored);
    }

    /** The collections this instance is configured to mirror. */
    private mirroredCollections(): CollectionDefinition[] {
        return selectedCollections(this.settings.inventoryCollections);
    }

    /** Whether one collection is mirrored, for the writers outside the mirror pass. */
    private isMirrored(key: string): boolean {
        return this.mirroredCollections().some((collection) => collection.key === key);
    }

    /**
     * Removes the inventory states of collections no longer selected.
     *
     * Without this, unticking a collection leaves its last value behind for
     * ever — a stale count and a stale JSON blob that look live, with nothing
     * to say they stopped being updated. Only states this adapter generates
     * are considered, so nothing outside `inventory.` is ever touched.
     */
    private async pruneDeselectedCollections(mirrored: CollectionDefinition[]): Promise<void> {
        const keep = new Set(mirrored.flatMap((c) => Object.values(collectionStateIds(c))));
        for (const collection of COLLECTIONS) {
            for (const id of Object.values(collectionStateIds(collection))) {
                if (keep.has(id)) continue;
                if (!(await this.objectExists(id))) continue;
                await this.delObjectAsync(id);
                this.log.debug(`Removed ${id}: its collection is no longer mirrored`);
            }
        }
    }

    private async ensureGroupObject(group: XiboDisplayGroup): Promise<GroupIndexEntry> {
        const existing = this.groupIndex.get(group.displayGroupId);
        if (existing) return existing;

        // Two groups can fold to the same id, so a collision falls back to the
        // CMS id rather than silently overwriting the first one's states.
        let objectId = `displayGroups.${sanitizeId(group.displayGroup)}`;
        const clash = [...this.groupIndex.values()].some((g) => g.objectId === objectId);
        if (clash) objectId = `${objectId}_${group.displayGroupId}`;

        await this.setObjectNotExistsAsync(objectId, {
            type: "channel",
            common: { name: group.displayGroup },
            native: { displayGroupId: group.displayGroupId },
        });

        for (const suffix of DISPLAY_GROUP_STATE_SUFFIXES) {
            await this.setObjectNotExistsAsync(`${objectId}.${suffix.id}`, {
                type: "state",
                common: {
                    name: suffix.name,
                    type: suffix.type,
                    role: suffix.role,
                    read: suffix.read,
                    write: suffix.write,
                    def: suffix.def as never,
                },
                native: {},
            });
        }

        const entry: GroupIndexEntry = { objectId, displayGroupId: group.displayGroupId, name: group.displayGroup };
        this.groupIndex.set(group.displayGroupId, entry);
        return entry;
    }

    // ------------------------------------------------------------ polling

    /**
     * The single writer of `info.connection` and `info.lastError`.
     *
     * Both were previously written by both pollers, which disagreed in two
     * ways. A single timed-out request — a CMS backup, a proxy reload — flipped
     * the flag immediately, so every watchdog gating on it fired a disconnect
     * that cleared 30 seconds later; hence the two-failure requirement. Worse,
     * the two writers could contradict each other indefinitely: a Xibo
     * application scoped without Layout access gets a permanent 403 on
     * `/layout`, so the inventory poll wrote `false` every five minutes and
     * the status poll wrote `true` 30 seconds later, for ever — an alarm storm
     * around a flag no script could use.
     *
     * So liveness is the status poll alone: it is the frequent, cheap,
     * authenticated request, and it is the thing that actually answers "is the
     * CMS reachable with our credentials". A partial inventory failure is real
     * and belongs in `lastError` and the log, but it is not a disconnection.
     */
    private async publishHealth(): Promise<void> {
        if (this.unloaded) return;
        const { connected, lastError } = evaluateHealth({
            statusEverSucceeded: this.statusEverSucceeded,
            statusFailures: this.statusFailures,
            statusError: this.statusError,
            inventoryError: this.inventoryError,
        });
        await this.setState("info.connection", { val: connected, ack: true });
        await this.setState("info.lastError", { val: lastError, ack: true });
    }

    /** Returns whether the refresh succeeded, so the caller can back off. */
    private async refreshInventory(): Promise<boolean> {
        if (!this.client || this.unloaded) return false;
        const config = this.settings;

        try {
            // Looked up once. Warning on every cycle about a folder that does
            // not exist would fill the log for the life of the instance.
            if (config.layoutFolder && this.layoutFolderId === null && !this.layoutFolderChecked) {
                const found = await this.client.findFolderPath(config.layoutFolder);
                // Latched only once the CMS has actually answered. Closing it
                // before the await turned a timeout into permanent loss of
                // folder scoping, and the deck would then be offered every
                // layout in the CMS with nothing logged.
                this.layoutFolderChecked = true;
                this.layoutFolderId = found;
                if (found === null) {
                    this.log.warn(
                        `Layout folder "${config.layoutFolder}" not found in the CMS — offering all layouts instead.`,
                    );
                }
            }

            const [groups, displays, layouts] = await Promise.all([
                this.client.listDisplayGroups(),
                this.client.listDisplays(),
                // The folder and everything below it: projects are subfolders,
                // so filtering on the root folder alone finds nothing.
                config.layoutFolder && this.layoutFolderId !== null
                    ? this.client.listLayoutsInFolderTree(config.layoutFolder)
                    : this.client.listLayouts(),
            ]);

            // Display-specific groups are Xibo's internal per-display groups;
            // they are not what an operator would ever pick on a deck.
            if (this.unloaded) return false;
            const pickable = groups.filter((g) => g.isDisplaySpecific !== 1);

            for (const group of pickable) {
                if (this.unloaded) return false;
                await this.ensureGroupObject(group);
            }
            if (this.unloaded) return false;

            // The three above are already in hand — and each was fetched in a
            // way the generic path could not reproduce: display groups are
            // filtered to the pickable ones, and layouts may be scoped to a
            // folder subtree. Reusing them keeps the request count the same as
            // 0.2.0 for anyone who mirrors only these three.
            const prefetched = new Map<string, unknown[]>([
                ["displayGroups", pickable],
                ["displays", displays],
                ["layouts", layouts],
            ]);
            await this.mirrorCollections(prefetched);
            if (this.unloaded) return false;

            await this.setState("info.lastSync", { val: new Date().toISOString(), ack: true });
            this.inventoryError = null;
            await this.publishHealth();
            return true;
        } catch (err) {
            if (this.unloaded) return false;
            this.log.error(`Inventory refresh failed: ${(err as Error).message}`);
            // Recorded and logged, but not treated as a disconnection: the CMS
            // can be perfectly reachable and still refuse one collection.
            this.inventoryError = (err as Error).message;
            await this.publishHealth();
            return false;
        }
    }

    /**
     * Writes `inventory.<key>Json` and its count for every mirrored collection.
     *
     * One failing collection is logged and skipped rather than failing the
     * whole pass: a Xibo application is feature-scoped, so an estate that has
     * never used menu boards can answer 403 there while everything else works,
     * and losing the display and layout inventory over that would take the
     * deck down.
     */
    private async mirrorCollections(prefetched: Map<string, unknown[]>): Promise<void> {
        const client = this.client;
        if (!client) return;

        const failed: string[] = [];
        for (const collection of this.mirroredCollections()) {
            if (this.unloaded) return;
            const ids = collectionStateIds(collection);
            try {
                const rows = prefetched.get(collection.key)
                    ?? collectionRows(collection, await client.listCollection(collection.path));
                if (this.unloaded) return;
                await this.setState(ids.json, { val: JSON.stringify(rows), ack: true });
                await this.setState(ids.count, { val: rows.length, ack: true });
            } catch (err) {
                failed.push(`${collection.key} (${(err as Error).message})`);
            }
        }

        if (failed.length > 0) {
            // Left as they were rather than zeroed: a collection that could not
            // be read is not a collection that became empty, and writing 0
            // would tell every script exactly the wrong thing.
            this.log.warn(`Could not mirror ${failed.length} collection(s): ${failed.join("; ")}`);
        }
    }

    private async refreshStatus(): Promise<void> {
        if (!this.client || this.unloaded) return;
        try {
            const client = this.client;
            const displays = await client.listDisplays();
            if (this.unloaded) return;

            for (const entry of this.groupIndex.values()) {
                // Captured above: `this.client` is cleared on unload, and this
                // loop can be mid-await when that happens.
                if (this.unloaded) return;
                const inGroup = await client.listDisplaysInGroup(entry.displayGroupId);
                if (this.unloaded) return;
                const online = inGroup.filter((d) => d.loggedIn === 1);

                await this.setState(`${entry.objectId}.id`, { val: entry.displayGroupId, ack: true });
                await this.setState(`${entry.objectId}.name`, { val: entry.name, ack: true });
                await this.setState(`${entry.objectId}.displayCount`, { val: inGroup.length, ack: true });
                await this.setState(`${entry.objectId}.displaysOnline`, { val: online.length, ack: true });
                await this.setState(`${entry.objectId}.currentLayout`, {
                    val: inGroup[0]?.currentLayout ?? "",
                    ack: true,
                });
            }

            if (this.unloaded) return;
            // Only when `displays` is actually mirrored. Writing it regardless
            // resurrected the value 30 seconds after `pruneDeselectedCollections`
            // had deleted the object, leaving an orphan that kept updating and
            // looked live — so the collection could not in fact be turned off.
            if (this.isMirrored("displays")) {
                await this.setState("inventory.displaysJson", { val: JSON.stringify(displays), ack: true });
            }
            this.statusFailures = 0;
            this.statusEverSucceeded = true;
            this.statusError = null;
            await this.publishHealth();
        } catch (err) {
            if (this.unloaded) return;
            this.statusFailures++;
            this.statusError = (err as Error).message;
            this.log.warn(
                `Status refresh failed (${this.statusFailures} in a row): ${(err as Error).message}`,
            );
            await this.publishHealth();
        }
    }

    // ------------------------------------------------------------ messages

    /**
     * `sendTo` entry point, for the operations this adapter does not model.
     *
     * The CMS exposes 263 operations; the state tree covers the few dozen a
     * venue drives. This reaches the rest — and unlike `commands.api`, it
     * hands the response body back to the caller, which a state cannot do.
     *
     *     const layouts = await sendToAsync("xibo.0", "api", {
     *         method: "GET", path: "/layout", params: { retired: 0 },
     *     });
     *
     * A caller that sent no callback gets no reply, so the result is logged
     * instead of being dropped in silence.
     */
    private async onMessage(obj: ioBroker.Message): Promise<void> {
        const reply = (payload: unknown): void => {
            if (obj.callback) this.sendTo(obj.from, obj.command, payload, obj.callback);
        };

        if (obj.command !== "api") {
            this.log.warn(`Unknown message command "${obj.command}"`);
            reply({ ok: false, error: `Unknown command "${obj.command}". The only one is "api".` });
            return;
        }
        if (!this.client) {
            reply({ ok: false, error: "Not connected to a CMS — the instance is not configured." });
            return;
        }

        const message = (typeof obj.message === "object" && obj.message !== null
            ? obj.message
            : {}) as { method?: unknown; path?: unknown; params?: unknown };

        try {
            const method = String(message.method ?? "GET");
            const path = String(message.path ?? "");
            const params = (typeof message.params === "object" && message.params !== null
                ? message.params
                : {}) as Record<string, unknown>;
            const result = await this.client.call(method, path, params);
            this.log.debug(`api ${method} ${path}`);
            reply({ ok: true, result });
        } catch (err) {
            const error = (err as Error).message;
            this.log.warn(`api call failed: ${error}`);
            if (!obj.callback) this.log.warn("The caller sent no callback, so it will never see that error.");
            reply({ ok: false, error });
        }
    }

    // ------------------------------------------------------------ commands

    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        // ack:true is the adapter's own write coming back; only un-acked writes
        // are commands from somewhere else.
        if (!state || state.ack || !this.client) return;

        const local = id.slice(`${this.namespace}.`.length);

        try {
            if (local.startsWith("commands.")) {
                await this.handleCommand(local.slice("commands.".length), state.val);
                return;
            }
            if (local.startsWith("displayGroups.")) {
                await this.handleGroupWrite(local, state.val);
                return;
            }
        } catch (err) {
            this.log.error(`${local} failed: ${(err as Error).message}`);
            await this.recordResult(local, state.val, false, (err as Error).message);
        }
    }

    private parsePayload(value: unknown): Record<string, unknown> {
        if (typeof value !== "string" || value.trim().length === 0) return {};
        try {
            const parsed = JSON.parse(value);
            return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
        } catch {
            throw new Error(`Payload is not valid JSON: ${String(value).slice(0, 120)}`);
        }
    }

    private requireNumber(payload: Record<string, unknown>, key: string): number {
        const value = Number(payload[key]);
        if (!Number.isFinite(value)) throw new Error(`"${key}" is required and must be a number`);
        return value;
    }

    /** The requested duration in seconds, or the configured default. */
    private durationSeconds(payload: Record<string, unknown>): number {
        return parseDurationSeconds(payload.duration, this.settings.defaultChangeDuration);
    }

    private async handleCommand(command: string, value: unknown): Promise<void> {
        const payload = command === "refresh" ? {} : this.parsePayload(value);

        switch (command) {
            case "refresh": {
                // Both swallow their own errors, so the outcome has to be taken
                // from the return value — otherwise a refresh against an
                // unreachable CMS records ok:true and anything gating on that
                // believes it worked.
                const ok = await this.refreshInventory();
                await this.refreshStatus();
                if (!ok) {
                    await this.recordResult(command, payload, false, "Inventory refresh failed — see info.lastError");
                    await this.setState("commands.refresh", { val: false, ack: true });
                    return;
                }
                break;
            }

            case "changeLayout":
                await this.playLayout(
                    this.requireNumber(payload, "displayGroupId"),
                    this.requireNumber(payload, "layoutId"),
                    this.durationSeconds(payload),
                );
                break;

            case "overlayLayout":
                // Refused rather than attempted: `schedule` mode exists because
                // the players in use ignore XMR actions, and those same players
                // render no overlay at all, by either route. Posting the action
                // would report success and show nothing.
                if (this.settings.layoutPlayMode === "schedule") {
                    throw new Error(
                        "overlayLayout needs a player that implements XMR overlays. This instance is in " +
                        "schedule mode, which exists for players that do not — use changeLayout instead.",
                    );
                }
                await this.client!.overlayLayout(
                    this.requireNumber(payload, "displayGroupId"),
                    this.requireNumber(payload, "layoutId"),
                    this.durationSeconds(payload),
                );
                break;

            case "revertToSchedule":
                await this.revertGroup(this.requireNumber(payload, "displayGroupId"));
                break;

            case "collectNow":
                await this.client!.collectNow(this.requireNumber(payload, "displayGroupId"));
                break;

            case "api": {
                // The response body goes to lastResult, since a state cannot
                // hand anything back to whoever wrote it. sendTo can, and the
                // state's own description points there.
                const params = typeof payload.params === "object" && payload.params !== null
                    ? (payload.params as Record<string, unknown>)
                    : {};
                const result = await this.client!.call(
                    String(payload.method ?? "GET"),
                    String(payload.path ?? ""),
                    params,
                );
                await this.recordResult(command, payload, true, undefined, result);
                await this.setState("commands.api", { val: "", ack: true });
                return;
            }

            default:
                // lastResult is written by the adapter, so it lands here on its
                // own un-acked writes; anything else is a caller's mistake.
                if (command !== "lastResult") this.log.warn(`Unknown command "${command}"`);
                return;
        }

        await this.recordResult(command, payload, true);
        // Cleared so an identical follow-up request still triggers a change.
        await this.setState(`commands.${command}`, { val: command === "refresh" ? false : "", ack: true });
    }

    private async handleGroupWrite(local: string, value: unknown): Promise<void> {
        const [, groupSegment, suffix] = local.split(".");
        const entry = [...this.groupIndex.values()].find((g) => g.objectId === `displayGroups.${groupSegment}`);
        if (!entry) {
            this.log.warn(`Write to unknown display group "${groupSegment}"`);
            return;
        }

        if (suffix === "playLayoutId") {
            const layoutId = Number(value);
            if (!Number.isFinite(layoutId) || layoutId <= 0) {
                throw new Error(`playLayoutId must be a positive layout id, got ${String(value)}`);
            }
            await this.playLayout(entry.displayGroupId, layoutId, this.settings.defaultChangeDuration);
            await this.setState(local, { val: layoutId, ack: true });
            await this.recordResult("playLayoutId", { displayGroupId: entry.displayGroupId, layoutId }, true);
            return;
        }

        if (suffix === "revert") {
            await this.revertGroup(entry.displayGroupId);
            await this.setState(local, { val: false, ack: true });
            await this.recordResult("revert", { displayGroupId: entry.displayGroupId }, true);
            return;
        }

        this.log.warn(`Write to "${local}" is not a command`);
    }

    /**
     * Plays a layout by whichever route this instance is configured for.
     *
     * One place decides, so the command state, the per-group `playLayoutId`
     * write and anything added later cannot drift into using different
     * mechanisms.
     */
    private async playLayout(displayGroupId: number, layoutId: number, duration: number): Promise<void> {
        const { layoutPlayMode, schedulePriority } = this.settings;
        if (layoutPlayMode === "action") {
            await this.client!.changeLayout(displayGroupId, layoutId, duration);
            return;
        }
        await this.client!.scheduleLayout(displayGroupId, layoutId, schedulePriority, duration);
    }

    /**
     * Returns a display group to its own schedule.
     *
     * In `schedule` mode the thing overriding that schedule is the adapter's
     * own priority event, so reverting means deleting it. The XMR revert action
     * would leave it in place and the sign would stay up — a revert that
     * reports success and changes nothing.
     */
    private async revertGroup(displayGroupId: number): Promise<void> {
        const { layoutPlayMode, schedulePriority } = this.settings;
        if (layoutPlayMode === "action") {
            await this.client!.revertToSchedule(displayGroupId);
            return;
        }
        const removed = await this.client!.clearScheduledLayouts(displayGroupId, schedulePriority);
        await this.client!.collectNow(displayGroupId);
        this.log.debug(`revert: removed ${removed} scheduled layout(s) from display group ${displayGroupId}`);
    }

    private async recordResult(
        command: string,
        payload: unknown,
        ok: boolean,
        error?: string,
        result?: unknown,
    ): Promise<void> {
        await this.setState("commands.lastResult", {
            val: JSON.stringify({ ok, command, payload, error, result, ts: Date.now() }),
            ack: true,
        });
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new XiboAdapter(options);
} else {
    (() => new XiboAdapter())();
}
