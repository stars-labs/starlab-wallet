import { compile } from "svelte/compiler";
import { chromium } from "@playwright/test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const temporary = await mkdtemp(join(tmpdir(), "starlab-receive-test-"));
const component = resolve("src/entrypoints/popup/components/ReceiveCard.svelte");
const entry = join(temporary, "entry.js");
await writeFile(entry, `import Component from ${JSON.stringify(component)};
window.card = new Component({ target: document.body, props: { address: '0x1111111111111111111111111111111111111111' } });`);
const build = await Bun.build({ entrypoints: [entry], target: "browser", plugins: [{
    name: "svelte", setup(builder) {
        builder.onLoad({ filter: /\.svelte$/ }, async ({ path }) => ({
            contents: compile(await Bun.file(path).text(), { filename: path, generate: "client", css: "injected", compatibility: { componentApi: 4 } }).js.code,
            loader: "js",
        }));
    },
}] });
assert(build.success, build.logs.join("\n"));
const script = await build.outputs[0].text();
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) =>
    new URL(request.url).pathname === "/bundle.js"
        ? new Response(script, { headers: { "Content-Type": "text/javascript" } })
        : new Response('<body><script type="module" src="/bundle.js"></script></body>', { headers: { "Content-Type": "text/html" } }),
});
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROME_PATH ?? "/nix/store/g0yvxs8p2ijrvmxpd5mim1ni0fyk9bnh-chromium-154.0.8037.57/bin/chromium", args: ["--no-sandbox"] });
try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.port}`);
    await page.locator("img.rc-qr").waitFor();
    await page.evaluate(() => (window as any).card.$set({ address: "" }));
    await page.getByText("No receive address available.").waitFor();
    assert.equal(await page.locator("img.rc-qr").count(), 0);
    assert(await page.getByRole("button", { name: "Copy address" }).isDisabled());
    // Begin a replacement render then clear it before its async QR finishes.
    await page.evaluate(async () => {
        (window as any).card.$set({ address: "0x2222222222222222222222222222222222222222" });
        await Promise.resolve();
        (window as any).card.$set({ address: "" });
    });
    await page.waitForTimeout(200);
    assert.equal(await page.locator("img.rc-qr").count(), 0);
    assert(await page.getByRole("button", { name: "Copy address" }).isDisabled());
    console.log("PASS ReceiveCard clears QR and disables copy on missing address, including an in-flight render");
} finally {
    await browser.close(); server.stop(true); await rm(temporary, { recursive: true, force: true });
}
