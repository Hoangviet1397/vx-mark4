// VX native bridge: inside the phone app (Capacitor, APK / IPA) there is no
// Web Bluetooth (iOS WKWebView and Android WebView lack it), so this file
// gives the page the small part of navigator.bluetooth it uses, on top of the
// native plugin @capacitor-community/bluetooth-le. In a browser it does
// nothing and the real Web Bluetooth is used.
//
// Used by index.html: requestDevice(filters / acceptAllDevices),
// getDevices(), device.gatt.connect() / disconnect(),
// 'gattserverdisconnected', getPrimaryService().getCharacteristic(),
// writeValue(), startNotifications(), 'characteristicvaluechanged'
// (event.target.value = DataView of exactly the payload).
//
// Not run on a phone yet: check on the first APK build (see app/README.md).
(function () {
  'use strict';
  const C = window.Capacitor;
  if (!C || !C.isNativePlatform || !C.isNativePlatform()) return;
  const Ble = C.Plugins && C.Plugins.BluetoothLe;
  if (!Ble) { console.warn('VX: BluetoothLe plugin missing'); return; }

  const KNOWN = 'vx.nativeBleIds';
  const known = () => { try { return JSON.parse(localStorage.getItem(KNOWN) || '[]'); } catch { return []; } };
  const remember = id => { const k = known(); if (!k.includes(id)) { k.push(id); try { localStorage.setItem(KNOWN, JSON.stringify(k)); } catch {} } };
  // plugin 7.x: values cross the bridge as hex strings without spaces ("0a1b2c")
  const hex = dv => Array.from(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)).map(b => b.toString(16).padStart(2, '0')).join('');
  // one GATT operation at a time, like the plugin's own BleClient queue
  let chain = Promise.resolve();
  const queue = fn => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
  const fromHex = s => { const b = new Uint8Array((s || '').replace(/\s/g, '').match(/.{2}/g)?.map(h => parseInt(h, 16)) || []); return new DataView(b.buffer); };
  const toDV = v => v instanceof DataView ? v : ArrayBuffer.isView(v) ? new DataView(v.buffer, v.byteOffset, v.byteLength) : new DataView(v);
  let ready = null;
  const init = () => ready || (ready = Ble.initialize({ androidNeverForLocation: true }));

  class Emitter {
    constructor() { this._l = {}; }
    addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); }
    removeEventListener(t, f) { this._l[t] = (this._l[t] || []).filter(x => x !== f); }
    _emit(t, ev) { (this._l[t] || []).forEach(f => { try { f(ev); } catch (e) { console.error(e); } }); }
  }
  class Characteristic extends Emitter {
    constructor(dev, service, uuid) { super(); this.dev = dev; this.service = service; this.uuid = uuid; this.value = null; }
    writeValue(v) { const value = hex(toDV(v)); return queue(() => Ble.write({ deviceId: this.dev.id, service: this.service, characteristic: this.uuid, value })); }
    writeValueWithResponse(v) { return this.writeValue(v); }
    async startNotifications() {
      const key = `notification|${this.dev.id}|${this.service}|${this.uuid}`;
      this._sub = await Ble.addListener(key, ev => { this.value = typeof ev.value === 'string' ? fromHex(ev.value) : toDV(ev.value); this._emit('characteristicvaluechanged', { target: this }); });
      await queue(() => Ble.startNotifications({ deviceId: this.dev.id, service: this.service, characteristic: this.uuid }));
      return this;
    }
  }
  class Service {
    constructor(dev, uuid) { this.dev = dev; this.uuid = uuid; }
    async getCharacteristic(uuid) { return new Characteristic(this.dev, this.uuid, uuid.toLowerCase()); }
  }
  class Gatt {
    constructor(dev) { this.dev = dev; this.connected = false; }
    async connect() {
      await init();
      this._sub = await Ble.addListener(`disconnected|${this.dev.id}`, () => { this.connected = false; this.dev._emit('gattserverdisconnected', { target: this.dev }); });
      await queue(() => Ble.connect({ deviceId: this.dev.id, timeout: 12000 }));
      this.connected = true; remember(this.dev.id);
      return this;
    }
    disconnect() { this.connected = false; return Ble.disconnect({ deviceId: this.dev.id }).catch(() => {}); }
    async getPrimaryService(uuid) { return new Service(this.dev, uuid.toLowerCase()); }
  }
  class Device extends Emitter {
    constructor(d) { super(); this.id = d.deviceId; this.name = d.name || ''; this.gatt = new Gatt(this); }
  }

  navigator.bluetooth = {
    async requestDevice(opt) {
      await init();
      opt = opt || {};
      const f = (opt.filters || [])[0] || {};
      const q = { optionalServices: (opt.optionalServices || []).map(s => s.toLowerCase()) };
      if (!opt.acceptAllDevices) {
        if (f.services) q.services = f.services.map(s => s.toLowerCase());
        // one name prefix for the native chooser; the page checks the speaker anyway
        if (f.namePrefix && (opt.filters || []).length === 1) q.namePrefix = f.namePrefix;
      }
      const d = await queue(() => Ble.requestDevice(q));
      return new Device(d);
    },
    async getDevices() {
      await init();
      const ids = known(); if (!ids.length) return [];
      try { const r = await Ble.getDevices({ deviceIds: ids }); return (r.devices || []).map(d => new Device(d)); }
      catch { return ids.map(id => new Device({ deviceId: id })); }
    },
    getAvailability: async () => true,
    native: true
  };
  window.VX_NATIVE = true;
})();
