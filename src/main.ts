import * as utils from "@iobroker/adapter-core";
import { XiboClient } from "./lib/xibo-client";
import {
    CHANNEL_DEFINITIONS, DISPLAY_GROUP_STATE_SUFFIXES, sanitizeId, STATE_DEFINITIONS,
    XiboConfig, XiboDisplayGroup,
} from "./lib/xibo-types";

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
    /** Display group id -> where it lives in the object tree. */
    private groupIndex = new Map<number, GroupIndexEntry>();
    private layoutFolderId: number | null = null;
    /** Whether the configured layout folder has been resolved once already. */
    private layoutFolderChecked = false;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: "xibo" });
        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
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
        };
    }

    private async onReady(): Promise<void> {
        await this.createStateStructure();

        const config = this.settings;
        await this.setState("info.cmsUrl", { val: config.url, ack: true });

        if (!config.url || !config.clientId || !config.clientSecret) {
            this.log.error("CMS URL, client id and client secret are all required — configure the instance.");
            await this.setConnected(false, "Not configured");
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

        for (const state of STATE_DEFINITIONS) {
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

    private async setConnected(connected: boolean, error?: string): Promise<void> {
        if (this.unloaded) return;
        await this.setState("info.connection", { val: connected, ack: true });
        if (error !== undefined) await this.setState("info.lastError", { val: error, ack: true });
    }

    /** Returns whether the refresh succeeded, so the caller can back off. */
    private async refreshInventory(): Promise<boolean> {
        if (!this.client || this.unloaded) return false;
        const config = this.settings;

        try {
            // Looked up once. Warning on every cycle about a folder that does
            // not exist would fill the log for the life of the instance.
            if (config.layoutFolder && this.layoutFolderId === null && !this.layoutFolderChecked) {
                this.layoutFolderChecked = true;
                this.layoutFolderId = await this.client.findFolderPath(config.layoutFolder);
                if (this.layoutFolderId === null) {
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
            const pickable = groups.filter((g) => g.isDisplaySpecific !== 1);

            for (const group of pickable) await this.ensureGroupObject(group);

            await this.setState("inventory.displayGroupsJson", { val: JSON.stringify(pickable), ack: true });
            await this.setState("inventory.displaysJson", { val: JSON.stringify(displays), ack: true });
            await this.setState("inventory.layoutsJson", { val: JSON.stringify(layouts), ack: true });
            await this.setState("inventory.displayGroupCount", { val: pickable.length, ack: true });
            await this.setState("inventory.displayCount", { val: displays.length, ack: true });
            await this.setState("inventory.layoutCount", { val: layouts.length, ack: true });
            await this.setState("info.lastSync", { val: new Date().toISOString(), ack: true });
            await this.setConnected(true, "");
            return true;
        } catch (err) {
            if (this.unloaded) return false;
            this.log.error(`Inventory refresh failed: ${(err as Error).message}`);
            await this.setConnected(false, (err as Error).message);
            return false;
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
            await this.setState("inventory.displaysJson", { val: JSON.stringify(displays), ack: true });
            await this.setConnected(true);
        } catch (err) {
            if (this.unloaded) return;
            this.log.warn(`Status refresh failed: ${(err as Error).message}`);
            await this.setConnected(false, (err as Error).message);
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

    private async handleCommand(command: string, value: unknown): Promise<void> {
        const payload = command === "refresh" ? {} : this.parsePayload(value);
        const duration = Number(payload.duration ?? this.settings.defaultChangeDuration);

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
                await this.client!.changeLayout(
                    this.requireNumber(payload, "displayGroupId"),
                    this.requireNumber(payload, "layoutId"),
                    duration,
                );
                break;

            case "overlayLayout":
                await this.client!.overlayLayout(
                    this.requireNumber(payload, "displayGroupId"),
                    this.requireNumber(payload, "layoutId"),
                    duration,
                );
                break;

            case "revertToSchedule":
                await this.client!.revertToSchedule(this.requireNumber(payload, "displayGroupId"));
                break;

            case "collectNow":
                await this.client!.collectNow(this.requireNumber(payload, "displayGroupId"));
                break;

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
            await this.client!.changeLayout(entry.displayGroupId, layoutId, this.settings.defaultChangeDuration);
            await this.setState(local, { val: layoutId, ack: true });
            await this.recordResult("playLayoutId", { displayGroupId: entry.displayGroupId, layoutId }, true);
            return;
        }

        if (suffix === "revert") {
            await this.client!.revertToSchedule(entry.displayGroupId);
            await this.setState(local, { val: false, ack: true });
            await this.recordResult("revert", { displayGroupId: entry.displayGroupId }, true);
            return;
        }

        this.log.warn(`Write to "${local}" is not a command`);
    }

    private async recordResult(command: string, payload: unknown, ok: boolean, error?: string): Promise<void> {
        await this.setState("commands.lastResult", {
            val: JSON.stringify({ ok, command, payload, error, ts: Date.now() }),
            ack: true,
        });
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new XiboAdapter(options);
} else {
    (() => new XiboAdapter())();
}
