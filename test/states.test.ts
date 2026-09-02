import { expect } from "chai";
import {
    DISPLAY_GROUP_STATE_SUFFIXES, STATE_DEFINITIONS, CHANNEL_DEFINITIONS, inventoryStateDefinitions,
    sanitizeId,
} from "../src/lib/xibo-types";
import { COLLECTIONS } from "../src/lib/xibo-collections";

/**
 * The object tree is built in code, so nothing else ever sees these
 * definitions — repochecker only validates roles declared statically in
 * io-package.json. Pinning them here is the only check they get.
 */
describe("state definitions", () => {
    const all = [
        ...STATE_DEFINITIONS,
        ...DISPLAY_GROUP_STATE_SUFFIXES,
        ...inventoryStateDefinitions(COLLECTIONS),
    ];

    it("gives every state a default, so a fresh object is never undefined", () => {
        for (const state of all) {
            expect(state.def, `${state.id} has no def`).to.not.equal(undefined);
        }
    });

    it("matches each default to the state's declared type", () => {
        const expected: Record<string, string> = { string: "string", number: "number", boolean: "boolean" };
        for (const state of all) {
            if (!(state.type in expected)) continue;
            expect(typeof state.def, `${state.id} def is the wrong type`).to.equal(expected[state.type]);
        }
    });

    it("only uses info.* roles on the state they name", () => {
        // `info.name` means the device's name; putting it on anything else
        // passes every automated check and is still wrong.
        for (const state of all) {
            if (!state.role.startsWith("info.")) continue;
            expect(["info.connection"], `${state.id} uses ${state.role}`).to.include(state.id);
        }
    });

    it("keeps writable states writable and read-only states read-only", () => {
        const writable = all.filter((s) => s.write).map((s) => s.id);
        // Every writable state must have a handler in main.ts; these are they.
        expect(writable.sort()).to.deep.equal([
            "commands.api", "commands.changeLayout", "commands.collectNow", "commands.overlayLayout",
            "commands.refresh", "commands.revertToSchedule",
            "playLayoutId", "revert",
        ].sort());
    });

    it("declares a parent channel for every dotted state id", () => {
        const channels = new Set(CHANNEL_DEFINITIONS.map((c) => c.id));
        // The inventory states are generated from the collection catalogue, so
        // a new collection could otherwise create a state under a channel that
        // does not exist — which the runtime tolerates silently.
        const audited = [...STATE_DEFINITIONS, ...inventoryStateDefinitions(COLLECTIONS)];
        for (const state of audited) {
            const segments = state.id.split(".");
            for (let i = 1; i < segments.length; i++) {
                const parent = segments.slice(0, i).join(".");
                expect(channels.has(parent), `${state.id} has no channel object for "${parent}"`).to.equal(true);
            }
        }
    });

    it("folds CMS names into safe object ids", () => {
        expect(sanitizeId("LED Walls")).to.equal("led_walls");
        expect(sanitizeId("West / East")).to.equal("west_east");
        expect(sanitizeId("...")).to.equal("unnamed");
    });
});
