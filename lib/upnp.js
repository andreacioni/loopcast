//The MIT License (MIT)
//
//Copyright (c) 2014 Thibaut Séguy <thibaut.seguy@gmail.com>
//
//Permission is hereby granted, free of charge, to any person obtaining a copy
//of this software and associated documentation files (the "Software"), to deal
//in the Software without restriction, including without limitation the rights
//to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//copies of the Software, and to permit persons to whom the Software is
//furnished to do so, subject to the following conditions:
//
//The above copyright notice and this permission notice shall be included in
//all copies or substantial portions of the Software.
//
//THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
//THE SOFTWARE.

var DeviceClient = require("upnp-device-client");
var util = require("util");
var debug = require("debug")("upnp-mediarenderer-client");
var et = require("elementtree");

var MEDIA_EVENTS = [
  "status",
  "loading",
  "playing",
  "paused",
  "stopped",
  "speedChanged",
];

function MediaRendererClient(url) {
  DeviceClient.call(this, url);
  this.instanceId = 0;

  var self = this;
  var refs = 0;
  var receivedState;

  this.addListener("newListener", function (eventName) {
    if (MEDIA_EVENTS.indexOf(eventName) === -1) return;
    if (refs === 0) {
      receivedState = false;
      self.subscribe("AVTransport", onstatus);
    }
    refs++;
  });

  this.addListener("removeListener", function (eventName) {
    if (MEDIA_EVENTS.indexOf(eventName) === -1) return;
    refs--;
    if (refs === 0) self.unsubscribe("AVTransport", onstatus);
  });

  function onstatus(e) {
    self.emit("status", e);
    if (!receivedState) {
      receivedState = true;
      return;
    }

    if (e.hasOwnProperty("TransportState")) {
      switch (e.TransportState) {
        case "TRANSITIONING":
          self.emit("loading");
          break;
        case "PLAYING":
          self.emit("playing");
          break;
        case "PAUSED_PLAYBACK":
          self.emit("paused");
          break;
        case "STOPPED":
          self.emit("stopped");
          break;
      }
    }
    if (e.hasOwnProperty("TransportPlaySpeed")) {
      self.emit("speedChanged", Number(e.TransportPlaySpeed));
    }
  }
}

util.inherits(MediaRendererClient, DeviceClient);

function callAction(client, service, action, params) {
  return new Promise(function (resolve, reject) {
    client.callAction(service, action, params, function (err, result) {
      if (err) return reject(err);
      resolve(result);
    });
  });
}

MediaRendererClient.prototype.getSupportedProtocols = async function () {
  var result = await callAction(
    this,
    "ConnectionManager",
    "GetProtocolInfo",
    {},
  );
  return result.Sink.split(",").map(function (line) {
    var tmp = line.split(":");
    return {
      protocol: tmp[0],
      network: tmp[1],
      contentFormat: tmp[2],
      additionalInfo: tmp[3],
    };
  });
};

MediaRendererClient.prototype.getPosition = async function () {
  var result = await callAction(this, "AVTransport", "GetPositionInfo", {
    InstanceID: this.instanceId,
  });
  var str =
    result.AbsTime !== "NOT_IMPLEMENTED" ? result.AbsTime : result.RelTime;
  return parseTime(str);
};

MediaRendererClient.prototype.getDuration = async function () {
  var result = await callAction(this, "AVTransport", "GetMediaInfo", {
    InstanceID: this.instanceId,
  });
  return parseTime(result.MediaDuration);
};

MediaRendererClient.prototype.load = async function (url, options) {
  options = options || {};
  var dlnaFeatures = options.dlnaFeatures || "*";
  var contentType = options.contentType || "video/mpeg";
  var protocolInfo = "http-get:*:" + contentType + ":" + dlnaFeatures;
  var metadata = options.metadata || {};
  metadata.url = url;
  metadata.protocolInfo = protocolInfo;

  if (options.prepare) {
    try {
      var result = await callAction(
        this,
        "ConnectionManager",
        "PrepareForConnection",
        {
          RemoteProtocolInfo: protocolInfo,
          PeerConnectionManager: null,
          PeerConnectionID: -1,
          Direction: "Input",
        },
      );
      this.instanceId = result.AVTransportID;
    } catch (err) {
      if (err.code !== "ENOACTION") throw err;
    }
  }

  await callAction(this, "AVTransport", "SetAVTransportURI", {
    InstanceID: this.instanceId,
    CurrentURI: url,
    CurrentURIMetaData: buildMetadata(metadata),
  });
  if (options.autoplay) await this.play();
};

MediaRendererClient.prototype.play = function () {
  return callAction(this, "AVTransport", "Play", {
    InstanceID: this.instanceId,
    Speed: 1,
  });
};

MediaRendererClient.prototype.pause = function () {
  return callAction(this, "AVTransport", "Pause", {
    InstanceID: this.instanceId,
  });
};

MediaRendererClient.prototype.stop = function () {
  return callAction(this, "AVTransport", "Stop", {
    InstanceID: this.instanceId,
  });
};

MediaRendererClient.prototype.seek = function (seconds, options) {
  return callAction(this, "AVTransport", "Seek", {
    InstanceID: this.instanceId,
    Unit: (options && options.unit) || "REL_TIME",
    Target: formatTime(seconds),
  });
};

MediaRendererClient.prototype.getVolume = async function () {
  var result = await callAction(this, "RenderingControl", "GetVolume", {
    InstanceID: this.instanceId,
    Channel: "Master",
  });
  return parseInt(result.CurrentVolume);
};

MediaRendererClient.prototype.setVolume = function (volume) {
  return callAction(this, "RenderingControl", "SetVolume", {
    InstanceID: this.instanceId,
    Channel: "Master",
    DesiredVolume: volume,
  });
};

MediaRendererClient.prototype.getTransportInfo = function () {
  return callAction(this, "AVTransport", "GetTransportInfo", {
    InstanceID: this.instanceId,
  });
};

function formatTime(seconds) {
  var h = Math.floor(seconds / 3600);
  var m = Math.floor((seconds - h * 3600) / 60);
  var s = seconds - h * 3600 - m * 60;

  function pad(v) {
    return v < 10 ? "0" + v : v;
  }
  return [pad(h), pad(m), pad(s)].join(":");
}

function parseTime(time) {
  var parts = time.split(":").map(Number);
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function buildMetadata(metadata) {
  var didl = et.Element("DIDL-Lite");
  didl.set("xmlns", "urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/");
  didl.set("xmlns:dc", "http://purl.org/dc/elements/1.1/");
  didl.set("xmlns:upnp", "urn:schemas-upnp-org:metadata-1-0/upnp/");
  didl.set("xmlns:sec", "http://www.sec.co.kr/");

  var item = et.SubElement(didl, "item");

  var OBJECT_CLASSES = {
    audio: "object.item.audioItem.musicTrack",
    video: "object.item.videoItem.movie",
    image: "object.item.imageItem.photo",
  };

  if (metadata.id) {
    item.set("id", metadata.id);
  }
  if (metadata.parentId) {
    item.set("parentID", metadata.parentId);
  }
  if (metadata.refId) {
    item.set("refID", metadata.refId);
  }
  if (metadata.restricted !== undefined) {
    item.set("restricted", metadata.restricted ? "1" : "0");
  }
  if (metadata.albumArtUrl) {
    var albumArt = et.SubElement(item, "upnp:albumArtURI");
    albumArt.text = metadata.albumArtUrl;
  }

  if (metadata.type) {
    var klass = et.SubElement(item, "upnp:class");
    klass.text = OBJECT_CLASSES[metadata.type];
  }
  if (metadata.title) {
    var title = et.SubElement(item, "dc:title");
    title.text = metadata.title;
  }
  if (metadata.creator) {
    var creator = et.SubElement(item, "dc:creator");
    creator.text = metadata.creator;
  }
  if (metadata.url && metadata.protocolInfo) {
    var res = et.SubElement(item, "res");
    res.set("protocolInfo", metadata.protocolInfo);
    //res.text = metadata.url;
  }
  if (metadata.subtitlesUrl) {
    var captionInfo = et.SubElement(item, "sec:CaptionInfo");
    captionInfo.set("sec:type", "srt");
    captionInfo.text = metadata.subtitlesUrl;
    var captionInfoEx = et.SubElement(item, "sec:CaptionInfoEx");
    captionInfoEx.set("sec:type", "srt");
    captionInfoEx.text = metadata.subtitlesUrl;
    var subtitleRes = et.SubElement(item, "res");
    subtitleRes.set("protocolInfo", "http-get:*:text/srt:*");
    subtitleRes.text = metadata.subtitlesUrl;
  }

  const ret = new et.ElementTree(didl).write({ xml_declaration: false });
  console.log("Built metadata XML:", ret);
  return ret;
}

module.exports = MediaRendererClient;
