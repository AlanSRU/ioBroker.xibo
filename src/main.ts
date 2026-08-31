import * as utils from "@iobroker/adapter-core";
import { XiboClient } from "./lib/xibo-client";
import {
    CHANNEL_DEFINITIONS, DISPLAY_GROUP_STATE_SUFFIXES, sanitizeId, STATE_DEFINITIONS,
    XiboConfig, XiboDisplayGroup,
} from "./lib/xibo-types";

interface GroupIndexEntry {
    objectId: string;
    displayGroupId: number;
    name: string;
}

class XiboAdapter extends utils.Adapter {
    private client: XiboClient | null = null;
    private inventoryTimer: ioBroker.Interval | undefined;
    private statusTimer: ioBroker.Interval | undefined;
    /** Display group id -> where it lives in the object tree. */
    private groupIndex = new Map<number, GroupIndexEntry>();
    private layoutFolderId: number | null = null;

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
            // Floors, not defaults: a poll every second would hammer the CMS.
            inventoryPollInterval: Math.max(30_000, Number(c.inventoryPollInterval) || 300_000),
            statusPollInterval: Math.max(5_000, Number(c.statusPollInterval) || 30_000),
            requestTimeout: Math.max(2_000, Number(c.requestTimeout) || 30_000),
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

        await this.refreshInventory();
        await this.refreshStatus();

        this.inventoryTimer = this.setInterval(() => {
            void this.refreshInventory();
        }, config.inventoryPollInterval);

        this.statusTimer = this.setInterval(() => {
            void this.refreshStatus();
        }, config.statusPollInterval);
    }

    private onUnload(callback: () => void): void {
        try {
            if (this.inventoryTimer) this.clearInterval(this.inventoryTimer);
            if (this.statusTimer) this.clearInterval(this.statusTimer);
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
        await this.setState("info.connection", { val: connected, ack: true });
        if (error !== undefined) await this.setState("info.lastError", { val: error, ack: true });
    }

    private async refreshInventory(): Promise<void> {
        if (!this.client) return;
        const config = this.settings;

        try {
            if (config.layoutFolder && this.layoutFolderId === null) {
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
        } catch (err) {
            this.log.error(`Inventory refresh failed: ${(err as Error).message}`);
            await this.setConnected(false, (err as Error).message);
        }
    }

    private async refreshStatus(): Promise<void> {
        if (!this.client) return;
        try {
            const displays = await this.client.listDisplays();

            for (const entry of this.groupIndex.values()) {
                const inGroup = await this.client.listDisplaysInGroup(entry.displayGroupId);
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

            await this.setState("inventory.displaysJson", { val: JSON.stringify(displays), ack: true });
            await this.setConnected(true);
        } catch (err) {
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
            case "refresh":
                await this.refreshInventory();
                await this.refreshStatus();
                break;

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
