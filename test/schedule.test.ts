import { expect } from "chai";
import { XiboClient } from "../src/lib/xibo-client";
import { XiboConfig } from "../src/lib/xibo-types";

/**
 * These drive the real client against a stubbed `fetch`, rather than stubbing
 * the client's own request method.
 *
 * The bugs this mechanism is prone to all live in the wire format — which day
 * part id, how `displayGroupIds[]` is encoded, what a date looks like — so a
 * test that mocks that away would pass while the CMS rejected every call or,
 * worse, accepted it and scheduled the wrong thing.
 */

interface Call {
    url: string;
    method: string;
    body: Record<string, string>;
}

const CONFIG: XiboConfig = {
    url: "http://cms.test",
    clientId: "id",
    clientSecret: "secret",
    inventoryPollInterval: 300_000,
    statusPollInterval: 30_000,
    requestTimeout: 5_000,
    layoutFolder: "",
    defaultChangeDuration: 0,
    layoutPlayMode: "schedule",
    schedulePriority: 10,
};

const SILENT = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

/**
 * Answers the handful of endpoints `scheduleLayout` touches.
 *
 * The day part ids are deliberately the ones a live 4.5.1 reports (custom 1,
 * always 2) rather than the 0 and 1 its OpenAPI document claims, since telling
 * those apart is the whole point of reading them at runtime.
 */
function stubCms(options: {
    events?: Array<{ eventId: number; isPriority: number }>;
    clock?: string;
    layout?: Record<string, unknown> | null;
} = {}): { calls: Call[]; restore: () => void } {
    const calls: Call[] = [];
    const original = globalThis.fetch;

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body: Record<string, string> = {};
        if (init?.body instanceof URLSearchParams) {
            // Repeated keys are kept as a comma-joined value so an assertion
            // can see both of them.
            for (const [k, v] of init.body.entries()) {
                body[k] = body[k] === undefined ? v : `${body[k]},${v}`;
            }
        }
        calls.push({ url, method, body });

        const json = (value: unknown): Response =>
            new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });

        if (url.includes("/authorize/access_token")) return json({ access_token: "t", expires_in: 3600 });
        if (url.includes("/api/clock")) return json({ time: options.clock ?? "12:00 UTC" });
        if (url.includes("/api/daypart")) {
            return json([
                { dayPartId: 2, name: "Always", isAlways: 1, isCustom: 0 },
                { dayPartId: 1, name: "Custom", isAlways: 0, isCustom: 1 },
            ]);
        }
        if (url.includes("/api/layout?layoutId=")) {
            if (options.layout === null) return json([]);
            return json([options.layout ?? { layoutId: 39, layout: "sign", width: 1920, height: 1024, campaignId: 20 }]);
        }
        if (url.includes("/api/schedule?")) {
            return json((options.events ?? []).map((e) => ({ ...e, eventTypeId: 1, campaignId: 99, dayPartId: 2 })));
        }
        // POST /schedule, DELETE /schedule/n and the collectNow action all
        // answer 204 with no body.
        return new Response(null, { status: 204 });
    }) as typeof globalThis.fetch;

    return { calls, restore: () => { globalThis.fetch = original; } };
}

describe("scheduleLayout", () => {
    it("schedules the layout's campaign, not its layout id", async () => {
        const cms = stubCms();
        try {
            await new XiboClient(CONFIG, SILENT).scheduleLayout(5, 39, 10);
            const post = cms.calls.find((c) => c.method === "POST" && c.url.endsWith("/api/schedule"));
            expect(post, "no schedule POST was made").to.not.equal(undefined);
            expect(post!.body.campaignId).to.equal("20");
            expect(post!.body.eventTypeId).to.equal("1");
        } finally {
            cms.restore();
        }
    });

    it("reads the always day part from the CMS rather than assuming an id", async () => {
        const cms = stubCms();
        try {
            await new XiboClient(CONFIG, SILENT).scheduleLayout(5, 39, 10);
            const post = cms.calls.find((c) => c.method === "POST" && c.url.endsWith("/api/schedule"))!;
            // 2 on a real CMS; the OpenAPI document says 1, which would file
            // the event against "Custom" and never play it.
            expect(post.body.dayPartId).to.equal("2");
            expect(post.body.toDt).to.equal(undefined);
        } finally {
            cms.restore();
        }
    });

    it("uses the custom day part and a toDt when given a duration", async () => {
        const cms = stubCms();
        try {
            await new XiboClient(CONFIG, SILENT).scheduleLayout(5, 39, 10, 30);
            const post = cms.calls.find((c) => c.method === "POST" && c.url.endsWith("/api/schedule"))!;
            expect(post.body.dayPartId).to.equal("1");
            expect(post.body.toDt).to.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
            const from = Date.parse(`${post.body.fromDt.replace(" ", "T")}Z`);
            const to = Date.parse(`${post.body.toDt.replace(" ", "T")}Z`);
            expect(to - from).to.equal(30_000);
        } finally {
            cms.restore();
        }
    });

    it("formats dates in the CMS's timezone, not UTC", async () => {
        // A CMS an hour ahead. Sending UTC would book the event an hour in the
        // past, where it never plays and nothing reports a problem.
        const cms = stubCms({ clock: `${String((new Date().getUTCHours() + 1) % 24).padStart(2, "0")}:${String(new Date().getUTCMinutes()).padStart(2, "0")} BST` });
        try {
            await new XiboClient(CONFIG, SILENT).scheduleLayout(5, 39, 10, 30);
            const post = cms.calls.find((c) => c.method === "POST" && c.url.endsWith("/api/schedule"))!;
            const sent = Date.parse(`${post.body.fromDt.replace(" ", "T")}Z`);
            const utcNow = Date.now();
            // An hour ahead of UTC, within a minute of tolerance for the run.
            expect(sent - utcNow).to.be.greaterThan(59 * 60_000);
            expect(sent - utcNow).to.be.lessThan(61 * 60_000);
        } finally {
            cms.restore();
        }
    });

    it("deletes only its own priority's events before creating the new one", async () => {
        const cms = stubCms({
            events: [
                { eventId: 27, isPriority: 0 },   // someone's own schedule
                { eventId: 29, isPriority: 10 },  // ours, from the last press
            ],
        });
        try {
            const result = await new XiboClient(CONFIG, SILENT).scheduleLayout(5, 39, 10);
            expect(result.replaced).to.equal(1);

            const deletes = cms.calls.filter((c) => c.method === "DELETE").map((c) => c.url);
            expect(deletes).to.have.lengthOf(1);
            expect(deletes[0]).to.contain("/api/schedule/29");

            // Order matters: two layout events at one priority both play, so a
            // create before the delete would cycle the old sign with the new.
            const deleteAt = cms.calls.findIndex((c) => c.method === "DELETE");
            const createAt = cms.calls.findIndex((c) => c.method === "POST" && c.url.endsWith("/api/schedule"));
            expect(deleteAt).to.be.lessThan(createAt);
        } finally {
            cms.restore();
        }
    });

    it("asks the group to collect, or the player would not notice until its next poll", async () => {
        const cms = stubCms();
        try {
            await new XiboClient(CONFIG, SILENT).scheduleLayout(5, 39, 10);
            const collect = cms.calls.find((c) => c.url.includes("/action/collectNow"));
            expect(collect, "no collectNow was sent").to.not.equal(undefined);
            expect(collect!.url).to.contain("/displaygroup/5/action/collectNow");
        } finally {
            cms.restore();
        }
    });

    it("refuses an unknown layout without touching the existing schedule", async () => {
        // Resolving the campaign first is what makes this safe: a bad layout id
        // must not leave the group with its previous event already deleted.
        const cms = stubCms({ layout: null, events: [{ eventId: 29, isPriority: 10 }] });
        try {
            await new XiboClient(CONFIG, SILENT).scheduleLayout(5, 404, 10);
            expect.fail("expected an unknown layout to be refused");
        } catch (err) {
            expect((err as Error).message).to.contain("404");
            expect(cms.calls.filter((c) => c.method === "DELETE")).to.have.lengthOf(0);
        } finally {
            cms.restore();
        }
    });
});

describe("the CMS clock offset", () => {
    const clockCalls = (calls: Call[]): number => calls.filter((c) => c.url.includes("/api/clock")).length;

    it("is read once, not per schedule call", async () => {
        const cms = stubCms();
        try {
            const client = new XiboClient(CONFIG, SILENT);
            await client.scheduleLayout(5, 39, 10);
            await client.scheduleLayout(5, 39, 10);
            expect(clockCalls(cms.calls)).to.equal(1);
        } finally {
            cms.restore();
        }
    });

    it("is read again once it goes stale, so a DST change cannot strand it", async () => {
        // Held for the life of the instance, an adapter up since summer still
        // believes the CMS is on BST in November and books every event an hour
        // out: an hour ahead in the indefinite case, so the wall does not
        // change until long after the button was pressed, or an hour behind
        // for a timed event, whose window has already closed and never plays.
        // Both report ok and log nothing. A venue instance is not restarted
        // twice a year on cue.
        const cms = stubCms();
        const realNow = Date.now;
        try {
            const client = new XiboClient(CONFIG, SILENT);
            await client.scheduleLayout(5, 39, 10);
            expect(clockCalls(cms.calls)).to.equal(1);

            // Two hours later. Only Date.now is moved, so the offset the stub
            // implies is unchanged and this measures the cache, not the maths.
            const shifted = realNow() + 2 * 3_600_000;
            Date.now = () => shifted;
            await client.scheduleLayout(5, 39, 10);
            expect(clockCalls(cms.calls)).to.equal(2);
        } finally {
            Date.now = realNow;
            cms.restore();
        }
    });
});

describe("clearScheduledLayouts", () => {
    it("leaves events it does not own", async () => {
        const cms = stubCms({ events: [{ eventId: 27, isPriority: 0 }, { eventId: 28, isPriority: 1 }] });
        try {
            const removed = await new XiboClient(CONFIG, SILENT).clearScheduledLayouts(5, 10);
            expect(removed).to.equal(0);
            expect(cms.calls.filter((c) => c.method === "DELETE")).to.have.lengthOf(0);
        } finally {
            cms.restore();
        }
    });
});
