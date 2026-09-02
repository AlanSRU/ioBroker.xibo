import {
    AdapterLogger, XiboConfig, XiboDayPart, XiboDisplay, XiboDisplayGroup, XiboFolder, XiboLayout,
    XiboScheduleEvent,
} from "./xibo-types";

/** `eventTypeId` for a Layout event. The CMS numbers these; 1 is Layout. */
const EVENT_TYPE_LAYOUT = 1;

/**
 * How long the CMS's UTC offset is trusted before being read again.
 *
 * Short enough that a DST change costs at most one hour of wrongly-booked
 * events rather than the rest of the instance's uptime, and long enough that
 * the offset still costs about one request an hour instead of one per
 * schedule call.
 */
const CMS_OFFSET_TTL_MS = 3_600_000;

/** Methods the generic passthrough will send. See {@link XiboClient.call}. */
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "DELETE"]);

interface TokenResponse {
    access_token: string;
    expires_in: number;
}

/**
 * Minimal Xibo CMS client covering display control.
 *
 * Authentication is `client_credentials`, so the adapter acts as one
 * application rather than as a person. Folder permissions in the CMS therefore
 * do not constrain it — they govern people using the Xibo UI.
 */
export class XiboClient {
    private readonly base: string;
    private token: string | null = null;
    private tokenExpiresAt = 0;
    /** Day parts, fetched once: the ids are fixed for a given CMS. */
    private dayParts: XiboDayPart[] | null = null;
    /** Minutes to add to UTC for the CMS's wall clock, once resolved. */
    private cmsOffsetMinutes: number | null = null;
    /** When that offset stops being trusted. See {@link cmsUtcOffset}. */
    private cmsOffsetExpiresAt = 0;

    constructor(private readonly config: XiboConfig, private readonly log: AdapterLogger) {
        this.base = config.url.replace(/\/+$/, "");
    }

    private async authorize(): Promise<string> {
        // Refreshed a minute early rather than racing the expiry mid-command.
        if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;

        const res = await this.fetchWithTimeout(`${this.base}/api/authorize/access_token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "client_credentials",
                client_id: this.config.clientId,
                client_secret: this.config.clientSecret,
            }),
        });

        if (!res.ok) {
            throw new Error(
                `Xibo authentication failed (${res.status} ${res.statusText}). ` +
                    `Check the CMS URL and that the application has client_credentials enabled.`,
            );
        }
        const token = (await res.json()) as TokenResponse;
        this.token = token.access_token;
        this.tokenExpiresAt = Date.now() + token.expires_in * 1000;
        return this.token;
    }

    /**
     * A request with a deadline.
     *
     * `AbortSignal.timeout` rather than a bare `setTimeout`: this class holds no
     * adapter instance to take `this.setTimeout` from, and a framework-managed
     * timer is the wrong tool for a per-request deadline — it would outlive the
     * request it belongs to.
     */
    private fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
        return fetch(url, { ...init, signal: AbortSignal.timeout(this.config.requestTimeout) });
    }

    private async request(path: string, init: RequestInit = {}): Promise<unknown> {
        const token = await this.authorize();
        const res = await this.fetchWithTimeout(`${this.base}/api${path}`, {
            ...init,
            headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
        });

        if (!res.ok) {
            const body = (await res.text()).slice(0, 400);
            throw new Error(`Xibo ${init.method ?? "GET"} ${path} failed (${res.status} ${res.statusText}): ${body}`);
        }
        // Action endpoints answer 204 with no body; parsing that as JSON throws.
        if (res.status === 204) return null;
        const text = await res.text();
        return text.length > 0 ? JSON.parse(text) : null;
    }

    private form(values: Record<string, string | number | undefined>): {
        headers: Record<string, string>;
        body: URLSearchParams;
    } {
        const body = new URLSearchParams();
        for (const [key, value] of Object.entries(values)) {
            if (value !== undefined) body.append(key, String(value));
        }
        return { headers: { "Content-Type": "application/x-www-form-urlencoded" }, body };
    }

    // --------------------------------------------------------- generic call

    /**
     * Any CMS operation, by method and path.
     *
     * The CMS exposes 263 operations and this adapter models the few dozen a
     * venue actually drives. Hand-modelling the rest — dataset column editing,
     * widget elements, region positioning, user administration — would be
     * thousands of lines of state tree for things better done in the Xibo UI,
     * but "not modelled" should not mean "unreachable". This is the escape
     * hatch, so a script can do anything the CMS can.
     *
     * Values are sent as query parameters for GET and DELETE and as a form
     * body for POST and PUT, which is what the CMS accepts. An array becomes
     * repeated `key[]` entries — the encoding the schedule endpoints require
     * and the one thing about this API that is easy to get silently wrong.
     */
    async call(method: string, path: string, params: Record<string, unknown> = {}): Promise<unknown> {
        const verb = method.toUpperCase();
        if (!ALLOWED_METHODS.has(verb)) {
            throw new Error(`method must be one of ${[...ALLOWED_METHODS].join(", ")}, got "${method}"`);
        }
        if (!path.startsWith("/")) {
            throw new Error(`path must start with "/" and be relative to /api, got "${path}"`);
        }

        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
            if (value === undefined || value === null) continue;
            if (Array.isArray(value)) {
                for (const item of value) query.append(`${key}[]`, scalar(key, item));
            } else {
                query.append(key, scalar(key, value));
            }
        }

        if (verb === "GET" || verb === "DELETE") {
            const joined = query.toString();
            const separator = path.includes("?") ? "&" : "?";
            const withQuery = `${path}${joined ? separator + joined : ""}`;
            this.assertUnderApi(withQuery);
            return this.request(withQuery, { method: verb });
        }
        this.assertUnderApi(path);
        return this.request(path, {
            method: verb,
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: query,
        });
    }

    /**
     * Refuses a path that does not resolve to somewhere under `/api`.
     *
     * The check is on the **resolved** URL, not the string, because a
     * blacklist cannot win this one: `..` is only the most obvious spelling.
     * The WHATWG parser — which is what `fetch` itself uses to resolve this
     * URL — decodes `%2e%2e`, `%2E%2E` and `.%2e` to a double-dot segment
     * before normalising, so `/%2e%2e/%2e%2e/install/index.php` climbs out of
     * `/api` and reaches the CMS's installer with the bearer token attached.
     * A string guard looking for ".." sees nothing wrong with any of them.
     *
     * Resolving it the same way `fetch` will and then checking where it landed
     * is the only form of this check that cannot be spelled around.
     */
    private assertUnderApi(path: string): void {
        const prefix = new URL(`${this.base}/api/`);
        let resolved: URL;
        try {
            resolved = new URL(`${this.base}/api${path}`);
        } catch {
            throw new Error(`path is not a usable URL path: "${path}"`);
        }
        const underApi = resolved.origin === prefix.origin
            && (resolved.pathname === prefix.pathname.replace(/\/$/, "")
                || resolved.pathname.startsWith(prefix.pathname));
        if (!underApi) {
            throw new Error(
                `path must stay under /api, but "${path}" resolves to ${resolved.pathname} — refused`,
            );
        }
    }

    // ------------------------------------------------------------- inventory

    /** One mirrored collection, by the path its definition carries. */
    async listCollection(path: string): Promise<unknown> {
        return this.request(path);
    }

    async listDisplayGroups(): Promise<XiboDisplayGroup[]> {
        return (await this.request("/displaygroup")) as XiboDisplayGroup[];
    }

    async listDisplays(): Promise<XiboDisplay[]> {
        return (await this.request("/display")) as XiboDisplay[];
    }

    /** Displays belonging to one group, for per-group online counts. */
    async listDisplaysInGroup(displayGroupId: number): Promise<XiboDisplay[]> {
        return (await this.request(`/display?displayGroupId=${displayGroupId}`)) as XiboDisplay[];
    }

    async listLayouts(): Promise<XiboLayout[]> {
        return (await this.request("/layout")) as XiboLayout[];
    }

    /**
     * Layouts in a folder **and everything below it**.
     *
     * The CMS `folderId` filter matches that one folder exactly, so asking for
     * the root folder returns nothing when the layouts sit in per-project
     * subfolders — which is exactly how Pixelmabob files them. The subtree is
     * computed here and the layouts filtered against it.
     */
    async listLayoutsInFolderTree(path: string): Promise<XiboLayout[]> {
        const folders = await this.listFolders();
        const rootId = this.resolvePath(folders, path);
        if (rootId === null) return [];

        const wanted = new Set<number>([rootId]);
        let grew = true;
        while (grew) {
            grew = false;
            for (const folder of folders) {
                if (!wanted.has(folder.id) && wanted.has(folder.parentId)) {
                    wanted.add(folder.id);
                    grew = true;
                }
            }
        }

        const all = await this.listLayouts();
        return all.filter((l) => l.folderId !== undefined && wanted.has(l.folderId));
    }

    /** The folder tree, flattened. */
    private async listFolders(): Promise<XiboFolder[]> {
        const flat: XiboFolder[] = [];
        const walk = (nodes: unknown): void => {
            const list = typeof nodes === "string" ? safeParse(nodes) : nodes;
            if (!Array.isArray(list)) return;
            for (const node of list as XiboFolder[]) {
                flat.push(node);
                if (node.children) walk(node.children);
            }
        };
        walk(await this.request("/folders"));
        return flat;
    }

    private resolvePath(folders: XiboFolder[], path: string): number | null {
        const root = folders.find((f) => f.isRoot === 1);
        if (!root) return null;

        let parentId = root.id;
        for (const segment of path.split("/")) {
            const found = folders.find((f) => f.parentId === parentId && f.text === segment);
            if (!found) return null;
            parentId = found.id;
        }
        return parentId;
    }

    /** Folder id for a slash-separated path, or null. Creates nothing. */
    async findFolderPath(path: string): Promise<number | null> {
        return this.resolvePath(await this.listFolders(), path);
    }

    // --------------------------------------------------------------- actions

    /**
     * Plays a layout on a display group, interrupting its schedule.
     *
     * `changeMode: replace` and no duration means it stays until something else
     * changes it or the group is reverted — which is what a live operator
     * wants: what you pressed is what is showing, and it does not expire
     * halfway through a match.
     */
    async changeLayout(displayGroupId: number, layoutId: number, durationSeconds?: number): Promise<void> {
        await this.request(`/displaygroup/${displayGroupId}/action/changeLayout`, {
            method: "POST",
            ...this.form({
                layoutId,
                changeMode: "replace",
                duration: durationSeconds && durationSeconds > 0 ? durationSeconds : undefined,
                // The player fetches the layout before showing it, so a first
                // play does not flash an empty screen while it downloads.
                downloadRequired: 1,
            }),
        });
        this.log.debug(`changeLayout: layout ${layoutId} on display group ${displayGroupId}`);
    }

    /** Shows a layout on top of whatever is playing, rather than replacing it. */
    async overlayLayout(displayGroupId: number, layoutId: number, durationSeconds?: number): Promise<void> {
        await this.request(`/displaygroup/${displayGroupId}/action/overlayLayout`, {
            method: "POST",
            ...this.form({
                layoutId,
                duration: durationSeconds && durationSeconds > 0 ? durationSeconds : undefined,
                downloadRequired: 1,
            }),
        });
    }

    // ------------------------------------------------------------ scheduling

    private async listDayParts(): Promise<XiboDayPart[]> {
        if (!this.dayParts) this.dayParts = (await this.request("/daypart")) as XiboDayPart[];
        return this.dayParts;
    }

    /**
     * The id of the "always" or "custom" day part, read from the CMS.
     *
     * The CMS's own OpenAPI document says these are 0 and 1. On a real 4.5.1
     * they are 2 and 1, so hard-coding either files the event against the
     * wrong day part — which shows in the CMS as a scheduled event that simply
     * never plays.
     */
    private async dayPartId(kind: "always" | "custom"): Promise<number> {
        const parts = await this.listDayParts();
        const found = parts.find((p) => (kind === "always" ? p.isAlways === 1 : p.isCustom === 1));
        if (!found) {
            throw new Error(`The CMS has no "${kind}" day part, so a layout cannot be scheduled`);
        }
        return found.dayPartId;
    }

    /**
     * Minutes to add to UTC to get the CMS's wall clock.
     *
     * `fromDt` and `toDt` are parsed in the CMS's own timezone, and the CMS
     * rejects an ISO-8601 string carrying an offset — `Y-m-d H:i:s` is the only
     * format it accepts. So the moment has to be formatted in *its* timezone:
     * sending UTC to a CMS on BST books the event an hour in the past, where it
     * never plays and nothing reports a problem.
     *
     * `/clock` is the CMS's own answer to "what time do you think it is", which
     * is exactly the question. Cached only briefly: the offset saves a round
     * trip per schedule call, but it is not constant — it moves at every DST
     * change, and a venue instance is not restarted twice a year on cue. Held
     * indefinitely, an adapter up since summer still believes the CMS is on
     * BST in November and books every event an hour out: an hour into the
     * future in the indefinite case, so the wall does not change until long
     * after the button was pressed, or an hour into the past for a timed
     * event, whose window has then already closed and never plays. Both
     * report `ok` and log nothing, which is the whole reason this method
     * exists.
     */
    private async cmsUtcOffset(): Promise<number> {
        if (this.cmsOffsetMinutes !== null && Date.now() < this.cmsOffsetExpiresAt) {
            return this.cmsOffsetMinutes;
        }

        const clock = (await this.request("/clock")) as { time?: string } | null;
        const match = /(\d{1,2}):(\d{2})/.exec(clock?.time ?? "");
        if (!match) {
            // Treating the CMS as UTC is wrong wherever it is not, so this says
            // so rather than quietly producing events at the wrong time.
            this.log.warn(
                `Could not read the CMS clock (got ${JSON.stringify(clock?.time)}); assuming its ` +
                `timezone is UTC. A timed layout may start or end an hour out.`,
            );
            this.cmsOffsetMinutes = 0;
            this.cmsOffsetExpiresAt = Date.now() + CMS_OFFSET_TTL_MS;
            return 0;
        }

        const now = new Date();
        const cmsMinutes = Number(match[1]) * 60 + Number(match[2]);
        let delta = cmsMinutes - (now.getUTCHours() * 60 + now.getUTCMinutes());
        // The two clocks can sit either side of midnight.
        if (delta > 720) delta -= 1440;
        if (delta <= -720) delta += 1440;
        // Every real offset is a whole number of quarter hours, so rounding to
        // 15 absorbs both the minute resolution of /clock and a little skew.
        this.cmsOffsetMinutes = Math.round(delta / 15) * 15;
        this.cmsOffsetExpiresAt = Date.now() + CMS_OFFSET_TTL_MS;
        this.log.debug(`CMS clock is UTC${this.cmsOffsetMinutes >= 0 ? "+" : ""}${this.cmsOffsetMinutes} minutes`);
        return this.cmsOffsetMinutes;
    }

    /** A moment as `Y-m-d H:i:s` in the CMS's timezone — the only format it takes. */
    private async cmsDateTime(at: Date): Promise<string> {
        const shifted = new Date(at.getTime() + (await this.cmsUtcOffset()) * 60_000);
        const pad = (n: number): string => String(n).padStart(2, "0");
        return (
            `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ` +
            `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`
        );
    }

    /**
     * The campaign a layout is scheduled by.
     *
     * Every layout has its own single-layout campaign and the schedule names
     * that, not the layout. Sending a layoutId where a campaignId belongs is
     * accepted by the CMS and schedules something else entirely.
     */
    async campaignIdForLayout(layoutId: number): Promise<number> {
        const rows = (await this.request(`/layout?layoutId=${layoutId}`)) as XiboLayout[];
        const layout = Array.isArray(rows) ? rows.find((l) => l.layoutId === layoutId) : undefined;
        if (!layout) throw new Error(`Layout ${layoutId} does not exist in the CMS`);
        if (!layout.campaignId) throw new Error(`Layout ${layoutId} has no campaign, so it cannot be scheduled`);
        return layout.campaignId;
    }

    /** Layout events scheduled on one display group. */
    async listLayoutEvents(displayGroupId: number): Promise<XiboScheduleEvent[]> {
        const events = (await this.request(
            `/schedule?displayGroupIds%5B%5D=${displayGroupId}&eventTypeId=${EVENT_TYPE_LAYOUT}`,
        )) as XiboScheduleEvent[];
        return Array.isArray(events) ? events : [];
    }

    async deleteScheduleEvent(eventId: number): Promise<void> {
        await this.request(`/schedule/${eventId}`, { method: "DELETE" });
    }

    /**
     * Removes the events this adapter owns on a display group.
     *
     * Ownership is "a layout event at our priority": the CMS gives a schedule
     * event no name or tag to stamp, so the priority is the only marker
     * available, which is why it has to be one nothing else uses.
     *
     * Returns how many were removed, so a caller can report a revert that had
     * nothing to revert.
     */
    async clearScheduledLayouts(displayGroupId: number, priority: number): Promise<number> {
        const ours = (await this.listLayoutEvents(displayGroupId)).filter((e) => e.isPriority === priority);
        for (const event of ours) await this.deleteScheduleEvent(event.eventId);
        return ours.length;
    }

    /**
     * Plays a layout by scheduling it at priority, for players that ignore the
     * XMR `changeLayout` action.
     *
     * The previous event is deleted **before** the new one is created: two
     * layout events at the same priority both play, so leaving the old one
     * turns a replacement into a two-sign cycle.
     *
     * A duration becomes a custom day part bounded by `toDt`, which the player
     * enforces locally — so the sign comes down on time without needing to
     * hear from the CMS again. With no duration it is an "always" event and
     * stays until something replaces it or the group is reverted.
     */
    async scheduleLayout(
        displayGroupId: number,
        layoutId: number,
        priority: number,
        durationSeconds?: number,
    ): Promise<{ replaced: number }> {
        // Resolved first: a bad layout id should cost nothing, rather than
        // leaving the group with its previous event already deleted.
        const campaignId = await this.campaignIdForLayout(layoutId);
        const timed = durationSeconds !== undefined && durationSeconds > 0;
        const dayPartId = await this.dayPartId(timed ? "custom" : "always");
        const from = new Date();
        const fromDt = await this.cmsDateTime(from);
        const toDt = timed ? await this.cmsDateTime(new Date(from.getTime() + durationSeconds * 1000)) : undefined;

        const replaced = await this.clearScheduledLayouts(displayGroupId, priority);

        await this.request("/schedule", {
            method: "POST",
            ...this.form({
                eventTypeId: EVENT_TYPE_LAYOUT,
                campaignId,
                "displayGroupIds[]": displayGroupId,
                dayPartId,
                isPriority: priority,
                displayOrder: 0,
                fromDt,
                toDt,
            }),
        });

        // Nothing has told the player its schedule changed. `collectNow` is the
        // one XMR action our players do implement, and it is what turns this
        // from "at the next poll" into "in a few seconds".
        await this.collectNow(displayGroupId);
        this.log.debug(
            `scheduleLayout: layout ${layoutId} (campaign ${campaignId}) on display group ${displayGroupId} ` +
            `at priority ${priority}${timed ? `, until ${toDt}` : ""}, replacing ${replaced}`,
        );
        return { replaced };
    }

    async revertToSchedule(displayGroupId: number): Promise<void> {
        await this.request(`/displaygroup/${displayGroupId}/action/revertToSchedule`, { method: "POST" });
        this.log.debug(`revertToSchedule: display group ${displayGroupId}`);
    }

    async collectNow(displayGroupId: number): Promise<void> {
        await this.request(`/displaygroup/${displayGroupId}/action/collectNow`, { method: "POST" });
    }
}

/**
 * One parameter value as the CMS will receive it.
 *
 * `String({})` is `"[object Object]"`, and a form body is just text — so
 * passing an object where the CMS wants a scalar used to send the literal
 * string `[object Object]` and let the CMS decide what to make of it. That is
 * the "not reported must never become a real value" trap in its purest form:
 * a nested object is almost always a caller who meant to send its contents,
 * and silently posting a placeholder is the worst available answer. Refused
 * with the key named instead.
 *
 * Arrays are handled by the caller, which spreads them into `key[]` entries;
 * this sees only their items, which must themselves be scalar.
 */
function scalar(key: string, value: unknown): string {
    if (value === null || typeof value === "object" || typeof value === "function") {
        throw new Error(
            `parameter "${key}" must be a string, number or boolean, got ${
                Array.isArray(value) ? "a nested array" : typeof value
            } — the CMS would have received "[object Object]"`,
        );
    }
    return String(value);
}

function safeParse(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}
