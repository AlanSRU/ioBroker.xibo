import { expect } from "chai";
import { XiboClient } from "../src/lib/xibo-client";
import { XiboConfig } from "../src/lib/xibo-types";

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

/** Records every request and answers all of them, so the wire format is what is under test. */
function stub(): { calls: Call[]; restore: () => void } {
    const calls: Call[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const body: Record<string, string> = {};
        if (init?.body instanceof URLSearchParams) {
            for (const [k, v] of init.body.entries()) body[k] = body[k] === undefined ? v : `${body[k]},${v}`;
        }
        calls.push({ url: String(input), method: init?.method ?? "GET", body });
        if (String(input).includes("/authorize/access_token")) {
            return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
        }
        return new Response(JSON.stringify([]), { status: 200 });
    }) as typeof globalThis.fetch;
    return { calls, restore: () => { globalThis.fetch = original; } };
}

const client = (): XiboClient => new XiboClient(CONFIG, SILENT);
/** Requests other than the token fetch. */
const apiCalls = (calls: Call[]): Call[] => calls.filter((c) => !c.url.includes("/authorize/"));

describe("call: staying under /api", () => {
    /**
     * A string guard looking for ".." passes every one of these. The WHATWG
     * parser — the one `fetch` itself uses — decodes `%2e%2e`, `%2E%2E` and
     * `.%2e` to a double-dot segment before normalising, so each climbs out of
     * `/api` and reaches the CMS with the bearer token attached.
     */
    const escapes = [
        "/../secret",
        "/%2e%2e/%2e%2e/install/index.php",
        "/.%2e/.%2e/install/index.php",
        "/%2E%2E/admin",
        "/a/../../x",
    ];

    for (const path of escapes) {
        it(`refuses ${path}, and sends nothing`, async () => {
            const cms = stub();
            try {
                await client().call("GET", path);
                expect.fail(`${path} was allowed`);
            } catch (err) {
                expect((err as Error).message).to.match(/must stay under \/api/);
                // Refused before any request, so the token never leaves.
                expect(apiCalls(cms.calls)).to.have.length(0);
            } finally {
                cms.restore();
            }
        });
    }

    it("allows an ordinary path", async () => {
        const cms = stub();
        try {
            await client().call("GET", "/layout");
            expect(apiCalls(cms.calls)[0].url).to.equal("http://cms.test/api/layout");
        } finally {
            cms.restore();
        }
    });

    it("refuses a method the CMS does not take, before sending anything", async () => {
        const cms = stub();
        try {
            await client().call("PATCH", "/layout");
            expect.fail("PATCH was allowed");
        } catch (err) {
            expect((err as Error).message).to.match(/method must be one of/);
            expect(cms.calls).to.have.length(0);
        } finally {
            cms.restore();
        }
    });

    it("refuses a path that is not rooted", async () => {
        try {
            await client().call("GET", "layout");
            expect.fail("a relative path was allowed");
        } catch (err) {
            expect((err as Error).message).to.match(/must start with/);
        }
    });
});

describe("call: parameter encoding", () => {
    it("sends values as query parameters for GET", async () => {
        const cms = stub();
        try {
            await client().call("GET", "/campaign", { isLayoutSpecific: -1 });
            expect(apiCalls(cms.calls)[0].url).to.equal("http://cms.test/api/campaign?isLayoutSpecific=-1");
        } finally {
            cms.restore();
        }
    });

    it("merges with a query string already on the path", async () => {
        const cms = stub();
        try {
            await client().call("GET", "/layout?retired=0", { start: 0, length: 2 });
            expect(apiCalls(cms.calls)[0].url).to.contain("retired=0");
            expect(apiCalls(cms.calls)[0].url).to.contain("start=0");
            expect(apiCalls(cms.calls)[0].url).to.contain("length=2");
        } finally {
            cms.restore();
        }
    });

    it("encodes an array as repeated key[] entries", async () => {
        // The encoding the schedule endpoints require, and the one thing about
        // this API that is easy to get silently wrong: a plain `key=1,2` is
        // accepted and then read as a single malformed id.
        const cms = stub();
        try {
            await client().call("GET", "/schedule", { displayGroupIds: [1, 2] });
            const url = apiCalls(cms.calls)[0].url;
            expect(url).to.contain("displayGroupIds%5B%5D=1");
            expect(url).to.contain("displayGroupIds%5B%5D=2");
        } finally {
            cms.restore();
        }
    });

    it("sends values as a form body for POST, not a query string", async () => {
        const cms = stub();
        try {
            await client().call("POST", "/tag", { name: "x" });
            const call = apiCalls(cms.calls)[0];
            expect(call.method).to.equal("POST");
            expect(call.url).to.equal("http://cms.test/api/tag");
            expect(call.body.name).to.equal("x");
        } finally {
            cms.restore();
        }
    });

    it("omits a parameter that was not given rather than sending an empty one", async () => {
        // `duration=` and `duration=null` are not the same as absent to the
        // CMS; the second is a validation error.
        const cms = stub();
        try {
            await client().call("POST", "/tag", { name: "x", missing: undefined, empty: null });
            const call = apiCalls(cms.calls)[0];
            expect(Object.keys(call.body)).to.deep.equal(["name"]);
        } finally {
            cms.restore();
        }
    });
});
