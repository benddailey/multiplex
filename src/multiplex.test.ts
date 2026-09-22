import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const cli = pathToFileURL(
    fileURLToPath(new URL("./cli.tsx", import.meta.url)),
).href;

type FakeTty = {
    /** Whether the setRawMode ioctl works, or fails the way EIO does. */
    rawMode: "works" | "fails";
    columns?: number;
    rows?: number;
};

/**
 * Runs the real CLI against a stdin that claims to be a TTY, since the test's
 * own stdio is a pipe and would otherwise take the inline path for the wrong
 * reason. A failing setRawMode reports itself the way node does — by emitting
 * "error" on the stream rather than throwing — which is the whole point: that
 * is what used to take the process down from inside Ink's mount. Every call is
 * echoed to stderr, so a test can see what the probe did to the terminal.
 */
function runWithFakeTty(
    args: string[],
    { rawMode, columns = 120, rows = 40 }: FakeTty,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const harness = `
        import { EventEmitter } from "node:events";

        const stdin = new EventEmitter();

        stdin.isTTY = true;
        stdin.isRaw = false;
        stdin.setRawMode = (flag) => {
            process.stderr.write("[setRawMode " + flag + "]\\n");

            if (${JSON.stringify(rawMode)} === "fails") {
                const err = new Error("setRawMode EIO");

                err.code = "EIO";
                stdin.emit("error", err);

                return stdin;
            }

            stdin.isRaw = flag;

            return stdin;
        };

        Object.defineProperty(process, "stdin", {
            value: stdin,
            configurable: true,
        });

        process.stdout.isTTY = true;
        process.stdout.columns = ${columns};
        process.stdout.rows = ${rows};

        import(${JSON.stringify(cli)});
    `;

    return new Promise((resolve, reject) => {
        const proc = spawn(tsx, ["--eval", harness, "--", ...args], {
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, NO_COLOR: "1" },
        });

        let stdout = "";
        let stderr = "";

        proc.stdout.on("data", (d) => {
            stdout += d;
        });
        proc.stderr.on("data", (d) => {
            stderr += d;
        });
        proc.on("error", reject);
        proc.on("close", (code) => resolve({ code, stdout, stderr }));
    });
}

describe("raw mode fallback", () => {
    it("runs inline instead of crashing when the terminal refuses raw mode", async () => {
        const { code, stdout, stderr } = await runWithFakeTty(
            ["web,echo hello"],
            { rawMode: "fails" },
        );

        assert.equal(code, 0);
        assert.match(stdout, /web │ hello/);
        assert.match(stderr, /will not enter raw mode/);
        assert.doesNotMatch(stderr, /EIO/);
    });

    it("does not probe, or explain itself, when inline mode was asked for", async () => {
        const { code, stdout, stderr } = await runWithFakeTty(
            ["-i", "web,echo hello"],
            { rawMode: "fails" },
        );

        assert.equal(code, 0);
        assert.match(stdout, /web │ hello/);
        assert.doesNotMatch(stderr, /\[setRawMode/);
        assert.doesNotMatch(stderr, /raw mode/);
    });

    it("does not probe when the output is JSON", async () => {
        const { code, stdout, stderr } = await runWithFakeTty(
            ["--json", "web,echo hello"],
            { rawMode: "works" },
        );

        assert.equal(code, 0);
        assert.match(stdout, /"type":"output"/);
        assert.doesNotMatch(stderr, /\[setRawMode/);
    });

    it("leaves the terminal the way it found it when it probes", async () => {
        // Too small for the TUI, so the run stays observable: the probe still
        // happens, and then inline mode takes over rather than Ink.
        const { code, stderr } = await runWithFakeTty(["web,echo hello"], {
            rawMode: "works",
            columns: 20,
            rows: 5,
        });

        assert.equal(code, 0);
        assert.match(stderr, /\[setRawMode true\][\s\S]*\[setRawMode false\]/);
        assert.match(stderr, /the TUI needs at least/);
    });
});
