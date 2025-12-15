/**
 * Victron BLE HTTP Gateway (Gen2+)
 *
 * Continuously scans BLE advertisements and forwards selected packets
 * immediately via HTTP POST.
 *
 * Designed for Shelly PLUS / Pro (Gen2+) devices with BLE.
 * Not compatible with Gen1 Shelly devices.
 *
 * Typical use cases:
 *  - Victron Venus OS BLE gateway
 *  - Local BLE telemetry ingestion
 *  - Cloud-less integrations
 *
 * Payload format (HTTP POST, application/json):
 *
 * {
 *   "data": {
 *     "coordinates": "",
 *     "timestamp": <unix>,
 *     "nonce": <random>,
 *     "gw_mac": "AA:BB:CC:DD:EE:FF",
 *     "tags": {
 *       "11:22:33:44:55:66": {
 *         "rssi": -67,
 *         "timestamp": <unix>,
 *         "data": "02011AFF..."
 *       }
 *     }
 *   }
 * }
 */

/************ USER CONFIG ************/
let URL = "http://venus.local/ble-gw"; // HTTP endpoint
let DBG = false;                        // Enable debug logging

// Allowed BLE manufacturer IDs (empty array = allow all)
let MFG = [0x0499, 0x0059, 0x0067, 0x02E1, 0x0F53];

let RATE_LIMIT_SEC = 5;        // Per-device rate limit
let MAX_LASTSENT_ENTRIES = 50; // Max tracked BLE devices
let CLEANUP_INTERVAL_SEC = 300;// Cleanup interval (seconds)
/********** END USER CONFIG **********/

let gwMac = "00:00:00:00:00:00";
let busy = false;
let lastSent = {};
let currentMac = "";
let busyTimer = null;
let consecutiveErrors = 0;
let backoffUntil = 0;

function httpCallback(r, e) {
    busy = false;

    if (busyTimer !== null) {
        Timer.clear(busyTimer);
        busyTimer = null;
    }

    if (DBG) {
        print(">>> HTTP callback executed: e=" + e + ", r=" + (r ? "exists" : "null"));
    }

    if (e !== 0) {
        print("HTTP ERROR: code " + e + " for " + currentMac);
        consecutiveErrors++;
        applyBackoff();
    } else if (r) {
        if (DBG) {
            print("HTTP " + r.code + " from server for " + currentMac);
            if (r.body) print("Response: " + r.body);
        }
        if (r.code !== 200) {
            print("HTTP ERROR " + r.code + " for " + currentMac + ": " + (r.body || "no body"));
            consecutiveErrors++;
            applyBackoff();
        } else {
            consecutiveErrors = 0;
            backoffUntil = 0;
        }
    } else {
        print("HTTP callback: no response object!");
        consecutiveErrors++;
        applyBackoff();
    }
}

function resetBusy() {
    print("WATCHDOG: Resetting busy flag (HTTP timed out for " + currentMac + ")");
    busy = false;
    busyTimer = null;
    consecutiveErrors++;
    applyBackoff();
}

function applyBackoff() {
    if (consecutiveErrors <= 3) return;

    let backoffSec = Math.min(60, consecutiveErrors * 5);
    backoffUntil = Math.floor(Date.now() / 1000) + backoffSec;
    print("BACKOFF: " + consecutiveErrors + " errors, backing off for " + backoffSec + "s");
}

function cleanupLastSent() {
    let keys = [];
    for (let k in lastSent) keys[keys.length] = k;

    if (keys.length <= MAX_LASTSENT_ENTRIES) return;

    let now = Math.floor(Date.now() / 1000);
    let oldest = [];

    for (let i = 0; i < keys.length; i++) {
        oldest[oldest.length] = { mac: keys[i], age: now - lastSent[keys[i]] };
    }

    oldest.sort(function(a, b) { return b.age - a.age; });

    let toRemove = keys.length - MAX_LASTSENT_ENTRIES;
    for (let i = 0; i < toRemove; i++) delete lastSent[oldest[i].mac];

    if (DBG) print("Cleaned up " + toRemove + " old entries from lastSent");
}

function hex(s) {
    let r = "";
    for (let i = 0; i < s.length; i++) {
        let h = s.charCodeAt(i).toString(16);
        r += h.length === 1 ? "0" + h : h;
    }
    return r.toUpperCase();
}

function hasMfg(d, ids) {
    if (ids.length === 0) return true;
    for (let i = 0; i < ids.length; i++) {
        let lo = (ids[i] & 0xFF).toString(16);
        let hi = ((ids[i] >> 8) & 0xFF).toString(16);
        if (lo.length === 1) lo = "0" + lo;
        if (hi.length === 1) hi = "0" + hi;
        if (d.indexOf("FF" + lo.toUpperCase() + hi.toUpperCase()) !== -1) return true;
    }
    return false;
}

function send(mac, rssi, data) {
    if (busy) return;

    let now = Math.floor(Date.now() / 1000);
    if (backoffUntil > now) return;

    let ts = now;
    let body = '{"data":{"coordinates":"","timestamp":' + ts;
    body += ',"nonce":' + Math.floor(Math.random() * 2147483647);
    body += ',"gw_mac":"' + gwMac + '"';
    body += ',"tags":{"' + mac + '":{"rssi":' + rssi;
    body += ',"timestamp":' + ts + ',"data":"' + data + '"}}}}';

    currentMac = mac;
    busy = true;
    busyTimer = Timer.set(10000, false, resetBusy);

    Shelly.call("HTTP.POST", {
        url: URL,
        body: body,
        content_type: "application/json",
        timeout: 5
    }, httpCallback);
}

function onBle(ev, res) {
    if (ev !== BLE.Scanner.SCAN_RESULT || !res || !res.addr) return;

    let d = res.advData ? hex(res.advData) : "";
    if (!d.length || !hasMfg(d, MFG)) return;

    let m = res.addr.toUpperCase();
    if (m.indexOf(":") === -1) {
        let fm = "";
        for (let i = 0; i < m.length; i += 2) {
            if (i > 0) fm += ":";
            fm += m.substr(i, 2);
        }
        m = fm;
    }

    let now = Math.floor(Date.now() / 1000);
    if (now - (lastSent[m] || 0) < RATE_LIMIT_SEC) return;
    lastSent[m] = now;

    if (DBG) print(m + " rssi=" + res.rssi + " len=" + (d.length / 2));

    send(m, res.rssi, d);
}

function init() {
    if (DBG) print("Victron BLE HTTP Gateway starting");

    Shelly.call("Shelly.GetDeviceInfo", {}, function(r) {
        if (r && r.mac) {
            let m = r.mac;
            gwMac = "";
            for (let i = 0; i < m.length; i += 2) {
                if (i > 0) gwMac += ":";
                gwMac += m.substr(i, 2);
            }
        }
    });

    if (!BLE.Scanner.isRunning()) {
        BLE.Scanner.Start({ duration_ms: BLE.Scanner.INFINITE_SCAN, active: false });
    }

    BLE.Scanner.Subscribe(onBle);
    Timer.set(CLEANUP_INTERVAL_SEC * 1000, true, cleanupLastSent);

    if (DBG) print("BLE gateway ready, POST to " + URL);
}

init();

