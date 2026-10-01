import { expect } from "chai";
import {
    chooseBranchId,
    DEFAULT_CRITERIA_TTL,
    parseConfig,
    parseCriteriaUpdates,
    parseDurationSeconds,
    requireId,
    strictNumber,
} from "../src/lib/xibo-types";

describe("strictNumber", () => {
    it("reads numbers and numeric strings", () => {
        expect(strictNumber(5)).to.equal(5);
        expect(strictNumber("5")).to.equal(5);
        expect(strictNumber(" 2.5 ")).to.equal(2.5);
    });

    it("refuses what Number() quietly turns into 0 or 1", () => {
        for (const value of [true, false, null, undefined, "", "   ", [], {}]) {
            expect(strictNumber(value), JSON.stringify(value)).to.be.NaN;
        }
    });
});

describe("requireId", () => {
    it("accepts a positive integer, as a number or a string", () => {
        expect(requireId(7, "displayGroupId")).to.equal(7);
        expect(requireId("7", "displayGroupId")).to.equal(7);
    });

    // `{"displayGroupId": true}` used to target display group 1, and a blank
    // form field group 0.
    for (const [label, value] of [
        ["true", true],
        ["null", null],
        ["missing", undefined],
        ["blank", ""],
        ["zero", 0],
        ["negative", -3],
        ["fractional", 1.5],
        ["text", "lobby"],
    ] as Array<[string, unknown]>) {
        it(`refuses ${label}, naming the field`, () => {
            expect(() => requireId(value, "displayGroupId")).to.throw(/displayGroupId/);
        });
    }
});

describe("parseDurationSeconds", () => {
    it("refuses true, which Number() makes a one-second play", () => {
        expect(() => parseDurationSeconds(true, 0)).to.throw(/duration/);
    });
});

describe("parseCriteriaUpdates: ttl", () => {
    // A blank ttl was `Number("")` = 0, which lapsed at the next minute tick
    // instead of holding for the documented default.
    for (const [label, ttl] of [
        ["blank", ""],
        ["zero", 0],
        ["negative", -60],
        ["true", true],
    ] as Array<[string, unknown]>) {
        it(`refuses a ${label} ttl rather than expiring the push`, () => {
            expect(() => parseCriteriaUpdates({ metric: "screen1", value: "1", ttl })).to.throw(/ttl/);
        });
    }

    it("still defaults a missing ttl", () => {
        expect(parseCriteriaUpdates({ metric: "screen1", value: "1" })[0].ttl).to.equal(DEFAULT_CRITERIA_TTL);
    });
});

describe("parseConfig", () => {
    it("rounds the schedule priority, since it is also the ownership marker", () => {
        // `isPriority` is matched strictly against what the CMS reads back,
        // so 10.5 never found the adapter's own events again.
        expect(parseConfig({ schedulePriority: 10.4 }).schedulePriority).to.equal(10);
        expect(Number.isInteger(parseConfig({ schedulePriority: "7.6" }).schedulePriority)).to.equal(true);
    });

    it("caps the default duration like the admin field does", () => {
        expect(parseConfig({ defaultChangeDuration: 1e12 }).defaultChangeDuration).to.equal(86_400);
        expect(parseConfig({ defaultChangeDuration: 0 }).defaultChangeDuration).to.equal(0);
        expect(parseConfig({ defaultChangeDuration: -5 }).defaultChangeDuration).to.equal(0);
        expect(parseConfig({ defaultChangeDuration: 30 }).defaultChangeDuration).to.equal(30);
    });

    it("falls back to the defaults for an empty instance object", () => {
        const config = parseConfig({});
        expect(config.schedulePriority).to.equal(10);
        expect(config.statusPollInterval).to.equal(30_000);
        expect(config.layoutPlayMode).to.equal("schedule");
        expect(config.url).to.equal("");
    });

    it("keeps polling intervals below the 2^31 timer limit", () => {
        expect(parseConfig({ inventoryPollInterval: 2 ** 31 }).inventoryPollInterval).to.be.below(2 ** 31);
    });
});

describe("chooseBranchId", () => {
    it("uses the folded name when nothing holds it", () => {
        expect(chooseBranchId("displayGroups.lobby", 3, new Set())).to.equal("displayGroups.lobby");
    });

    it("falls back to the CMS id on a collision", () => {
        expect(chooseBranchId("displayGroups.lobby", 5, new Set(["displayGroups.lobby"]))).to.equal(
            "displayGroups.lobby_5",
        );
    });

    it("keeps looking when the fallback is taken too", () => {
        // "Lobby" holds lobby and "Lobby 5" holds lobby_5, so group 5 named
        // "Lobby!" must not land on lobby_5.
        const taken = new Set(["displayGroups.lobby", "displayGroups.lobby_5"]);
        const id = chooseBranchId("displayGroups.lobby", 5, taken);
        expect(taken.has(id)).to.equal(false);
        expect(id).to.equal("displayGroups.lobby_5_2");
    });
});
