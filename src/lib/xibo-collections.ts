/**
 * The CMS collections the adapter mirrors into `inventory.*`.
 *
 * Every entry was checked against a live 4.5.1 rather than taken from the
 * OpenAPI document, because several of them do not answer what the document
 * implies — see `campaigns` in particular.
 */

export interface CollectionDefinition {
    /** Object id under `inventory.`, used for `<key>Json` and `<key>Count`. */
    key: string;
    /**
     * Overrides the `<key>Count` state id.
     *
     * The three collections 0.2.0 already exposed use singular count ids
     * (`displayGroupCount`, not `displayGroupsCount`). Generating the plural
     * form would leave every existing instance with its old state orphaned
     * and a new empty one beside it, so those three keep the ids they have.
     */
    countKey?: string;
    /** Human name, used for both states' `common.name`. */
    name: string;
    /** Path and query exactly as the CMS needs it to answer truthfully. */
    path: string;
    /**
     * Whether this collection is mirrored unless the user says otherwise.
     *
     * Off for anything large enough to make a state unwieldy, and for
     * anything holding personal data — see {@link PERSONAL_DATA_KEYS}.
     */
    defaultOn: boolean;
    /** Where the rows sit when the response is not a bare array. */
    rowsAt?: string;
    /** Why this collection is off by default, when it is. */
    note?: string;
}

/**
 * Collections that contain personal data about real people.
 *
 * Mirroring these into the object tree copies names and email addresses out of
 * the CMS's own access control and into a state any script or VIS view can
 * read, so they are off unless asked for. The API passthrough still reaches
 * them, which is the right place for an occasional administrative query.
 */
export const PERSONAL_DATA_KEYS = ["users", "userGroups", "sessions"] as const;

export const COLLECTIONS: CollectionDefinition[] = [
    // ---- the three the adapter has always mirrored, with their original ids
    { key: "displayGroups", countKey: "displayGroupCount", name: "Display groups", path: "/displaygroup", defaultOn: true },
    { key: "displays", countKey: "displayCount", name: "Displays", path: "/display", defaultOn: true },
    { key: "layouts", countKey: "layoutCount", name: "Layouts", path: "/layout", defaultOn: true },

    /**
     * `/campaign` with no query returns an empty array on a CMS holding ten
     * campaigns.
     *
     * Every layout has its own single-layout campaign, and the default filter
     * excludes exactly those — so the honest-looking `/campaign` reports "no
     * campaigns" while `isLayoutSpecific=1` returns all ten. Verified against
     * a live 4.5.1: `/campaign` and `?isLayoutSpecific=0` both gave 0,
     * `?isLayoutSpecific=1` and `?isLayoutSpecific=-1` both gave 10. `-1`
     * means "either", which is the only value that cannot silently under-report
     * once someone adds a real multi-layout campaign.
     */
    { key: "campaigns", name: "Campaigns", path: "/campaign?isLayoutSpecific=-1", defaultOn: true },

    { key: "playlists", name: "Playlists", path: "/playlist", defaultOn: true },
    { key: "datasets", name: "Datasets", path: "/dataset", defaultOn: true },
    { key: "templates", name: "Layout templates", path: "/template", defaultOn: true },
    { key: "tags", name: "Tags", path: "/tag", defaultOn: true },
    { key: "resolutions", name: "Resolutions", path: "/resolution", defaultOn: true },
    { key: "displayProfiles", name: "Display profiles", path: "/displayprofile", defaultOn: true },
    { key: "dayParts", name: "Day parts", path: "/daypart", defaultOn: true },
    { key: "folders", name: "Folder tree", path: "/folders", defaultOn: true },
    { key: "cmsCommands", name: "CMS commands", path: "/command", defaultOn: true },
    { key: "syncGroups", name: "Sync groups", path: "/syncgroups", defaultOn: true },
    { key: "menuBoards", name: "Menu boards", path: "/menuboards", defaultOn: true },
    { key: "notifications", name: "Notifications", path: "/notification", defaultOn: true },
    { key: "playerVersions", name: "Player software versions", path: "/playersoftware", defaultOn: true },

    // ---- off by default: large
    {
        key: "library",
        name: "Media library",
        path: "/library",
        defaultOn: false,
        note: "One row per media item; a real estate holds thousands, which makes a single state unwieldy.",
    },
    {
        key: "modules",
        name: "Widget modules",
        path: "/module",
        defaultOn: false,
        note: "47 rows of static CMS capability on a stock 4.5.1, which change only when the CMS is upgraded.",
    },
    {
        key: "venues",
        name: "Display venues",
        path: "/displayvenue",
        defaultOn: false,
        note: "A fixed CMS lookup list of 99 venue types; it never changes at runtime.",
    },

    // ---- off by default: personal data
    {
        key: "users",
        name: "CMS users",
        path: "/user",
        defaultOn: false,
        note: "Holds names and email addresses of real people.",
    },
    {
        key: "userGroups",
        name: "CMS user groups",
        path: "/group",
        defaultOn: false,
        note: "Names the groups people belong to.",
    },
    {
        key: "sessions",
        name: "Active CMS sessions",
        path: "/sessions",
        defaultOn: false,
        note: "Shows who is signed in to the CMS, with their IP address.",
    },
];

/** The keys mirrored when the instance has never been configured. */
export const DEFAULT_COLLECTION_KEYS: string[] = COLLECTIONS.filter((c) => c.defaultOn).map((c) => c.key);

/** The `inventory.` state ids one collection writes. */
export function collectionStateIds(definition: CollectionDefinition): { json: string; count: string } {
    return {
        json: `inventory.${definition.key}Json`,
        count: `inventory.${definition.countKey ?? `${definition.key}Count`}`,
    };
}

/**
 * Rows out of one collection's response.
 *
 * Most answer a bare array, `/folders` answers a tree, and a few wrap the rows
 * in an object. Anything unrecognised counts as zero rows rather than throwing,
 * so one odd collection cannot fail the whole refresh.
 */
export function collectionRows(definition: CollectionDefinition, body: unknown): unknown[] {
    const source = definition.rowsAt && body && typeof body === "object"
        ? (body as Record<string, unknown>)[definition.rowsAt]
        : body;
    return Array.isArray(source) ? source : [];
}

/**
 * The collections to mirror, given what the instance is configured for.
 *
 * An unset or empty configuration means the defaults rather than nothing: an
 * instance upgrading from 0.2.0 has no such setting, and silently mirroring
 * nothing would empty the three inventory states it already relies on.
 */
export function selectedCollections(configured: unknown): CollectionDefinition[] {
    const keys = Array.isArray(configured) && configured.length > 0
        ? new Set(configured.map(String))
        : new Set(DEFAULT_COLLECTION_KEYS);
    return COLLECTIONS.filter((c) => keys.has(c.key));
}
