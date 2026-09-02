import { expect } from "chai";
import {
    COLLECTIONS, DEFAULT_COLLECTION_KEYS, PERSONAL_DATA_KEYS, collectionRows, collectionStateIds,
    selectedCollections,
} from "../src/lib/xibo-collections";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const readJson = (name: string): Record<string, unknown> =>
    JSON.parse(readFileSync(path.join(__dirname, "..", name), "utf8"));
const jsonConfig = (): unknown =>
    (readJson("admin/jsonConfig.json").items as Record<string, unknown>).inventoryCollections;
const ioPackage = (): Record<string, unknown> => readJson("io-package.json");

describe("inventory collections", () => {
    it("asks for campaigns in the only way that returns any", () => {
        // `/campaign` with no query answered an empty array on a live 4.5.1
        // holding ten campaigns, because every layout's single-layout campaign
        // is excluded by the default filter. Without the query the adapter
        // reports "no campaigns" and looks perfectly healthy doing it.
        const campaigns = COLLECTIONS.find((c) => c.key === "campaigns");
        expect(campaigns, "no campaigns collection").to.not.equal(undefined);
        expect(campaigns!.path).to.contain("isLayoutSpecific=-1");
    });

    it("keeps every key unique, since each names two states", () => {
        const keys = COLLECTIONS.map((c) => c.key);
        expect(keys.length).to.equal(new Set(keys).size);
    });

    it("folds every key into a safe object id", () => {
        // These become `inventory.<key>Json`, so a key with a dot or a space
        // would build a state under a parent channel that does not exist.
        for (const c of COLLECTIONS) {
            expect(c.key, `${c.key} is not object-id safe`).to.match(/^[A-Za-z][A-Za-z0-9]*$/);
        }
    });

    it("never mirrors personal data unless it is asked for", () => {
        // These copy names, email addresses and who is signed in out of the
        // CMS's own access control and into states any script can read.
        for (const key of PERSONAL_DATA_KEYS) {
            const c = COLLECTIONS.find((x) => x.key === key);
            expect(c, `${key} is not a known collection`).to.not.equal(undefined);
            expect(c!.defaultOn, `${key} is mirrored by default`).to.equal(false);
            expect(DEFAULT_COLLECTION_KEYS).to.not.contain(key);
        }
    });

    it("explains every collection it leaves off", () => {
        for (const c of COLLECTIONS.filter((x) => !x.defaultOn)) {
            expect(c.note, `${c.key} is off by default with no reason given`).to.be.a("string");
        }
    });

    it("keeps mirroring the three collections 0.2.0 already exposed", () => {
        // An instance upgrading from 0.2.0 has no collection setting at all.
        // Treating that as "mirror nothing" would empty the three states its
        // scripts and deck buttons already read.
        for (const key of ["displayGroups", "displays", "layouts"]) {
            expect(DEFAULT_COLLECTION_KEYS).to.contain(key);
        }
    });
});

describe("selectedCollections", () => {
    it("falls back to the defaults when the setting is absent", () => {
        // An instance upgrading from 0.2.0 has no such key, and mirroring
        // nothing would empty the three states its scripts already read.
        for (const unset of [undefined, null, "not an array", 42]) {
            expect(selectedCollections(unset).map((c) => c.key)).to.deep.equal(DEFAULT_COLLECTION_KEYS);
        }
    });

    it("mirrors nothing when the list is explicitly empty", () => {
        // Conflating this with "absent" meant a user who unticked all 23
        // entries and saved still got the 17 defaults mirrored — 34 states and
        // 14 extra CMS requests every five minutes — while the config screen
        // showed nothing selected, and the help text promised the opposite.
        expect(selectedCollections([])).to.deep.equal([]);
    });

    it("honours an explicit selection, including one that drops a default", () => {
        expect(selectedCollections(["layouts"]).map((c) => c.key)).to.deep.equal(["layouts"]);
    });

    it("ignores a key that no longer exists rather than failing the refresh", () => {
        // A setting saved by a later version, or a hand-edited instance object.
        expect(selectedCollections(["layouts", "gone"]).map((c) => c.key)).to.deep.equal(["layouts"]);
    });
});

describe("collectionRows", () => {
    const bare = COLLECTIONS.find((c) => c.key === "layouts")!;

    it("reads a bare array", () => {
        expect(collectionRows(bare, [{ layoutId: 1 }, { layoutId: 2 }])).to.have.length(2);
    });

    it("counts an unexpected shape as empty rather than throwing", () => {
        // One odd collection must not fail the whole inventory refresh.
        for (const odd of [null, undefined, 42, "text", { events: [] }]) {
            expect(collectionRows(bare, odd)).to.deep.equal([]);
        }
    });

    it("reads rows out of a wrapper when one is declared", () => {
        const wrapped = { ...bare, rowsAt: "events" };
        expect(collectionRows(wrapped, { events: [{ eventId: 56 }] })).to.have.length(1);
        expect(collectionRows(wrapped, { other: [{ eventId: 56 }] })).to.deep.equal([]);
    });
});

describe("collectionStateIds", () => {
    it("keeps the count ids 0.2.0 already created", () => {
        // Generating `<key>Count` would give displayGroupsCount and leave
        // every existing instance with an orphaned displayGroupCount beside a
        // new empty one, with nothing to say the old data had moved.
        const idOf = (key: string): string =>
            collectionStateIds(COLLECTIONS.find((c) => c.key === key)!).count;
        expect(idOf("displayGroups")).to.equal("inventory.displayGroupCount");
        expect(idOf("displays")).to.equal("inventory.displayCount");
        expect(idOf("layouts")).to.equal("inventory.layoutCount");
    });

    it("keeps the JSON ids 0.2.0 already created", () => {
        const idOf = (key: string): string =>
            collectionStateIds(COLLECTIONS.find((c) => c.key === key)!).json;
        expect(idOf("displayGroups")).to.equal("inventory.displayGroupsJson");
        expect(idOf("displays")).to.equal("inventory.displaysJson");
        expect(idOf("layouts")).to.equal("inventory.layoutsJson");
    });

    it("generates both ids for everything else, with no collisions", () => {
        const ids = COLLECTIONS.flatMap((c) => Object.values(collectionStateIds(c)));
        expect(ids.length).to.equal(new Set(ids).size);
        for (const id of ids) expect(id).to.match(/^inventory\.[A-Za-z][A-Za-z0-9]*$/);
    });
});

describe("collectionRows: the folder tree", () => {
    const folders = COLLECTIONS.find((c) => c.key === "folders")!;

    /** The shape `/folders` actually answers: one root, the rest nested. */
    const live = [{
        id: 1, text: "Root Folder", parentId: 0, isRoot: 1,
        children: [{
            id: 7, text: "Pixelmabob", parentId: 1,
            children: [
                { id: 10, text: "deck-test", parentId: 7 },
                { id: 3, text: "calibration", parentId: 7 },
            ],
        }],
    }];

    it("counts every folder, not just the root", () => {
        // The top level is a single isRoot node, so counting it reports 1
        // folder on a CMS with fifty — and reports it with no error.
        expect(collectionRows(folders, live)).to.have.length(4);
    });

    it("keeps parentId so the tree is still reconstructible", () => {
        const rows = collectionRows(folders, live) as Array<Record<string, unknown>>;
        expect(rows.map((r) => r.parentId)).to.deep.equal([0, 1, 7, 7]);
        expect(rows.map((r) => r.text)).to.deep.equal(["Root Folder", "Pixelmabob", "deck-test", "calibration"]);
    });

    it("drops children, which would repeat each subtree inside every ancestor", () => {
        for (const row of collectionRows(folders, live) as Array<Record<string, unknown>>) {
            expect(row).to.not.have.property("children");
        }
    });

    it("walks children handed back as a JSON string", () => {
        // The CMS does this for some nodes, which is why the client's own
        // folder walk parses as well as recurses.
        const stringy = [{ id: 1, text: "Root Folder", parentId: 0, children: JSON.stringify([{ id: 2, text: "A", parentId: 1 }]) }];
        expect(collectionRows(folders, stringy)).to.have.length(2);
    });

    it("survives a malformed tree rather than failing the whole refresh", () => {
        expect(collectionRows(folders, [{ id: 1, children: "not json" }])).to.have.length(1);
        expect(collectionRows(folders, [null, 42, "x"])).to.deep.equal([]);
    });

    it("leaves a flat collection alone", () => {
        const flat = COLLECTIONS.find((c) => c.key === "layouts")!;
        const rows = [{ layoutId: 1, children: "kept" }];
        expect(collectionRows(flat, rows)).to.deep.equal(rows);
    });
});

describe("the admin config offers exactly the catalogue", () => {
    /**
     * The multi-select is static JSON while the catalogue is code, so the two
     * drift the moment a collection is added, removed or renamed — and the
     * symptom is a box the user can tick that mirrors nothing, or a collection
     * they cannot reach at all. Neither reports a problem.
     */
    const options = (jsonConfig() as { options: Array<{ label: string; value: string }> }).options;

    it("offers every collection, and only those, in catalogue order", () => {
        expect(options.map((o) => o.value)).to.deep.equal(COLLECTIONS.map((c) => c.key));
    });

    it("labels each one with its catalogue name", () => {
        for (const collection of COLLECTIONS) {
            const option = options.find((o) => o.value === collection.key)!;
            expect(option.label, `${collection.key} is mislabelled`).to.contain(collection.name);
        }
    });

    it("marks the ones that are off by default, and only those", () => {
        for (const collection of COLLECTIONS) {
            const option = options.find((o) => o.value === collection.key)!;
            expect(option.label.includes("(off by default)"), `${collection.key}`).to.equal(!collection.defaultOn);
        }
    });

    it("ships the on-by-default keys as the io-package.json default", () => {
        // Otherwise a fresh install mirrors something different from what the
        // admin UI shows ticked.
        const native = ioPackage().native as { inventoryCollections: string[] };
        expect(native.inventoryCollections).to.deep.equal(DEFAULT_COLLECTION_KEYS);
    });
});
