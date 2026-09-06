const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const STORE_DIR =
  process.env.DEVICE_STORE_DIR || path.join(__dirname, "..", "data", "devices");

function ensureDir() {
  fs.mkdirSync(STORE_DIR, { recursive: true });
}

// USNs contain ':' and sometimes '/' -- sanitize before using as a filename.
function fileNameFor(usn) {
  const safe = usn.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(STORE_DIR, `${safe}.yaml`);
}

/**
 * Load every persisted device off disk. Devices loaded this way haven't
 * been confirmed on *this* boot yet, so they always come back tagged
 * 'offline' -- the background discovery loop is what promotes them to
 * 'online' once it actually hears from them again.
 */
function loadAll() {
  ensureDir();
  const files = fs
    .readdirSync(STORE_DIR)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  const devices = new Map();

  for (const file of files) {
    try {
      const doc = yaml.load(
        fs.readFileSync(path.join(STORE_DIR, file), "utf8"),
      );
      if (doc && doc.usn) {
        devices.set(doc.usn, { ...doc, status: "offline" });
      }
    } catch (err) {
      console.warn(`Skipping unreadable device file ${file}: ${err.message}`);
    }
  }
  return devices;
}

function save(device) {
  ensureDir();
  fs.writeFileSync(fileNameFor(device.usn), yaml.dump(device), "utf8");
}

module.exports = { loadAll, save, STORE_DIR };
