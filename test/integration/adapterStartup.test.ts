import * as path from "node:path";
import { tests } from "@iobroker/testing";

/**
 * Starts a real js-controller and runs the adapter under it.
 *
 * Everything else in this suite is a unit test against exported definitions,
 * which cannot catch a crash on startup — an object created with a bad `common`,
 * a state written before its parent exists, or a throw in `onReady`. Those only
 * appear when the framework actually loads the built adapter, which is what this
 * does. The instance starts unconfigured, so it must report "not configured"
 * and stay alive rather than exit.
 */
tests.integration(path.join(__dirname, "..", ".."));
