const { Client } = require("node-ssdp");
const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");
const deviceStore = require("./deviceStore");

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

// Persistent registry of every device we've ever seen, keyed by USN --
// seeded from disk at startup so devices are known (as 'offline') even
// before the first scan completes.
const registry = deviceStore.loadAll();

async function fetchDeviceDescription(location) {
  const res = await axios.get(location, { timeout: 4000 });
  const parsed = xmlParser.parse(res.data);
  const device = parsed.root?.device;
  if (!device) throw new Error(`No <device> in description at ${location}`);

  const base = new URL(location);
  const baseUrl = `${base.protocol}//${base.host}`;

  let serviceList = device.serviceList?.service || [];
  if (!Array.isArray(serviceList)) serviceList = [serviceList];

  const services = serviceList.map((s) => ({
    serviceType: s.serviceType,
    serviceId: s.serviceId,
    controlURL: new URL(s.controlURL, baseUrl).toString(),
    eventSubURL: s.eventSubURL
      ? new URL(s.eventSubURL, baseUrl).toString()
      : null,
    scpdURL: s.SCPDURL ? new URL(s.SCPDURL, baseUrl).toString() : null,
  }));

  return {
    friendlyName: device.friendlyName || location,
    deviceType: device.deviceType || "",
    udn: device.UDN || location,
    manufacturer: device.manufacturer || "",
    modelName: device.modelName || "",
    location,
    baseUrl,
    services,
  };
}

function classify(deviceType = "") {
  if (deviceType.includes("MediaServer")) return "server";
  if (deviceType.includes("MediaRenderer")) return "renderer";
  return "other";
}

// One raw SSDP sweep, deduped by UDN (unchanged from before) -- returns
// whatever answered, with no notion of the persistent registry.
function scanOnce(timeoutMs) {
  return new Promise((resolve) => {
    const client = new Client();
    const found = new Map();

    client.on("response", (headers) => {
      if (headers.LOCATION && headers.USN)
        found.set(headers.USN, headers.LOCATION);
    });

    client.search("ssdp:all");

    setTimeout(async () => {
      client.stop();

      const byUdn = new Map();
      for (const [usn, location] of found.entries()) {
        try {
          const desc = await fetchDeviceDescription(location);
          const kind = classify(desc.deviceType);
          if (kind === "other") continue;
          if (!byUdn.has(desc.udn)) byUdn.set(desc.udn, { usn, kind, ...desc });
        } catch (err) {
          // Device didn't answer with valid XML in time -- skip it quietly.
        }
      }
      resolve([...byUdn.values()]);
    }, timeoutMs);
  });
}

/**
 * Run one SSDP sweep and reconcile it against the persistent registry:
 * anything that answered is marked 'online' and persisted to disk (in
 * case its location/IP changed); anything previously known but silent
 * this pass is marked 'offline' rather than dropped, so it keeps
 * showing up in the UI (greyed out) instead of disappearing.
 */
async function discover(timeoutMs = 4000) {
  const seen = await scanOnce(timeoutMs);
  const seenUsns = new Set(seen.map((d) => d.usn));

  for (const device of seen) {
    const entry = { ...device, status: "online", lastSeen: Date.now() };
    registry.set(device.usn, entry);
    deviceStore.save(entry);
  }

  for (const [usn, entry] of registry.entries()) {
    if (!seenUsns.has(usn) && entry.status !== "offline") {
      registry.set(usn, { ...entry, status: "offline" });
    }
  }

  return [...registry.values()];
}

function getCached(usn) {
  return registry.get(usn);
}

function allCached() {
  return [...registry.values()];
}

module.exports = { discover, getCached, allCached };
