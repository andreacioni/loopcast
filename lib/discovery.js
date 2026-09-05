const { Client } = require('node-ssdp');
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

// In-memory cache of the last discovery pass, keyed by USN.
let cache = new Map();

/**
 * Fetch a device's description.xml and pull out the bits we need:
 * friendlyName, deviceType, and the controlURL for each service we care about.
 */
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
    eventSubURL: s.eventSubURL ? new URL(s.eventSubURL, baseUrl).toString() : null,
    scpdURL: s.SCPDURL ? new URL(s.SCPDURL, baseUrl).toString() : null,
  }));

  return {
    friendlyName: device.friendlyName || location,
    deviceType: device.deviceType || '',
    udn: device.UDN || location,
    manufacturer: device.manufacturer || '',
    modelName: device.modelName || '',
    location,
    baseUrl,
    services,
  };
}

function classify(deviceType = '') {
  if (deviceType.includes('MediaServer')) return 'server';
  if (deviceType.includes('MediaRenderer')) return 'renderer';
  return 'other';
}

/**
 * Run an SSDP search for both MediaServers and MediaRenderers on the LAN.
 * Resolves after `timeoutMs` with everything found, deduped by USN.
 */
function discover(timeoutMs = 4000) {
  return new Promise((resolve) => {
    const client = new Client();
    const found = new Map(); // usn -> { location, headers }

    client.on('response', (headers) => {
      if (headers.LOCATION && headers.USN) {
        found.set(headers.USN, headers.LOCATION);
      }
    });

    // ssdp:all catches both device types; MiniDLNA and most renderers
    // reply to this without needing two separate searches.
    client.search('ssdp:all');

    setTimeout(async () => {
      client.stop();

      // A single physical device answers ssdp:all once per advertised
      // service/type (root device, MediaServer type, ContentDirectory
      // service, etc.), each with a *different* USN but the *same* UDN
      // in its description XML. Dedupe on UDN, not USN, or the same TV
      // or NAS shows up several times in the device list.
      const byUdn = new Map();

      for (const [usn, location] of found.entries()) {
        try {
          const desc = await fetchDeviceDescription(location);
          const kind = classify(desc.deviceType);
          if (kind === 'other') continue; // skip IGDs, print servers, etc.
          if (!byUdn.has(desc.udn)) {
            byUdn.set(desc.udn, { usn, kind, ...desc });
          }
        } catch (err) {
          // Device didn't answer with valid XML in time — skip it quietly.
        }
      }

      const results = [...byUdn.values()];
      cache = new Map(results.map((r) => [r.usn, r]));
      resolve(results);
    }, timeoutMs);
  });
}

function getCached(usn) {
  return cache.get(usn);
}

function allCached() {
  return [...cache.values()];
}

module.exports = { discover, getCached, allCached };
