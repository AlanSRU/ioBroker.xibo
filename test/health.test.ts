import { expect } from "chai";
import {
    CONNECTION_FAILURE_THRESHOLD, describeWrite, evaluateHealth, parseDurationSeconds,
} from "../src/lib/xibo-types";

/**
 * These pin three rules that were each wrong in 0.2.0 and each failed
 * silently — reporting success while doing the wrong thing — so a regression
 * would not show up in any other test or in the log.
 */

const HEALTHY = {
    statusEverSucceeded: true,
    statusFailures: 0,
    statusError: null as string | null,
    inventoryError: null as string | null,
};

describe("evaluateHealth", () => {
    it("does not report connected before a status poll has ever succeeded", () => {
        // Otherwise the flag reads true from startup and every watchdog gating
        // on it believes the CMS is reachable before anything has asked it.
        expect(evaluateHealth({ ...HEALTHY, statusEverSucceeded: false }).connected).to.equal(false);
    });

    it("survives a single failure, so one timeout is not a disconnection", () => {
        // A CMS backup or a proxy reload drops one request. Flipping the flag
        // there fires a spurious disconnect that clears 30 seconds later.
        const one = evaluateHealth({ ...HEALTHY, statusFailures: 1, statusError: "timeout" });
        expect(one.connected).to.equal(true);
        expect(one.lastError).to.equal("timeout");
    });

    it("reports disconnected once failures are consecutive", () => {
        const out = evaluateHealth({
            ...HEALTHY,
            statusFailures: CONNECTION_FAILURE_THRESHOLD,
            statusError: "connect ECONNREFUSED",
        });
        expect(out.connected).to.equal(false);
    });

    it("does not let an inventory failure claim the CMS is unreachable", () => {
        // A Xibo application scoped without Layout access gets a permanent 403
        // on /layout while /display keeps working. When both pollers wrote this
        // flag, that made them contradict each other every 30 seconds for ever.
        const out = evaluateHealth({ ...HEALTHY, inventoryError: "403 on /layout" });
        expect(out.connected).to.equal(true);
        expect(out.lastError).to.equal("403 on /layout");
    });

    it("prefers the live status error over an outstanding inventory one", () => {
        const out = evaluateHealth({ ...HEALTHY, statusError: "status", inventoryError: "inventory" });
        expect(out.lastError).to.equal("status");
    });

    it("clears the error once nothing is outstanding", () => {
        expect(evaluateHealth(HEALTHY).lastError).to.equal("");
    });
});

describe("parseDurationSeconds", () => {
    it("falls back only when no duration was given", () => {
        expect(parseDurationSeconds(undefined, 42)).to.equal(42);
        expect(parseDurationSeconds(null, 42)).to.equal(42);
    });

    it("rejects a duration that is present but not a number", () => {
        // Number("30s") is NaN, and both play routes read NaN as "no duration",
        // so this used to book an indefinite event instead of a 30-second one
        // and record ok:true. Every other field in the payload was validated.
        expect(() => parseDurationSeconds("30s", 0)).to.throw(/must be a number of seconds/);
        expect(() => parseDurationSeconds("", 0)).to.throw(/must be a number of seconds/);
        expect(() => parseDurationSeconds(-1, 0)).to.throw(/must be a number of seconds/);
    });

    it("accepts a real duration, including an explicit zero", () => {
        expect(parseDurationSeconds(30, 0)).to.equal(30);
        expect(parseDurationSeconds("30", 0)).to.equal(30);
        // 0 means "until reverted", which is a deliberate value, not absence.
        expect(parseDurationSeconds(0, 99)).to.equal(0);
    });
});

describe("describeWrite", () => {
    it("names a command write the same way the success path does", () => {
        // A consumer matching command === "changeLayout" to decide whether its
        // own press worked used to match every success and no failure, so a
        // failed press read as still pending.
        const { command, payload } = describeWrite("commands.changeLayout", '{"displayGroupId":5,"layoutId":41}');
        expect(command).to.equal("changeLayout");
        expect(payload).to.deep.equal({ displayGroupId: 5, layoutId: 41 });
    });

    it("records an unparseable payload verbatim rather than losing it", () => {
        // The throw being recorded may have been the parse itself.
        const { command, payload } = describeWrite("commands.changeLayout", "not json");
        expect(command).to.equal("changeLayout");
        expect(payload).to.equal("not json");
    });

    it("names a per-group write by its suffix, and keeps the group", () => {
        const { command, payload } = describeWrite("displayGroups.led_walls.playLayoutId", 41);
        expect(command).to.equal("playLayoutId");
        expect(payload).to.deep.equal({ displayGroup: "led_walls", value: 41 });
    });

    it("agrees with the command names the success paths use", () => {
        // These are the literals passed to recordResult on success.
        const successNames = ["changeLayout", "overlayLayout", "revertToSchedule", "collectNow", "refresh", "api"];
        for (const name of successNames) {
            expect(describeWrite(`commands.${name}`, "").command).to.equal(name);
        }
        expect(describeWrite("displayGroups.g.playLayoutId", 1).command).to.equal("playLayoutId");
        expect(describeWrite("displayGroups.g.revert", true).command).to.equal("revert");
    });
});
