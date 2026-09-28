// Resolves the bare `@minecraft/*` specifiers used by the behaviour pack to the
// local mocks, so main.js can be imported and exercised under plain Node.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const MOCKS = {
    "@minecraft/server": join(here, "mock-server.mjs"),
    "@minecraft/server-ui": join(here, "mock-server-ui.mjs"),
};

export async function resolve(specifier, context, next) {
    const mock = MOCKS[specifier];
    if (mock) return { url: pathToFileURL(mock).href, shortCircuit: true };
    return next(specifier, context);
}
