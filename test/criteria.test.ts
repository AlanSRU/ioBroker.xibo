import { expect } from "chai";
import { XiboClient } from "../src/lib/xibo-client";
import { DEFAULT_CRITERIA_TTL, parseCriteriaUpdates, XiboConfig } from "../src/lib/xibo-types";

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
    inventoryCollections: ["layouts"],
};

const SILENT = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

interface Call {
    url: string;
    method: string;
    body: Record<string, string>;
}

function stub(): { calls: Call[]; restore: () => void } {
    const calls: Call[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const body: Record<string, string> = {};
        if (init?.body instanceof URLSearchParams) {
            for (const [k, v] of init.body.entries()) body[k] = v;
        }
        calls.push({ url: String(input), method: init?.method ?? "GET", body });
        if (String(input).includes("/authorize/access_token")) {
            return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
        }
        // The real endpoint answers 204 with no body.
        return new Response(null, { status: 204 });
    }) as typeof globalThis.fetch;
    return { calls, restore: () => { globalThis.fetch = original; } };
}

const client = (): XiboClient => new XiboClient(CONFIG, SILENT);
const apiCalls = (calls: Call[]): Call[] => calls.filter((c) => !c.url.includes("/authorize/"));

describe("pushCriteria: wire format", () => {
    it("posts indexed criteriaUpdates keys to the display group", async () => {
        const { calls, restore } = stub();
        try {
            await client().pushCriteria(5, [{ metric: "wall1", value: "3", ttl: 3600 }]);
        } finally {
            restore();
        }
        const [call] = apiCalls(calls);
        expect(call.method).to.equal("POST");
        expect(call.url).to.equal("http://cms.test/api/displaygroup/criteria/5");
        expect(call.body).to.deep.equal({
            "criteriaUpdates[0][metric]": "wall1",
            "criteriaUpdates[0][value]": "3",
            "criteriaUpdates[0][ttl]": "3600",
        });
    });

    /**
     * The index is what distinguishes one update from the next. A flat
     * `criteriaUpdates[]` is accepted by the CMS and then ignored, so an
     * encoding regression here pushes nothing and reports success.
     */
    it("indexes a batch so several metrics ride one request", async () => {
        const { calls, restore } = stub();
        try {
            await client().pushCriteria(5, [
                { metric: "wall1", value: "1", ttl: 60 },
                { metric: "wall2", value: "hdmi", ttl: 60 },
            ]);
        } finally {
            restore();
        }
        expect(apiCalls(calls)).to.have.length(1);
        expect(apiCalls(calls)[0].body).to.deep.equal({
            "criteriaUpdates[0][metric]": "wall1",
            "criteriaUpdates[0][value]": "1",
            "criteriaUpdates[0][ttl]": "60",
            "criteriaUpdates[1][metric]": "wall2",
            "criteriaUpdates[1][value]": "hdmi",
            "criteriaUpdates[1][ttl]": "60",
        });
    });

    it("refuses an empty push rather than sending an update-less request", async () => {
        const { calls, restore } = stub();
        try {
            await client().pushCriteria(5, []);
            expect.fail("should have thrown");
        } catch (e) {
            expect((e as Error).message).to.match(/at least one/);
        } finally {
            restore();
        }
        expect(apiCalls(calls)).to.have.length(0);
    });

    /** 204-with-no-body is what this endpoint answers; parsing it as JSON throws. */
    it("treats 204 as success", async () => {
        const { restore } = stub();
        try {
            await client().pushCriteria(5, [{ metric: "wall1", value: "2", ttl: 30 }]);
        } finally {
            restore();
        }
    });
});

describe("parseCriteriaUpdates", () => {
    it("takes the single-metric shape a deck button writes", () => {
        expect(parseCriteriaUpdates({ metric: "wall1", value: "2", ttl: 60 })).to.deep.equal([
            { metric: "wall1", value: "2", ttl: 60 },
        ]);
    });

    /** Nearly always a number in practice; rejecting 3 for not being "3" is a pointless trap. */
    it("coerces a numeric value to the string the CMS compares", () => {
        expect(parseCriteriaUpdates({ metric: "wall1", value: 3, ttl: 60 })[0].value).to.equal("3");
    });

    it("defaults the ttl, since the CMS refuses an update without one", () => {
        expect(parseCriteriaUpdates({ metric: "wall1", value: "1" })[0].ttl).to.equal(DEFAULT_CRITERIA_TTL);
    });

    it("takes a batch under `updates`", () => {
        expect(parseCriteriaUpdates({
            updates: [{ metric: "a", value: "1", ttl: 5 }, { metric: "b", value: "2" }],
        })).to.deep.equal([
            { metric: "a", value: "1", ttl: 5 },
            { metric: "b", value: "2", ttl: DEFAULT_CRITERIA_TTL },
        ]);
    });

    /**
     * `value: 0` and `value: "0"` are ordinary selections — a metric gated
     * `eq 0` is as valid as one gated `eq 1`. A truthiness check would reject
     * both, and only for the one value nobody tests by hand.
     */
    it("accepts zero as a value", () => {
        expect(parseCriteriaUpdates({ metric: "wall1", value: 0 })[0].value).to.equal("0");
    });

    const bad: [string, Record<string, unknown>, RegExp][] = [
        ["no metric", { value: "1" }, /metric/],
        ["blank metric", { metric: "   ", value: "1" }, /metric/],
        ["no value", { metric: "wall1" }, /value/],
        ["empty value", { metric: "wall1", value: "" }, /value/],
        ["object value", { metric: "wall1", value: { a: 1 } }, /value/],
        ["unparseable ttl", { metric: "wall1", value: "1", ttl: "soon" }, /ttl/],
        ["empty batch", { updates: [] }, /empty/],
        ["non-object in batch", { updates: ["wall1=1"] }, /updates\[0\]/],
    ];
    for (const [name, payload, message] of bad) {
        it(`refuses ${name}`, () => {
            expect(() => parseCriteriaUpdates(payload)).to.throw(message);
        });
    }
});
