const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function soapEnvelope(objectId, browseFlag, startIndex, count) {
  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:Browse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">
      <ObjectID>${objectId}</ObjectID>
      <BrowseFlag>${browseFlag}</BrowseFlag>
      <Filter>*</Filter>
      <StartingIndex>${startIndex}</StartingIndex>
      <RequestedCount>${count}</RequestedCount>
      <SortCriteria></SortCriteria>
    </u:Browse>
  </s:Body>
</s:Envelope>`;
}

/**
 * Browse a ContentDirectory service (e.g. MiniDLNA) starting at objectId
 * ("0" = root). Returns { containers, items } parsed from the DIDL-Lite
 * fragment embedded in the SOAP response.
 */
async function browse(controlURL, objectId = '0', { startIndex = 0, count = 200 } = {}) {
  const body = soapEnvelope(objectId, 'BrowseDirectChildren', startIndex, count);

  const res = await axios.post(controlURL, body, {
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      SOAPACTION: '"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"',
    },
    timeout: 8000,
  });

  const parsed = xmlParser.parse(res.data);
  const browseResponse =
    parsed['s:Envelope']?.['s:Body']?.['u:BrowseResponse'];
  if (!browseResponse) throw new Error('Malformed Browse response');

  const didl = xmlParser.parse(browseResponse.Result);
  const root = didl['DIDL-Lite'] || {};

  let containers = root.container || [];
  let items = root.item || [];
  if (!Array.isArray(containers)) containers = [containers];
  if (!Array.isArray(items)) items = [items];

  return {
    numberReturned: browseResponse.NumberReturned,
    totalMatches: browseResponse.TotalMatches,
    containers: containers.map(normalizeContainer),
    items: items.map(normalizeItem),
  };
}

function normalizeContainer(c) {
  return {
    id: c['@_id'],
    parentId: c['@_parentID'],
    title: c['dc:title'],
    childCount: c['@_childCount'],
    type: 'container',
  };
}

function normalizeItem(i) {
  // <res> may be a single object or an array (multiple resolutions/protocols)
  let res = i.res;
  if (Array.isArray(res)) res = res[0];

  // MiniDLNA's <res protocolInfo="http-get:*:video/x-matroska:DLNA.ORG_PN=...">
  // tells us the *actual* mimetype and DLNA feature flags for this file.
  // This has to be threaded through to playback unchanged -- passing the
  // wrong mimetype to the renderer (or none at all) is a common cause of
  // TVs rejecting playback outright.
  const protocolInfo = typeof res === 'object' ? res['@_protocolInfo'] : undefined;
  let mimeType, dlnaFeatures;
  if (protocolInfo) {
    const parts = protocolInfo.split(':'); // protocol : network : mimetype : dlnaFeatures
    mimeType = parts[2];
    dlnaFeatures = parts[3];
  }

  const upnpClass = i['upnp:class'] || '';
  const mediaKind = upnpClass.includes('video')
    ? 'video'
    : upnpClass.includes('audio')
    ? 'audio'
    : upnpClass.includes('image')
    ? 'image'
    : undefined;

  return {
    id: i['@_id'],
    parentId: i['@_parentID'],
    title: i['dc:title'],
    class: upnpClass,
    mediaKind,
    mediaUrl: typeof res === 'object' ? res['#text'] : res,
    protocolInfo,
    mimeType,
    dlnaFeatures,
    duration: typeof res === 'object' ? res['@_duration'] : undefined,
    size: typeof res === 'object' ? res['@_size'] : undefined,
    type: 'item',
  };
}

module.exports = { browse };
