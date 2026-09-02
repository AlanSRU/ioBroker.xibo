import { expect } from "chai";
import {
    COLLECTIONS, DEFAULT_COLLECTION_KEYS, PERSONAL_DATA_KEYS, collectionRows, collectionStateIds,
    selectedCollections,
} from "../src/lib/xibo-collections";

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
    it("falls back to the defaults when unconfigured", () => {
        for (const unset of [undefined, null, [], "not an array"]) {
            expect(selectedCollections(unset).map((c) => c.key)).to.deep.equal(DEFAULT_COLLECTION_KEYS);
        }
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
