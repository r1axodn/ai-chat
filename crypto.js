/*!
 * crypto.js — AI 공용방의 암호화 계층 (Web Crypto 전용, 외부 라이브러리 없음)
 *
 * 쓰는 것
 *  · 초대 토큰  s1.<tokenId>.<wrapKey>
 *      tokenId  : 24바이트 난수 (서버에는 SHA-256 해시만 저장)
 *      wrapKey  : 32바이트 난수 (링크를 가진 사람만 가짐, 서버에는 절대 저장 안 함)
 *  · 방 열쇠(roomKey, 32바이트)는 초대를 만들 때 AES-GCM(wrapKey)로 감싸서만 저장한다.
 *      → DB를 통째로 읽어도 방 열쇠는 열 수 없다. (토큰 링크 + 입장 암호 둘 다 있어야 함)
 *  · 입장 암호는 평문 저장 없이 PBKDF2-SHA256(랜덤 salt, 15만 회) 해시로만 다룬다.
 *  · 메시지 본문도 roomKey 로 AES-GCM 암호화한 뒤 저장한다. (DB·Realtime 에는 암호문만 흐름)
 */
(function (global) {
  'use strict';

  var enc = new TextEncoder();
  var dec = new TextDecoder();
  var webcrypto = global.crypto || global.msCrypto;

  var PASSCODE_ITERATIONS = 150000;
  var TOKEN_PREFIX = 's1';

  function hasSubtle() {
    return !!(webcrypto && webcrypto.subtle && typeof webcrypto.subtle.digest === 'function');
  }

  function base64url(bytes) {
    var arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var s = '';
    for (var i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromBase64url(text) {
    var s = String(text || '').replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  function toHex(buffer) {
    var arr = new Uint8Array(buffer);
    var s = '';
    for (var i = 0; i < arr.length; i++) s += (arr[i] < 16 ? '0' : '') + arr[i].toString(16);
    return s;
  }

  function fromHex(text) {
    var s = String(text || '');
    var arr = new Uint8Array(s.length / 2);
    for (var i = 0; i < arr.length; i++) arr[i] = parseInt(s.substr(i * 2, 2), 16);
    return arr;
  }

  function randomBytes(n) {
    var arr = new Uint8Array(n);
    webcrypto.getRandomValues(arr);
    return arr;
  }

  function randomToken(bytes) {
    return base64url(randomBytes(bytes || 24));
  }

  function randomHex(bytes) {
    return toHex(randomBytes(bytes || 16));
  }

  function sha256Hex(text) {
    return webcrypto.subtle.digest('SHA-256', enc.encode(String(text))).then(toHex);
  }

  /* 입장 암호 → salt 가 붙은 해시 (PBKDF2-SHA256) */
  function passcodeHash(passcode, saltHex, iterations) {
    var rounds = iterations || PASSCODE_ITERATIONS;
    return webcrypto.subtle
      .importKey('raw', enc.encode(String(passcode)), 'PBKDF2', false, ['deriveBits'])
      .then(function (key) {
        return webcrypto.subtle.deriveBits(
          { name: 'PBKDF2', salt: fromHex(saltHex), iterations: rounds, hash: 'SHA-256' },
          key,
          256
        );
      })
      .then(toHex);
  }

  function importAes(rawBytes) {
    return webcrypto.subtle.importKey('raw', rawBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  /* AES-GCM 문자열 암호화 → "v1.<iv>.<ciphertext>" */
  function encryptString(keyBytes, plaintext) {
    var iv = randomBytes(12);
    var keyP = importAes(keyBytes);
    return Promise.all([keyP]).then(function (keys) {
      return webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, keys[0], enc.encode(String(plaintext)));
    }).then(function (ct) {
      return 'v1.' + base64url(iv) + '.' + base64url(new Uint8Array(ct));
    });
  }

  function decryptString(keyBytes, blob) {
    var parts = String(blob || '').split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') return Promise.reject(new Error('bad_blob'));
    var iv = fromBase64url(parts[1]);
    var ct = fromBase64url(parts[2]);
    return importAes(keyBytes).then(function (key) {
      return webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, ct);
    }).then(function (plain) {
      return dec.decode(plain);
    });
  }

  /* ---------------------------------------------------------------- 초대 토큰 */

  /**
   * 초대 하나를 만든다.
   * @param {string} roomKeyB64  방 열쇠 (base64url, 32바이트)
   * @param {string} passcode    방장이 정한 입장 암호
   * @returns {Promise<{token, tokenHash, wrappedKey, passSalt, passHash}>}
   */
  function makeInvite(roomKeyB64, passcode) {
    var tokenId = randomToken(24);
    var wrapKey = randomBytes(32);
    var salt = randomHex(16);
    var token = TOKEN_PREFIX + '.' + tokenId + '.' + base64url(wrapKey);
    return Promise.all([
      sha256Hex(tokenId),
      passcodeHash(passcode, salt),
      encryptString(wrapKey, roomKeyB64)
    ]).then(function (r) {
      return {
        token: token,
        tokenId: tokenId,
        tokenHash: r[0],
        wrappedKey: r[2],
        passSalt: salt,
        passHash: r[1]
      };
    });
  }

  /** 링크의 토큰 문자열을 해석한다. */
  function parseInviteToken(token) {
    var parts = String(token || '').trim().split('.');
    if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;
    if (!parts[1] || !parts[2]) return null;
    return { tokenId: parts[1], wrapKeyB64: parts[2] };
  }

  /** 서버가 돌려준 감싼 열쇠 + 링크의 wrapKey → 방 열쇠 */
  function unwrapRoomKey(wrappedKey, wrapKeyB64) {
    return decryptString(fromBase64url(wrapKeyB64), wrappedKey).catch(function () {
      throw new Error('invite_key_mismatch');
    });
  }

  /* ---------------------------------------------------------------- 방 비밀번호
   *
   *  루트 주소(초대 링크 없이)에서 들어올 때 쓰는 '방 비밀번호'.
   *  · 검증용 해시(pass_hash)와 방 열쇠를 감싸는 키는 서로 다른 PBKDF2 유도값을 쓴다.
   *    (DB 를 읽은 사람이 pass_hash 로 방 열쇠를 풀 수 없게 하기 위해서)
   */

  function deriveRoomWrapKey(passcode, saltHex) {
    var salt = fromHex(saltHex);
    var extra = enc.encode('|roomkey|v1');
    var mixed = new Uint8Array(salt.length + extra.length);
    mixed.set(salt, 0);
    mixed.set(extra, salt.length);
    return webcrypto.subtle
      .importKey('raw', enc.encode(String(passcode)), 'PBKDF2', false, ['deriveBits'])
      .then(function (key) {
        return webcrypto.subtle.deriveBits(
          { name: 'PBKDF2', salt: mixed, iterations: PASSCODE_ITERATIONS, hash: 'SHA-256' },
          key,
          256
        );
      })
      .then(function (bits) {
        return new Uint8Array(bits);
      });
  }

  /** 방 열쇠를 방 비밀번호로 감싼다. */
  function wrapRoomKeyWithPassword(roomKeyB64, passcode) {
    var salt = randomHex(16);
    return Promise.all([passcodeHash(passcode, salt), deriveRoomWrapKey(passcode, salt)]).then(function (r) {
      return encryptString(r[1], roomKeyB64).then(function (wrapped) {
        return { passSalt: salt, passHash: r[0], wrappedKey: wrapped };
      });
    });
  }

  /** 방 비밀번호 + 감싼 열쇠 → 방 열쇠 */
  function unwrapRoomKeyWithPassword(wrappedKey, passcode, saltHex) {
    return deriveRoomWrapKey(passcode, saltHex).then(function (keyBytes) {
      return decryptString(keyBytes, wrappedKey).catch(function () {
        throw new Error('room_password_mismatch');
      });
    });
  }

  /* ---------------------------------------------------------------- 유틸 */

  /** 32바이트 방 열쇠 만들기 */
  function newRoomKey() {
    return base64url(randomBytes(32));
  }

  function roomKeyBytes(roomKeyB64) {
    return fromBase64url(roomKeyB64);
  }

  global.SquadCrypto = {
    hasSubtle: hasSubtle,
    base64url: base64url,
    fromBase64url: fromBase64url,
    randomToken: randomToken,
    randomHex: randomHex,
    sha256Hex: sha256Hex,
    passcodeHash: passcodeHash,
    encryptString: encryptString,
    decryptString: decryptString,
    makeInvite: makeInvite,
    parseInviteToken: parseInviteToken,
    unwrapRoomKey: unwrapRoomKey,
    wrapRoomKeyWithPassword: wrapRoomKeyWithPassword,
    unwrapRoomKeyWithPassword: unwrapRoomKeyWithPassword,
    newRoomKey: newRoomKey,
    roomKeyBytes: roomKeyBytes,
    PASSCODE_ITERATIONS: PASSCODE_ITERATIONS
  };
})(typeof window !== 'undefined' ? window : this);
