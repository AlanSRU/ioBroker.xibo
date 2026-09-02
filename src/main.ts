import * as utils from '@iobroker/adapter-core';
import { XiboClient } from './lib/xibo-client';
import type { StateDefinition, XiboConfig, XiboDisplayGroup } from './lib/xibo-types';
import {
    CHANNEL_DEFINITIONS,
    conditionAction,
    describeWrite,
    DISPLAY_GROUP_STATE_SUFFIXES,
    evaluateHealth,
    chooseGroupBranch,
    groupRenameAction,
    inventoryStateDefinitions,
    parseDurationSeconds,
    sanitizeId,
    STATE_DEFINITIONS,
} from './lib/xibo-types';
import type { CollectionDefinition } from './lib/xibo-collections';
import { COLLECTIONS, collectionRows, collectionStateIds, selectedCollections } from './lib/xibo-collections';

/**
 * A string field out of a caller's payload.
 *
 * `String({})` is `"[object Object]"`, so coercing a `method` or `path` that
 * arrived as an object produced a request the caller never asked for rather
 * than an error naming the field.
 *
 */
function requireText(value: unknown, field: string, fallback: string): string {
    if (value === undefined || value === null) {
        return fallback;
    }
    if (typeof value !== 'string') {
        throw new Error(`"${field}" must be a string, got ${Array.isArray(value) ? 'an array' : typeof value}`);
    }
    return value;
}

/**
 * Keeps a configured number inside sane bounds, falling back when unusable.
 *
 */
function clamp(value: unknown, min: number, max: number, fallback: number): number {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) {
        return fallback;
    }
    return Math.min(max, Math.max(min, n));
}

interface GroupIndexEntry {
    objectId: string;
    displayGroupId: number;
    /**
     * The CMS's own name for the group, as of the last sync, mirrored into
     * `native.displayGroup`.
     *
     * Kept separately from the channel's label because the two answer
     * different questions. Comparing the CMS name against the *label* made a
     * user's own rename in admin indistinguishable from a rename in Xibo, so
     * renaming the channel got it silently reverted on the next restart, with
     * an info line claiming a CMS rename that never happened. Undefined on a
     * branch created before this was recorded.
     */
    cmsName: string | undefined;
    /** The channel's `common.name`, which the user may have changed. */
    channelName: string;
}

/** A `displayGroups.<x>` channel found in the object tree at startup. */
interface GroupCandidate {
    objectId: string;
    cmsName: string | undefined;
    channelName: string;
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
    /** Conditions already reported, so a standing failure is not logged every poll. */
    private reportedConditions = new Map<string, string>();
    /** Display group id -> where it lives in the object tree. */
    private groupIndex = new Map<number, GroupIndexEntry>();
    /** Branches found at startup, until a CMS group claims one. */
    private groupCandidates = new Map<number, GroupCandidate[]>();
    private layoutFolderId: number | null = null;
    /** Whether the configured layout folder has been resolved once already. */
    private layoutFolderChecked = false;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'xibo' });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    private get settings(): XiboConfig {
        const c = this.config as unknown as Partial<XiboConfig>;
        return {
            url: (c.url ?? '').trim(),
            clientId: (c.clientId ?? '').trim(),
            clientSecret: (c.clientSecret ?? '').trim(),
            // Clamped at both ends in code, not just in the admin UI: an
            // instance object can be written by a restored backup or a script,
            // and a value at or above 2^31 makes Node fall back to a 1 ms timer
            // — which would poll the CMS continuously, or abort every request
            // before it could answer.
            inventoryPollInterval: clamp(c.inventoryPollInterval, 30_000, 86_400_000, 300_000),
            statusPollInterval: clamp(c.statusPollInterval, 5_000, 3_600_000, 30_000),
            requestTimeout: clamp(c.requestTimeout, 2_000, 120_000, 30_000),
            layoutFolder: (c.layoutFolder ?? '').trim(),
            defaultChangeDuration: Math.max(0, Number(c.defaultChangeDuration) || 0),
            // An unset or empty selection means the defaults, not nothing: an
            // instance upgrading from 0.2.0 has no such setting, and mirroring
            // nothing would empty the three states its scripts already read.
            inventoryCollections: selectedCollections(
                (this.config as unknown as { inventoryCollections?: unknown }).inventoryCollections,
            ).map(collection => collection.key),
            // Defaults to `schedule` because it is the mode that works on any
            // player: a schedule is honoured universally, whereas the XMR
            // action is silently ignored by players that do not implement it.
            // `action` is the optimisation, not the safe choice.
            layoutPlayMode: c.layoutPlayMode === 'action' ? 'action' : 'schedule',
            schedulePriority: clamp(c.schedulePriority, 1, 1000, 10),
        };
    }

    private async onReady(): Promise<void> {
        await this.createStateStructure();
        // Before any poll, so a group renamed in the CMS while the instance was
        // down is recognised as the branch it already has rather than given a
        // second one.
        await this.seedGroupIndex();

        const config = this.settings;
        await this.setState('info.cmsUrl', { val: config.url, ack: true });

        if (!config.url || !config.clientId || !config.clientSecret) {
            this.log.error('CMS URL, client id and client secret are all required — configure the instance.');
            this.inventoryError = 'Not configured';
            await this.publishHealth();
            return;
        }

        this.client = new XiboClient(config, this.log);

        await this.subscribeStatesAsync('commands.*');
        await this.subscribeStatesAsync('displayGroups.*');

        // Each pass re-arms itself when it finishes, so a slow CMS delays the
        // next poll rather than stacking a second one on top of it. With
        // setInterval a pass that outlives its interval overlaps the next, and
        // the pile-up grows for as long as the CMS is unwell.
        void this.pollInventory();
        void this.pollStatus();
    }

    private async pollInventory(): Promise<void> {
        const ok = await this.refreshInventory();
        if (this.unloaded) {
            return;
        }

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
        if (this.unloaded) {
            return;
        }
        this.statusTimer = this.setTimeout(() => void this.pollStatus(), this.settings.statusPollInterval);
    }

    private onUnload(callback: () => void): void {
        try {
            // First, so a poll already past its own guard stops before it
            // writes state or dereferences a cleared client.
            this.unloaded = true;
            if (this.inventoryTimer) {
                this.clearTimeout(this.inventoryTimer);
            }
            if (this.statusTimer) {
                this.clearTimeout(this.statusTimer);
            }
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
        // extendObject, not setObjectNotExists: the latter never rewrites an
        // object that already exists, so a corrected name, role, type or def
        // would reach only fresh installations and every existing instance
        // would keep the old definition for ever — with nothing in the code,
        // the tests or repochecker showing it. This release renames the
        // `inventory` channel and three count labels, which is exactly that
        // situation. Merging leaves user-owned `common.custom` (history and
        // InfluxDB settings) alone.
        for (const channel of CHANNEL_DEFINITIONS) {
            await this.extendObjectAsync(channel.id, {
                type: 'channel',
                common: { name: channel.name },
                native: {},
            });
        }

        const mirrored = this.mirroredCollections();
        const states: StateDefinition[] = [...STATE_DEFINITIONS, ...inventoryStateDefinitions(mirrored)];
        for (const state of states) {
            await this.extendObjectAsync(state.id, {
                type: 'state',
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

    /**
     * Whether one collection is mirrored, for the writers outside the mirror pass.
     *
     */
    private isMirrored(key: string): boolean {
        return this.mirroredCollections().some(collection => collection.key === key);
    }

    /**
     * Removes the inventory states of collections no longer selected.
     *
     * Without this, unticking a collection leaves its last value behind for
     * ever — a stale count and a stale JSON blob that look live, with nothing
     * to say they stopped being updated. Only states this adapter generates
     * are considered, so nothing outside `inventory.` is ever touched.
     *
     */
    private async pruneDeselectedCollections(mirrored: CollectionDefinition[]): Promise<void> {
        const keep = new Set(mirrored.flatMap(c => Object.values(collectionStateIds(c))));
        for (const collection of COLLECTIONS) {
            for (const id of Object.values(collectionStateIds(collection))) {
                if (keep.has(id)) {
                    continue;
                }
                if (!(await this.objectExists(id))) {
                    continue;
                }
                await this.delObjectAsync(id);
                this.log.debug(`Removed ${id}: its collection is no longer mirrored`);
            }
        }
    }

    /**
     * Rebuilds the group index from the channels already in the object tree.
     *
     * The branch id is folded from the CMS name, so without this a group
     * renamed in Xibo got a *second* branch on the next restart while the old
     * one stayed behind for ever, frozen at its last counts and looking live —
     * and a StreamDeck button still writing the old
     * `displayGroups.<old name>.playLayoutId` found a state that existed and
     * looked healthy while nothing happened. Matching on the CMS id kept in
     * `native` means a rename keeps its branch, and the deck binding keeps
     * working.
     */
    private async seedGroupIndex(): Promise<void> {
        const channels = await this.getAdapterObjectsAsync();
        for (const [fullId, object] of Object.entries(channels)) {
            if (object?.type !== 'channel') {
                continue;
            }
            const objectId = fullId.slice(`${this.namespace}.`.length);
            if (!objectId.startsWith('displayGroups.') || objectId.split('.').length !== 2) {
                continue;
            }
            const native = object.native as { displayGroupId?: unknown; displayGroup?: unknown };
            const displayGroupId = Number(native?.displayGroupId);
            if (!Number.isFinite(displayGroupId)) {
                continue;
            }
            // Every candidate, not the first: 0.2.0 created a second branch
            // after a CMS rename and both carry the same displayGroupId, so
            // taking whichever the database happened to return first adopted
            // the older, dead branch and left the one a deck had been rebound
            // to unindexed — where every press failed with "not in the CMS any
            // more", which was untrue. The CMS name decides instead, and only
            // `ensureGroupObject` knows it.
            const candidates = this.groupCandidates.get(displayGroupId) ?? [];
            candidates.push({
                objectId,
                cmsName: typeof native?.displayGroup === 'string' ? native.displayGroup : undefined,
                channelName: typeof object.common?.name === 'string' ? object.common.name : objectId,
            });
            this.groupCandidates.set(displayGroupId, candidates);
        }
    }

    /**
     * Adopts the branch that belongs to a CMS group, out of what the tree has.
     *
     * Preference order: the branch whose recorded CMS name still matches, then
     * the one whose id is what this group's name folds to, then the first.
     * Anything not adopted is zeroed so a leftover from an older version reads
     * as empty rather than sitting frozen and looking live.
     */
    private async adoptGroupBranch(group: XiboDisplayGroup): Promise<GroupIndexEntry | null> {
        const candidates = this.groupCandidates.get(group.displayGroupId);
        this.groupCandidates.delete(group.displayGroupId);
        if (!candidates || candidates.length === 0) {
            return null;
        }

        const folded = `displayGroups.${sanitizeId(group.displayGroup)}`;
        const chosen = chooseGroupBranch(candidates, group.displayGroup, folded)!;

        for (const other of candidates) {
            if (other.objectId === chosen.objectId) {
                continue;
            }
            this.log.warn(
                `Display group ${group.displayGroupId} has more than one branch: using ${chosen.objectId} ` +
                    `and zeroing ${other.objectId}, which an older version left behind. Delete it once ` +
                    `nothing points at it.`,
            );
            await this.zeroGroupStates(other.objectId);
        }

        const entry: GroupIndexEntry = {
            objectId: chosen.objectId,
            displayGroupId: group.displayGroupId,
            cmsName: chosen.cmsName,
            channelName: chosen.channelName,
        };
        this.groupIndex.set(group.displayGroupId, entry);
        return entry;
    }

    /** Makes a branch read as empty rather than frozen at its last values. */
    private async zeroGroupStates(objectId: string): Promise<void> {
        for (const [id, val] of [
            ['displayCount', 0],
            ['displaysOnline', 0],
            ['currentLayout', ''],
        ] as Array<[string, number | string]>) {
            if (await this.objectExists(`${objectId}.${id}`)) {
                await this.setState(`${objectId}.${id}`, { val, ack: true });
            }
        }
    }

    private async ensureGroupObject(group: XiboDisplayGroup): Promise<GroupIndexEntry> {
        const existing = this.groupIndex.get(group.displayGroupId) ?? (await this.adoptGroupBranch(group));
        if (existing) {
            // A group renamed in the CMS keeps its branch — moving it would
            // break every deck button bound to the old id — but the name of
            // record has to follow, or the tree asserts the old one for ever.
            //
            // Compared against the CMS name in `native`, never against the
            // channel's label: the label is the user's to change, and
            // comparing it made a rename in admin look exactly like a rename
            // in Xibo, so the adapter reverted the user's own name on the next
            // restart and logged a CMS rename that never happened.
            if (existing.cmsName !== group.displayGroup) {
                // Undefined means a branch from before the CMS name was
                // recorded. Nothing is known about whether the label was ever
                // the CMS's, so it is left alone and only the record is filled
                // in — silently, since no rename has been observed.
                const { firstRecord, userRenamed, updateLabel } = groupRenameAction(existing, group.displayGroup);
                if (!firstRecord) {
                    this.log.info(
                        `Display group ${group.displayGroupId} was renamed in the CMS to ` +
                            `"${group.displayGroup}"; keeping its branch at ${existing.objectId} so ` +
                            `existing bindings keep working` +
                            `${userRenamed ? ', and leaving your own channel name alone' : ''}.`,
                    );
                }
                // The full object, not just the parts that changed:
                // extendObject creates when the object is missing rather than
                // failing, so a partial one would create a typeless channel
                // with no displayGroupId for seedGroupIndex to find next time.
                // The merge is `extend(true, old, new)`, so naming `native`
                // cannot lose anything an existing object already has.
                await this.extendObjectAsync(existing.objectId, {
                    type: 'channel',
                    ...(updateLabel ? { common: { name: group.displayGroup } } : {}),
                    native: { displayGroupId: group.displayGroupId, displayGroup: group.displayGroup },
                });
                if (updateLabel) {
                    existing.channelName = group.displayGroup;
                }
                existing.cmsName = group.displayGroup;
            }
            return existing;
        }

        // Two groups can fold to the same id, so a collision falls back to the
        // CMS id rather than silently overwriting the first one's states.
        let objectId = `displayGroups.${sanitizeId(group.displayGroup)}`;
        const clash = [...this.groupIndex.values()].some(g => g.objectId === objectId);
        if (clash) {
            objectId = `${objectId}_${group.displayGroupId}`;
        }

        // The one object deliberately left as setObjectNotExists: this channel
        // is named after the CMS display group, and a user may well have
        // renamed it in admin. Extending it would overwrite that on every
        // start.
        await this.setObjectNotExistsAsync(objectId, {
            type: 'channel',
            common: { name: group.displayGroup },
            native: { displayGroupId: group.displayGroupId, displayGroup: group.displayGroup },
        });

        for (const suffix of DISPLAY_GROUP_STATE_SUFFIXES) {
            await this.extendObjectAsync(`${objectId}.${suffix.id}`, {
                type: 'state',
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

        const entry: GroupIndexEntry = {
            objectId,
            displayGroupId: group.displayGroupId,
            cmsName: group.displayGroup,
            channelName: group.displayGroup,
        };
        this.groupIndex.set(group.displayGroupId, entry);
        return entry;
    }

    // ------------------------------------------------------------ polling

    /**
     * Reports a condition once, not on every poll.
     *
     * Several of the failures here are permanent and expected: a Xibo
     * application scoped without Layout access answers 403 on `/layout` for
     * ever, and an estate that has never used menu boards answers 403 there
     * for ever. Logged per pass, that put the same line in the log 288 times a
     * day and re-raised admin's "errors in the log" notice every five minutes,
     * for a condition the adapter deliberately treats as survivable. The
     * folder lookup already had this latch; the pollers did not.
     *
     * The first occurrence is logged at its real level, an unchanged repeat
     * goes to debug, a *changed* message is reported afresh, and recovery is
     * logged so the log says when it stopped rather than just going quiet.
     *
     */
    private reportCondition(key: string, message: string | null, level: 'warn' | 'error' = 'warn'): void {
        const previous = this.reportedConditions.get(key);
        switch (conditionAction(previous, message)) {
            case 'recovered':
                this.reportedConditions.delete(key);
                this.log.info(`${key}: recovered`);
                return;
            case 'suppress':
                this.log.debug(`${key} (still failing): ${message}`);
                return;
            case 'report':
                this.reportedConditions.set(key, message!);
                this.log[level](message!);
                return;
            default:
                return;
        }
    }

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
        if (this.unloaded) {
            return;
        }
        const { connected, lastError } = evaluateHealth({
            statusEverSucceeded: this.statusEverSucceeded,
            statusFailures: this.statusFailures,
            statusError: this.statusError,
            inventoryError: this.inventoryError,
        });
        await this.setState('info.connection', { val: connected, ack: true });
        await this.setState('info.lastError', { val: lastError, ack: true });
    }

    /** Returns whether the refresh succeeded, so the caller can back off. */
    private async refreshInventory(): Promise<boolean> {
        if (!this.client || this.unloaded) {
            return false;
        }
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
            if (this.unloaded) {
                return false;
            }
            const pickable = groups.filter(g => g.isDisplaySpecific !== 1);

            for (const group of pickable) {
                if (this.unloaded) {
                    return false;
                }
                await this.ensureGroupObject(group);
            }
            if (this.unloaded) {
                return false;
            }
            await this.retireMissingGroups(pickable);
            if (this.unloaded) {
                return false;
            }

            // The three above are already in hand — and each was fetched in a
            // way the generic path could not reproduce: display groups are
            // filtered to the pickable ones, and layouts may be scoped to a
            // folder subtree. Reusing them keeps the request count the same as
            // 0.2.0 for anyone who mirrors only these three.
            const prefetched = new Map<string, unknown[]>([
                ['displayGroups', pickable],
                ['displays', displays],
                ['layouts', layouts],
            ]);
            await this.mirrorCollections(prefetched);
            if (this.unloaded) {
                return false;
            }

            await this.setState('info.lastSync', { val: new Date().toISOString(), ack: true });
            this.inventoryError = null;
            this.reportCondition('inventory', null);
            await this.publishHealth();
            return true;
        } catch (err) {
            if (this.unloaded) {
                return false;
            }
            this.reportCondition('inventory', `Inventory refresh failed: ${(err as Error).message}`, 'error');
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
    /**
     * Stops reporting on display groups the CMS no longer has.
     *
     * The branch is left in place — deleting it would take a deck button's
     * state out from under it with no warning — but it is zeroed once and
     * dropped from the index, so it reads as empty rather than sitting frozen
     * at its last counts looking live. A write to it then fails visibly
     * through `handleGroupWrite`, and if the group comes back the next refresh
     * adopts the same branch again.
     *
     */
    private async retireMissingGroups(present: XiboDisplayGroup[]): Promise<void> {
        if (present.length === 0 && this.groupIndex.size > 0) {
            // Every group disappearing at once is far more likely a changed
            // application scope, or a CMS that answered an empty list, than a
            // real deletion of the whole estate — and zeroing the lot would
            // take every deck button down with it.
            this.reportCondition(
                'displayGroups',
                `The CMS reported no display groups, but ${this.groupIndex.size} are known. ` +
                    `Keeping them rather than retiring all of them; check the application's permissions.`,
            );
            return;
        }
        this.reportCondition('displayGroups', null);

        const live = new Set(present.map(g => g.displayGroupId));
        for (const [displayGroupId, entry] of [...this.groupIndex.entries()]) {
            if (live.has(displayGroupId)) {
                continue;
            }
            if (this.unloaded) {
                return;
            }
            this.log.warn(
                `Display group ${displayGroupId} ("${entry.cmsName ?? entry.objectId}") is no longer in the CMS. ` +
                    `Its states under ${entry.objectId} are zeroed and will stop updating.`,
            );
            await this.zeroGroupStates(entry.objectId);
            this.groupIndex.delete(displayGroupId);
        }
    }

    private async mirrorCollections(prefetched: Map<string, unknown[]>): Promise<void> {
        const client = this.client;
        if (!client) {
            return;
        }

        const failed: string[] = [];
        for (const collection of this.mirroredCollections()) {
            if (this.unloaded) {
                return;
            }
            const ids = collectionStateIds(collection);
            try {
                const rows =
                    prefetched.get(collection.key) ??
                    collectionRows(collection, await client.listCollection(collection.path));
                if (this.unloaded) {
                    return;
                }
                await this.setState(ids.json, { val: JSON.stringify(rows), ack: true });
                await this.setState(ids.count, { val: rows.length, ack: true });
            } catch (err) {
                failed.push(`${collection.key} (${(err as Error).message})`);
            }
        }

        // Left as they were rather than zeroed: a collection that could not be
        // read is not a collection that became empty, and writing 0 would tell
        // every script exactly the wrong thing.
        this.reportCondition(
            'collections',
            failed.length > 0 ? `Could not mirror ${failed.length} collection(s): ${failed.join('; ')}` : null,
        );
    }

    private async refreshStatus(): Promise<void> {
        if (!this.client || this.unloaded) {
            return;
        }
        try {
            const client = this.client;
            const displays = await client.listDisplays();
            if (this.unloaded) {
                return;
            }

            for (const entry of this.groupIndex.values()) {
                // Captured above: `this.client` is cleared on unload, and this
                // loop can be mid-await when that happens.
                if (this.unloaded) {
                    return;
                }
                const inGroup = await client.listDisplaysInGroup(entry.displayGroupId);
                if (this.unloaded) {
                    return;
                }
                const online = inGroup.filter(d => d.loggedIn === 1);

                await this.setState(`${entry.objectId}.id`, { val: entry.displayGroupId, ack: true });
                await this.setState(`${entry.objectId}.name`, { val: entry.cmsName ?? '', ack: true });
                await this.setState(`${entry.objectId}.displayCount`, { val: inGroup.length, ack: true });
                await this.setState(`${entry.objectId}.displaysOnline`, { val: online.length, ack: true });
                await this.setState(`${entry.objectId}.currentLayout`, {
                    val: inGroup[0]?.currentLayout ?? '',
                    ack: true,
                });
            }

            if (this.unloaded) {
                return;
            }
            // Only when `displays` is actually mirrored. Writing it regardless
            // resurrected the value 30 seconds after `pruneDeselectedCollections`
            // had deleted the object, leaving an orphan that kept updating and
            // looked live — so the collection could not in fact be turned off.
            if (this.isMirrored('displays')) {
                await this.setState('inventory.displaysJson', { val: JSON.stringify(displays), ack: true });
            }
            this.statusFailures = 0;
            this.statusEverSucceeded = true;
            this.statusError = null;
            this.reportCondition('status', null);
            await this.publishHealth();
        } catch (err) {
            if (this.unloaded) {
                return;
            }
            this.statusFailures++;
            this.statusError = (err as Error).message;
            this.reportCondition('status', `Status refresh failed: ${(err as Error).message}`);
            this.log.debug(`Status refresh failures in a row: ${this.statusFailures}`);
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
     *
     */
    private async onMessage(obj: ioBroker.Message): Promise<void> {
        const reply = (payload: unknown): void => {
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, payload, obj.callback);
            }
        };

        if (obj.command !== 'api') {
            this.log.warn(`Unknown message command "${obj.command}"`);
            reply({ ok: false, error: `Unknown command "${obj.command}". The only one is "api".` });
            return;
        }
        if (!this.client) {
            reply({ ok: false, error: 'Not connected to a CMS — the instance is not configured.' });
            return;
        }

        const message = (typeof obj.message === 'object' && obj.message !== null ? obj.message : {}) as {
            method?: unknown;
            path?: unknown;
            params?: unknown;
        };

        try {
            const method = requireText(message.method, 'method', 'GET');
            const path = requireText(message.path, 'path', '');
            const params = (
                typeof message.params === 'object' && message.params !== null ? message.params : {}
            ) as Record<string, unknown>;
            const result = await this.client.call(method, path, params);
            this.log.debug(`api ${method} ${path}`);
            reply({ ok: true, result });
        } catch (err) {
            const error = (err as Error).message;
            this.log.warn(`api call failed: ${error}`);
            if (!obj.callback) {
                this.log.warn('The caller sent no callback, so it will never see that error.');
            }
            reply({ ok: false, error });
        }
    }

    // ------------------------------------------------------------ commands

    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        // ack:true is the adapter's own write coming back; only un-acked writes
        // are commands from somewhere else.
        if (!state || state.ack || !this.client) {
            return;
        }

        const local = id.slice(`${this.namespace}.`.length);

        try {
            if (local.startsWith('commands.')) {
                await this.handleCommand(local.slice('commands.'.length), state.val);
                return;
            }
            if (local.startsWith('displayGroups.')) {
                await this.handleGroupWrite(local, state.val);
                return;
            }
        } catch (err) {
            this.log.error(`${local} failed: ${(err as Error).message}`);
            // Named the same way the success paths name it, so a caller keyed
            // on `command` sees its failures as well as its successes.
            const { command, payload } = describeWrite(local, state.val);
            await this.recordResult(command, payload, false, (err as Error).message);
        }
    }

    private parsePayload(value: unknown): Record<string, unknown> {
        if (typeof value !== 'string' || value.trim().length === 0) {
            return {};
        }
        try {
            const parsed = JSON.parse(value);
            return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
        } catch {
            throw new Error(`Payload is not valid JSON: ${String(value).slice(0, 120)}`);
        }
    }

    private requireNumber(payload: Record<string, unknown>, key: string): number {
        const value = Number(payload[key]);
        if (!Number.isFinite(value)) {
            throw new Error(`"${key}" is required and must be a number`);
        }
        return value;
    }

    /**
     * The requested duration in seconds, or the configured default.
     *
     */
    private durationSeconds(payload: Record<string, unknown>): number {
        return parseDurationSeconds(payload.duration, this.settings.defaultChangeDuration);
    }

    private async handleCommand(command: string, value: unknown): Promise<void> {
        const payload = command === 'refresh' ? {} : this.parsePayload(value);

        switch (command) {
            case 'refresh': {
                // Both swallow their own errors, so the outcome has to be taken
                // from the return value — otherwise a refresh against an
                // unreachable CMS records ok:true and anything gating on that
                // believes it worked.
                const ok = await this.refreshInventory();
                await this.refreshStatus();
                if (!ok) {
                    await this.recordResult(command, payload, false, 'Inventory refresh failed — see info.lastError');
                    await this.setState('commands.refresh', { val: false, ack: true });
                    return;
                }
                break;
            }

            case 'changeLayout':
                await this.playLayout(
                    this.requireNumber(payload, 'displayGroupId'),
                    this.requireNumber(payload, 'layoutId'),
                    this.durationSeconds(payload),
                );
                break;

            case 'overlayLayout':
                // Refused rather than attempted: `schedule` mode exists because
                // the players in use ignore XMR actions, and those same players
                // render no overlay at all, by either route. Posting the action
                // would report success and show nothing.
                if (this.settings.layoutPlayMode === 'schedule') {
                    throw new Error(
                        'overlayLayout needs a player that implements XMR overlays. This instance is in ' +
                            'schedule mode, which exists for players that do not — use changeLayout instead.',
                    );
                }
                await this.client!.overlayLayout(
                    this.requireNumber(payload, 'displayGroupId'),
                    this.requireNumber(payload, 'layoutId'),
                    this.durationSeconds(payload),
                );
                break;

            case 'revertToSchedule':
                await this.revertGroup(this.requireNumber(payload, 'displayGroupId'));
                break;

            case 'collectNow':
                await this.client!.collectNow(this.requireNumber(payload, 'displayGroupId'));
                break;

            case 'api': {
                // The response body goes to lastResult, since a state cannot
                // hand anything back to whoever wrote it. sendTo can, and the
                // state's own description points there.
                const params =
                    typeof payload.params === 'object' && payload.params !== null
                        ? (payload.params as Record<string, unknown>)
                        : {};
                const result = await this.client!.call(
                    requireText(payload.method, 'method', 'GET'),
                    requireText(payload.path, 'path', ''),
                    params,
                );
                await this.recordResult(command, payload, true, undefined, result);
                await this.setState('commands.api', { val: '', ack: true });
                return;
            }

            default:
                // lastResult is written by the adapter, so it lands here on its
                // own un-acked writes; anything else is a caller's mistake.
                if (command !== 'lastResult') {
                    this.log.warn(`Unknown command "${command}"`);
                }
                return;
        }

        await this.recordResult(command, payload, true);
        // Cleared so an identical follow-up request still triggers a change.
        await this.setState(`commands.${command}`, { val: command === 'refresh' ? false : '', ack: true });
    }

    private async handleGroupWrite(local: string, value: unknown): Promise<void> {
        const [, groupSegment, suffix] = local.split('.');
        const entry = [...this.groupIndex.values()].find(g => g.objectId === `displayGroups.${groupSegment}`);
        if (!entry) {
            // Thrown, not warned: the caller is a deck button whose state still
            // exists, so returning quietly left it looking healthy while the
            // wall never changed. The throw reaches onStateChange's catch,
            // which records ok:false in commands.lastResult.
            throw new Error(
                `Display group "${groupSegment}" is not in the CMS any more, so nothing was played. ` +
                    `Check the display group still exists and that the inventory has refreshed.`,
            );
        }

        if (suffix === 'playLayoutId') {
            const layoutId = Number(value);
            if (!Number.isFinite(layoutId) || layoutId <= 0) {
                throw new Error(`playLayoutId must be a positive layout id, got ${String(value)}`);
            }
            await this.playLayout(entry.displayGroupId, layoutId, this.settings.defaultChangeDuration);
            await this.setState(local, { val: layoutId, ack: true });
            await this.recordResult('playLayoutId', { displayGroupId: entry.displayGroupId, layoutId }, true);
            return;
        }

        if (suffix === 'revert') {
            await this.revertGroup(entry.displayGroupId);
            await this.setState(local, { val: false, ack: true });
            await this.recordResult('revert', { displayGroupId: entry.displayGroupId }, true);
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
     *
     */
    private async playLayout(displayGroupId: number, layoutId: number, duration: number): Promise<void> {
        const { layoutPlayMode, schedulePriority } = this.settings;
        if (layoutPlayMode === 'action') {
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
     *
     */
    private async revertGroup(displayGroupId: number): Promise<void> {
        const { layoutPlayMode, schedulePriority } = this.settings;
        if (layoutPlayMode === 'action') {
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
        await this.setState('commands.lastResult', {
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
