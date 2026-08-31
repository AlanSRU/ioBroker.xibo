import {
    AdapterLogger, XiboConfig, XiboDisplay, XiboDisplayGroup, XiboFolder, XiboLayout,
} from "./xibo-types";

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

    // ------------------------------------------------------------- inventory

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

    async revertToSchedule(displayGroupId: number): Promise<void> {
        await this.request(`/displaygroup/${displayGroupId}/action/revertToSchedule`, { method: "POST" });
        this.log.debug(`revertToSchedule: display group ${displayGroupId}`);
    }

    async collectNow(displayGroupId: number): Promise<void> {
        await this.request(`/displaygroup/${displayGroupId}/action/collectNow`, { method: "POST" });
    }
}

function safeParse(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}
