'use strict';

const net = require('net');
const forge = require('node-forge');
const { Blowfish } = require('./blowfish');
const { decryptInit, encryptPacket, decryptPacket } = require('./loginCrypt');

// Reverse the RSA modulus scrambling applied by ScrambledKeyPair.java
function unscramble(mod) {
  const m = Buffer.from(mod);
  // Reverse step 4: XOR last 0x40 bytes with first 0x40
  for (let i = 0; i < 0x40; i++) m[0x40 + i] ^= m[i];
  // Reverse step 3: XOR bytes 0x0d-0x10 with 0x34-0x38
  for (let i = 0; i < 4; i++) m[0x0d + i] ^= m[0x34 + i];
  // Reverse step 2: XOR first 0x40 with last 0x40
  for (let i = 0; i < 0x40; i++) m[i] ^= m[0x40 + i];
  // Reverse step 1: swap bytes 0x00-0x03 with 0x4d-0x50
  for (let i = 0; i < 4; i++) {
    const t = m[i]; m[i] = m[0x4d + i]; m[0x4d + i] = t;
  }
  return m;
}

// Encrypt username+password into a 128-byte RSA block (old auth method).
function buildRsaBlock(scrambledModulus, username, password) {
  const modBytes = unscramble(scrambledModulus);

  // Build RSA public key: modulus + exponent 65537
  const n = new forge.jsbn.BigInteger(modBytes.toString('hex'), 16);
  const e = new forge.jsbn.BigInteger('10001', 16);
  const pubKey = forge.pki.setRsaPublicKey(n, e);

  // Build 128-byte plaintext block
  const plain = Buffer.alloc(128, 0);
  const userBuf = Buffer.from(username, 'utf8');
  const passBuf = Buffer.from(password, 'utf8');
  userBuf.copy(plain, 0x5E, 0, Math.min(userBuf.length, 14));
  passBuf.copy(plain, 0x6C, 0, Math.min(passBuf.length, 16));

  // RSA encrypt (no padding = raw modular exponentiation m^e mod n)
  const m = new forge.jsbn.BigInteger(plain.toString('hex'), 16);
  const c = m.modPow(e, n);

  // Convert BigInteger result to 128-byte buffer (big-endian, zero-padded)
  const cHex = c.toString(16).padStart(256, '0');
  return Buffer.from(cHex, 'hex');
}

class LoginClient {
  constructor(opts) {
    this.host = opts.host;
    this.port = opts.port || 2106;
    this.username = opts.username;
    this.password = opts.password;

    this._socket = null;
    this._buf = Buffer.alloc(0);
    this._sessionId = 0;
    this._scrambledModulus = null;
    this._sessionBF = null;
    this._sessionKey = null; // { loginOk1, loginOk2, playOk1, playOk2 }

    this.onLog = opts.onLog || (() => {});
    this.onServerList = opts.onServerList || (() => {});
    this.onPlayOk = opts.onPlayOk || (() => {});
    this.onError = opts.onError || (() => {});
    this.onClose = opts.onClose || (() => {});
  }

  connect() {
    this._log('Verbinde mit Login-Server ' + this.host + ':' + this.port);
    this._socket = net.createConnection({ host: this.host, port: this.port });
    this._socket.on('data', d => this._onData(d));
    this._socket.on('error', e => { this._log('Fehler: ' + e.message); this.onError(e); });
    this._socket.on('close', () => { this._log('Login-Server Verbindung getrennt'); this.onClose(); });
  }

  _log(msg) { this.onLog('[Login] ' + msg); }

  _onData(data) {
    this._buf = Buffer.concat([this._buf, data]);
    while (this._buf.length >= 2) {
      const size = this._buf.readUInt16LE(0);
      if (this._buf.length < size) break;
      const payload = this._buf.slice(2, size);
      this._buf = this._buf.slice(size);
      this._handlePacket(payload);
    }
  }

  _handlePacket(payload) {
    let data;
    if (!this._sessionBF) {
      // First packet: Init, encrypted with static key
      data = decryptInit(payload);
    } else {
      data = decryptPacket(this._sessionBF, payload);
    }

    const opcode = data[0];
    switch (opcode) {
      case 0x00: this._handleInit(data); break;
      case 0x0B: this._handleGGAuth(data); break;
      case 0x03: this._handleLoginOk(data); break;
      case 0x04: this._handleServerList(data); break;
      case 0x07: this._handlePlayOk(data); break;
      case 0x01: this._handleLoginFail(data); break;
      default:
        this._log('Unbekannter Opcode: 0x' + opcode.toString(16));
    }
  }

  _handleInit(data) {
    this._sessionId = data.readInt32LE(1);
    // protocol = data.readInt32LE(5) // 0xC621
    this._scrambledModulus = data.slice(9, 137);     // 128 bytes RSA key
    // GG data at 137..152
    const bfKey = data.slice(153, 169);              // 16 bytes session blowfish key
    this._sessionBF = new Blowfish(bfKey);
    this._log('Init empfangen. SessionId=0x' + this._sessionId.toString(16));

    // Send AuthGameGuard
    this._sendAuthGameGuard();
  }

  _sendAuthGameGuard() {
    const payload = Buffer.alloc(21);
    payload[0] = 0x07; // opcode
    payload.writeInt32LE(this._sessionId, 1);
    // 4 reserved ints = 0 (already zeroed)
    this._send(payload);
    this._log('AuthGameGuard gesendet');
  }

  _handleGGAuth(data) {
    this._log('GGAuth empfangen. Sende RequestAuthLogin...');
    this._sendAuthLogin();
  }

  _sendAuthLogin() {
    const rsaBlock = buildRsaBlock(this._scrambledModulus, this.username, this.password);
    const payload = Buffer.alloc(1 + 128);
    payload[0] = 0x00; // opcode
    rsaBlock.copy(payload, 1);
    this._send(payload);
    this._log('RequestAuthLogin gesendet');
  }

  _handleLoginOk(data) {
    const loginOk1 = data.readInt32LE(1);
    const loginOk2 = data.readInt32LE(5);
    this._sessionKey = { loginOk1, loginOk2, playOk1: 0, playOk2: 0 };
    this._log('LoginOk. Key1=0x' + loginOk1.toString(16));
    this._sendServerList();
  }

  _sendServerList() {
    const payload = Buffer.alloc(9);
    payload[0] = 0x05;
    payload.writeInt32LE(this._sessionKey.loginOk1, 1);
    payload.writeInt32LE(this._sessionKey.loginOk2, 5);
    this._send(payload);
    this._log('RequestServerList gesendet');
  }

  _handleServerList(data) {
    const serverCount = data[1];
    const lastServer = data[2];
    const servers = [];
    let off = 3;
    for (let i = 0; i < serverCount; i++) {
      const id = data[off];
      const ip = `${data[off+1]}.${data[off+2]}.${data[off+3]}.${data[off+4]}`;
      const port = data.readInt32LE(off + 5);
      const ageLimit = data[off + 9];
      const pvp = data[off + 10];
      const players = data.readInt16LE(off + 11);
      const maxPlayers = data.readInt16LE(off + 13);
      const isUp = data[off + 15];
      off += 16 + 4 + 1; // serverType(4) + brackets(1)
      servers.push({ id, ip, port, pvp, players, maxPlayers, isUp });
    }
    this._log('ServerList: ' + servers.map(s => `[${s.id}] ${s.ip}:${s.port} (${s.players}/${s.maxPlayers})`).join(', '));
    this.onServerList(servers);

    // Auto-select first online server
    const target = servers.find(s => s.isUp) || servers[0];
    if (target) this._sendServerLogin(target.id);
  }

  _sendServerLogin(serverId) {
    const payload = Buffer.alloc(10);
    payload[0] = 0x02;
    payload.writeInt32LE(this._sessionKey.loginOk1, 1);
    payload.writeInt32LE(this._sessionKey.loginOk2, 5);
    payload[9] = serverId;
    this._send(payload);
    this._log('RequestServerLogin gesendet. Server=' + serverId);
  }

  _handlePlayOk(data) {
    const playOk1 = data.readInt32LE(1);
    const playOk2 = data.readInt32LE(5);
    this._sessionKey.playOk1 = playOk1;
    this._sessionKey.playOk2 = playOk2;
    this._log('PlayOk! Key1=0x' + playOk1.toString(16));
    this._socket.destroy();
    this.onPlayOk(this._sessionKey, this.username);
  }

  _handleLoginFail(data) {
    const reason = data.readInt32LE(1);
    const reasons = {
      0x01: 'System-Fehler',
      0x02: 'Passwort falsch',
      0x03: 'Passwort falsch',
      0x04: 'Zugriff verweigert',
      0x07: 'Account in Benutzung',
    };
    this._log('Login fehlgeschlagen: ' + (reasons[reason] || '0x' + reason.toString(16)));
    this.onError(new Error('Login fehlgeschlagen: ' + (reasons[reason] || reason)));
  }

  _send(payload) {
    const encrypted = encryptPacket(this._sessionBF, payload);
    const packet = Buffer.alloc(2 + encrypted.length);
    packet.writeUInt16LE(packet.length, 0);
    encrypted.copy(packet, 2);
    this._socket.write(packet);
  }

  selectServer(serverId) {
    this._sendServerLogin(serverId);
  }
}

module.exports = { LoginClient };
