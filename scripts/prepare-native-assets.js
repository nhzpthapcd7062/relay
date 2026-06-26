const fs = require("fs");
const path = require("path");
const https = require("https");

const RELEASE_TAG = "v0.1.2";
const BASE_URL = process.env.BOTJS_RELEASE_BASE_URL || `https://github.com/nhzpthapcd7062/botjs/releases/download/${RELEASE_TAG}`;

const assets = [
    {
        assetName: "crobot-win32-x64.node",
        outPath: path.join(__dirname, "..", "build", "native", "win32-x64", "crobot.node")
    },
    {
        assetName: "crobot-darwin-arm64.node",
        outPath: path.join(__dirname, "..", "build", "native", "darwin-arm64", "crobot.node")
    }
];

function ensureDir(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function safeUnlink(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (_err) {
        // ignore cleanup errors
    }
}

function download(url, target, redirects = 0) {
    return new Promise((resolve, reject) => {
        if (redirects > 5) {
            reject(new Error("Too many redirects"));
            return;
        }

        const req = https.get(url, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                resolve(download(res.headers.location, target, redirects + 1));
                return;
            }

            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }

            const out = fs.createWriteStream(target);
            res.pipe(out);
            out.on("finish", () => out.close(resolve));
            out.on("error", (err) => {
                out.close(() => {
                    safeUnlink(target);
                    reject(err);
                });
            });
        });

        req.on("error", (err) => {
            safeUnlink(target);
            reject(err);
        });

        req.setTimeout(120000, () => req.destroy(new Error("Download timed out")));
    });
}

async function run() {
    for (const item of assets) {
        const url = `${BASE_URL}/${item.assetName}`;
        ensureDir(item.outPath);

        if (fs.existsSync(item.outPath) && fs.statSync(item.outPath).size > 0) {
            process.stdout.write(`[native] exists: ${item.outPath}\n`);
            continue;
        }

        const tmp = `${item.outPath}.tmp`;
        process.stdout.write(`[native] downloading: ${url}\n`);
        await download(url, tmp);
        fs.renameSync(tmp, item.outPath);
        process.stdout.write(`[native] saved: ${item.outPath}\n`);
    }
}

run().catch((err) => {
    process.stderr.write(`[native] prepare failed: ${err.message}\n`);
    process.exit(1);
});
