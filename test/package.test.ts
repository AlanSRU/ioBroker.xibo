import * as path from "node:path";
import { tests } from "@iobroker/testing";

// Validates package.json against io-package.json — versions, name, licence,
// news entries and the rest of the consistency the repository checker expects.
// This is what `npm run test:package` runs, which ioBroker's
// testing-action-check invokes unconditionally in CI.
tests.packageFiles(path.join(__dirname, ".."));
