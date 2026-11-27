/*!
 * store.js — 저장소 어댑터
 *
 * 두 가지 구현이 같은 인터페이스를 쓴다.
 *  · DemoStore     : localStorage (브라우저를 닫아도 유지). 탭 사이 실시간은 BroadcastChannel.
 *  · SupabaseStore : squad_* 테이블 + SECURITY DEFINER RPC + Realtime 구독(+폴링 폴백).
 *
 * 어느 쪽이든 메시지 본문은 roomKey 로 암호화된 암호문(body_ct)만 저장한다.
 * 저장하는 것: 방/멤버(프로필 사진 포함)/초대/메시지 전부.
 */
(function (global) {
  'use strict';

  var C = global.SquadCrypto;
  var DEMO_DB_KEY = 'squad.demo.v1';
  var CFG_KEY = 'squad.config.v1';
  var SESSION_KEY = 'squad.sessions.v1';
  var AI_TOKEN_KEY = 'squad.aitokens.v1';
  var ACTIVE_KEY = 'squad.active.v1';
  var DEMO_CHANNEL = 'squad-demo-room';

  var PASSCODE_FAIL_LIMIT = 5;
  var PASSCODE_LOCK_MS = 15 * 60 * 1000;
  var MAX_DEMO_MESSAGES = 5000;
  var MAX_USES_CAP = 1000;

  function nowIso() {
    return new Date().toISOString();
  }

  /* ---------------------------------------------------------------- 사용 인원
   *  max_uses === null  → 무제한 (schema.sql 의 max_uses null 과 같은 뜻)
   *  숫자                → 그 횟수만큼
   *  0·음수·''           → 무제한으로 본다 (예전 화면에서 0 을 넘겨도 안전하게)
   */

  function isUnlimitedUses(value) {
    if (value == null || value === '') return true;
    var n = Number(value);
    return !isFinite(n) || n <= 0;
  }

  /** 초대를 만들 때 쓰는 정규화: 넘기지 않으면 1명, null(또는 0)이면 무제한. */
  function normalizeMaxUses(value) {
    if (value === null) return null;
    if (value === undefined || value === '') return 1;
    var n = Math.floor(Number(value));
    if (!isFinite(n) || n <= 0) return null;
    return Math.max(1, Math.min(MAX_USES_CAP, n));
  }

  /** 같은 이름인지 (앞뒤 공백 무시, 대소문자 무시) */
  function sameName(a, b) {
    return (
      String(a == null ? '' : a).trim().toLowerCase() ===
      String(b == null ? '' : b).trim().toLowerCase()
    );
  }

  /** 방장으로 로그인하는 이름 (대소문자 무시) */
  var HOST_ALIASES = ['taewoo', '태우'];
  function isHostAlias(name) {
    return HOST_ALIASES.indexOf(String(name == null ? '' : name).trim().toLowerCase()) >= 0;
  }

  function isFullInvite(uses, maxUses) {
    if (isUnlimitedUses(maxUses)) return false;
    return Number(uses || 0) >= Number(maxUses);
  }

  function uid(prefix) {
    return (prefix || 'id') + '_' + C.randomToken(12).replace(/[-_]/g, '').slice(0, 18);
  }

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function safeParse(text, fallback) {
    try {
      var v = JSON.parse(text);
      return v == null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function readLS(key, fallback) {
    try {
      return safeParse(localStorage.getItem(key), fallback);
    } catch (e) {
      return fallback;
    }
  }

  function writeLS(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ---------------------------------------------------------------- 설정 / 세션 */

  function loadConfig() {
    var base = global.SQUAD_CONFIG || {};
    var saved = readLS(CFG_KEY, {});
    return {
      supabaseUrl: (saved.supabaseUrl || base.supabaseUrl || '').trim().replace(/\/+$/, ''),
      supabaseKey: (saved.supabaseKey || base.supabaseKey || '').trim(),
      geminiKey: '' // 세션 전용 — 여기 저장하지 않는다
    };
  }

  function saveConfig(cfg) {
    writeLS(CFG_KEY, {
      supabaseUrl: (cfg.supabaseUrl || '').trim().replace(/\/+$/, ''),
      supabaseKey: (cfg.supabaseKey || '').trim()
    });
  }

  function isLiveConfigured() {
    var c = loadConfig();
    return !!(c.supabaseUrl && c.supabaseKey);
  }

  function listSessions() {
    return readLS(SESSION_KEY, {});
  }

  function sessionKeyOf(roomId, memberId) {
    return roomId + '::' + memberId;
  }

  /* 방 하나에 여러 사람(방장/게스트/AI)이 들어온 브라우저도 각자 세션을 유지한다. */
  function getSession(roomId, memberId) {
    var key = memberId ? sessionKeyOf(roomId, memberId) : roomId;
    var all = listSessions();
    if (all[key]) return all[key];
    if (memberId) {
      var hit = null;
      Object.keys(all).forEach(function (k) {
        if (all[k].roomId === roomId && all[k].memberId === memberId) hit = all[k];
      });
      return hit;
    }
    var found = null;
    Object.keys(all).forEach(function (k) {
      if (all[k].roomId === roomId) found = all[k]; // 구버전 키 호환
    });
    return found;
  }

  function saveSession(session) {
    var all = listSessions();
    all[sessionKeyOf(session.roomId, session.memberId)] = session;
    writeLS(SESSION_KEY, all);
    setActive(session.roomId, session.memberId);
  }

  function dropSession(roomId, memberId) {
    var all = listSessions();
    Object.keys(all).forEach(function (k) {
      if (all[k].roomId !== roomId) return;
      if (memberId && all[k].memberId !== memberId) return;
      delete all[k];
    });
    writeLS(SESSION_KEY, all);
  }

  /* 탭마다 '지금 이 탭에서 쓰는 신분'을 따로 기억한다 (같은 브라우저에서 방장 탭 + 게스트 탭 동시 테스트용) */
  function setActive(roomId, memberId) {
    try {
      sessionStorage.setItem(ACTIVE_KEY, sessionKeyOf(roomId, memberId));
    } catch (e) {
      /* noop */
    }
  }

  function getActiveSession() {
    var raw = '';
    try {
      raw = sessionStorage.getItem(ACTIVE_KEY) || '';
    } catch (e) {
      return null;
    }
    if (!raw) return null;
    var all = listSessions();
    return all[raw] || null;
  }

  function currentSession() {
    var active = getActiveSession();
    if (active) return active;
    var all = listSessions();
    var ids = Object.keys(all);
    if (!ids.length) return null;
    // 가장 최근에 쓴 방
    ids.sort(function (a, b) {
      return String(all[b].at || '').localeCompare(String(all[a].at || ''));
    });
    return all[ids[0]];
  }

  function getAiTokens(roomId) {
    var all = readLS(AI_TOKEN_KEY, {});
    return all[roomId] || {};
  }

  function saveAiToken(roomId, memberId, token) {
    var all = readLS(AI_TOKEN_KEY, {});
    var room = all[roomId] || (all[roomId] = {});
    room[memberId] = token;
    writeLS(AI_TOKEN_KEY, all);
  }

  /* ---------------------------------------------------------------- Demo store */

  var demoChannel = null;
  function channel() {
    if (demoChannel) return demoChannel;
    if (typeof BroadcastChannel === 'function') {
      demoChannel = new BroadcastChannel(DEMO_CHANNEL);
    }
    return demoChannel;
  }

  function emptyDemoDb() {
    return { v: 1, rooms: {}, members: {}, invites: {}, messages: [], seeded: false };
  }

  function readDemo() {
    var db = readLS(DEMO_DB_KEY, null);
    if (!db || typeof db !== 'object' || !db.rooms) return emptyDemoDb();
    db.members = db.members || {};
    db.invites = db.invites || {};
    db.messages = db.messages || [];
    return db;
  }

  function writeDemo(db) {
    if (db.messages.length > MAX_DEMO_MESSAGES) {
      db.messages = db.messages.slice(-MAX_DEMO_MESSAGES);
    }
    var ok = writeLS(DEMO_DB_KEY, db);
    var ch = channel();
    if (ch) {
      try {
        ch.postMessage({ type: 'changed', at: Date.now() });
      } catch (e) {
        /* noop */
      }
    }
    return ok;
  }

  function DemoStore() {
    this.mode = 'demo';
    this.label = '로컬 데모';
    this.caps = { version: 2, unlimited: true, rejoin: true };
  }

  /* 데모 저장소는 항상 이 버전의 규칙을 그대로 쓴다. */
  DemoStore.prototype.supportsUnlimited = function () {
    return true;
  };

  DemoStore.prototype.supportsRejoin = function () {
    return true;
  };

  DemoStore.prototype.supportsRoomLogin = function () {
    return true;
  };

  DemoStore.prototype.init = function () {
    var self = this;
    if (!C.hasSubtle()) return Promise.reject(new Error('crypto_unavailable'));
    this._listeners = [];
    this._ch = channel();
    if (this._ch) {
      this._onBroadcast = function (evt) {
        if (!evt || !evt.data) return;
        self._emit({ type: 'changed', data: evt.data });
      };
      this._ch.addEventListener('message', this._onBroadcast);
    }
    this._onStorage = function (evt) {
      if (evt && evt.key === DEMO_DB_KEY) self._emit({ type: 'changed', data: {} });
    };
    global.addEventListener('storage', this._onStorage);
    return Promise.resolve();
  };

  DemoStore.prototype._emit = function (evt) {
    (this._listeners || []).forEach(function (fn) {
      try {
        fn(evt);
      } catch (e) {
        /* noop */
      }
    });
  };

  DemoStore.prototype.subscribe = function (roomId, handlers) {
    var self = this;
    handlers = handlers || {};
    var seen = {};
    var subscriber = function (evt) {
      if (evt.type !== 'changed') return;
      if (handlers.onChange) handlers.onChange();
      self.listMessages(roomId).then(function (rows) {
        rows.forEach(function (row) {
          if (seen[row.id]) return;
          seen[row.id] = true;
          if (handlers.onMessage) handlers.onMessage(row);
        });
      });
    };
    this._listeners.push(subscriber);
    this.listMessages(roomId).then(function (rows) {
      rows.forEach(function (r) {
        seen[r.id] = true;
      });
    });
    return function () {
      self._listeners = self._listeners.filter(function (fn) {
        return fn !== subscriber;
      });
    };
  };

  DemoStore.prototype.createRoom = function (opts) {
    var db = readDemo();
    var roomId = uid('room');
    var memberId = uid('mem');
    var hostToken = C.randomToken(32);
    var roomKey = C.newRoomKey();
    return C.sha256Hex(hostToken).then(function (hash) {
      db.rooms[roomId] = {
        id: roomId,
        name: (opts.name || 'AI 공용방').slice(0, 40),
        host_token_hash: hash,
        created_at: nowIso()
      };
      db.members[memberId] = {
        id: memberId,
        room_id: roomId,
        name: (opts.hostName || '방장').slice(0, 24),
        kind: 'host',
        accent: opts.accent || 'blue',
        avatar: opts.avatar || null,
        system_prompt: null,
        member_token_hash: hash,
        created_at: nowIso()
      };
      writeDemo(db);
      return { roomId: roomId, memberId: memberId, memberToken: hostToken, roomKey: roomKey };
    });
  };

  DemoStore.prototype.hostAddMember = function (opts) {
    var db = readDemo();
    var room = db.rooms[opts.roomId];
    if (!room) return Promise.reject(new Error('room_not_found'));
    var token = C.randomToken(32);
    var memberId = uid('mem');
    return C.sha256Hex(opts.hostToken).then(function (hostHash) {
      if (hostHash !== room.host_token_hash) throw new Error('not_host');
      return C.sha256Hex(token);
    }).then(function (memberHash) {
      db.members[memberId] = {
        id: memberId,
        room_id: opts.roomId,
        name: String(opts.name || '').slice(0, 24) || '멤버',
        kind: opts.kind === 'ai' ? 'ai' : 'guest',
        accent: opts.accent || 'blue',
        avatar: opts.avatar || null,
        system_prompt: opts.systemPrompt || null,
        member_token_hash: memberHash,
        created_at: nowIso()
      };
      writeDemo(db);
      return { memberId: memberId, memberToken: token };
    });
  };

  DemoStore.prototype.listMembers = function (roomId) {
    var db = readDemo();
    var rows = [];
    Object.keys(db.members).forEach(function (id) {
      var m = db.members[id];
      if (m.room_id === roomId) {
        rows.push({
          id: m.id,
          room_id: m.room_id,
          name: m.name,
          kind: m.kind,
          accent: m.accent,
          avatar: m.avatar,
          created_at: m.created_at
        });
      }
    });
    rows.sort(function (a, b) {
      return String(a.created_at).localeCompare(String(b.created_at));
    });
    return Promise.resolve(rows);
  };

  DemoStore.prototype.getMember = function (roomId, memberId) {
    var db = readDemo();
    var m = db.members[memberId];
    if (!m || m.room_id !== roomId) return Promise.resolve(null);
    return Promise.resolve(clone(m));
  };

  DemoStore.prototype.roomInfo = function (roomId) {
    var db = readDemo();
    var room = db.rooms[roomId];
    if (!room) return Promise.resolve(null);
    var count = Object.keys(db.members).filter(function (id) {
      return db.members[id].room_id === roomId;
    }).length;
    return Promise.resolve({ id: room.id, name: room.name, member_count: count, created_at: room.created_at });
  };

  DemoStore.prototype.listMessages = function (roomId) {
    var db = readDemo();
    var rows = db.messages.filter(function (m) {
      return m.room_id === roomId;
    });
    return Promise.resolve(clone(rows));
  };

  /** 1단계: 암호만 먼저 확인한다(실패 횟수/잠금은 여기서 센다). */
  DemoStore.prototype.checkPasscode = function (token, passcode) {
    var parsed = C.parseInviteToken(token);
    if (!parsed) return Promise.resolve({ ok: false, error: 'invalid_invite' });
    var db = readDemo();
    return C.sha256Hex(parsed.tokenId).then(function (hash) {
      var invite = null;
      Object.keys(db.invites).forEach(function (id) {
        if (db.invites[id].token_hash === hash) invite = db.invites[id];
      });
      if (!invite) return { ok: false, error: 'invalid_invite' };
      if (invite.revoked) return { ok: false, error: 'revoked' };
      if (invite.expires_at && Date.parse(invite.expires_at) < Date.now()) return { ok: false, error: 'expired' };
      // 정원이 찼더라도 막지 않는다 — 같은 이름으로 다시 들어오는 사람이 있을 수 있다.
      // (새 이름인지 판단은 이름을 받는 joinInvite 에서 한다)
      var lockedUntil = invite.locked_until ? Date.parse(invite.locked_until) : 0;
      if (lockedUntil > Date.now()) return { ok: false, error: 'locked', locked_until: invite.locked_until };
      return C.passcodeHash(passcode, invite.pass_salt).then(function (passHash) {
        if (passHash === invite.pass_hash) {
          invite.fail_count = 0;
          writeDemo(db);
          return { ok: true, full: isFullInvite(invite.uses, invite.max_uses) };
        }
        invite.fail_count = (invite.fail_count || 0) + 1;
        if (invite.fail_count >= PASSCODE_FAIL_LIMIT) {
          invite.fail_count = 0;
          invite.locked_until = new Date(Date.now() + PASSCODE_LOCK_MS).toISOString();
          writeDemo(db);
          return { ok: false, error: 'locked', locked_until: invite.locked_until };
        }
        writeDemo(db);
        return { ok: false, error: 'bad_passcode', remaining: PASSCODE_FAIL_LIMIT - invite.fail_count };
      });
    });
  };

  DemoStore.prototype.postMessage = function (opts) {
    var db = readDemo();
    var self = this;
    return C.sha256Hex(opts.memberToken).then(function (hash) {
      var member = null;
      Object.keys(db.members).forEach(function (id) {
        var m = db.members[id];
        if (m.room_id === opts.roomId && m.member_token_hash === hash) member = m;
      });
      if (!member) throw new Error('bad_member_token');
      var body = String(opts.body || '');
      if (!body.trim()) throw new Error('empty_message');
      if (body.length > 4000) body = body.slice(0, 4000);
      return C.encryptString(C.roomKeyBytes(opts.roomKey), body).then(function (ct) {
        var row = {
          id: 'm_' + Date.now().toString(36) + '_' + C.randomToken(6).replace(/[-_]/g, '').slice(0, 8),
          room_id: opts.roomId,
          member_id: member.id,
          author_name: member.name,
          author_kind: member.kind,
          body_ct: ct,
          created_at: opts.at || nowIso()
        };
        db.messages.push(row);
        writeDemo(db);
        return row;
      });
    });
  };

  DemoStore.prototype.createInvite = function (opts) {
    var db = readDemo();
    var room = db.rooms[opts.roomId];
    if (!room) return Promise.reject(new Error('room_not_found'));
    var passcode = String(opts.passcode || '');
    if (passcode.length < 4) return Promise.reject(new Error('passcode_too_short'));
    return C.sha256Hex(opts.hostToken).then(function (hash) {
      if (hash !== room.host_token_hash) throw new Error('not_host');
      return C.makeInvite(opts.roomKey, passcode);
    }).then(function (invite) {
      var id = uid('inv');
      var expiresAt = null;
      if (opts.expiresInMinutes) {
        expiresAt = new Date(Date.now() + opts.expiresInMinutes * 60000).toISOString();
      }
      db.invites[id] = {
        id: id,
        room_id: opts.roomId,
        label: String(opts.label || '').slice(0, 40) || null,
        token_hash: invite.tokenHash,
        wrapped_key: invite.wrappedKey,
        pass_salt: invite.passSalt,
        pass_hash: invite.passHash,
        max_uses: normalizeMaxUses(opts.maxUses),
        uses: 0,
        expires_at: expiresAt,
        revoked: false,
        fail_count: 0,
        locked_until: null,
        created_at: nowIso()
      };
      writeDemo(db);
      return { id: id, token: invite.token, expires_at: expiresAt, max_uses: db.invites[id].max_uses };
    });
  };

  DemoStore.prototype.listInvites = function (roomId) {
    var db = readDemo();
    var rows = Object.keys(db.invites).map(function (id) {
      var inv = db.invites[id];
      return {
        id: inv.id,
        room_id: inv.room_id,
        label: inv.label,
        max_uses: inv.max_uses,
        uses: inv.uses,
        expires_at: inv.expires_at,
        revoked: inv.revoked,
        created_at: inv.created_at
      };
    }).filter(function (i) {
      return i.room_id === roomId;
    });
    rows.sort(function (a, b) {
      return String(b.created_at).localeCompare(String(a.created_at));
    });
    return Promise.resolve(rows);
  };

  DemoStore.prototype.revokeInvite = function (roomId, inviteId, hostToken) {
    var db = readDemo();
    var inv = db.invites[inviteId];
    var room = db.rooms[roomId];
    if (!inv || inv.room_id !== roomId) return Promise.reject(new Error('invite_not_found'));
    return C.sha256Hex(hostToken || '').then(function (hash) {
      if (!room || hash !== room.host_token_hash) throw new Error('not_host');
      inv.revoked = true;
      writeDemo(db);
      return { ok: true };
    });
  };

  DemoStore.prototype.kickMember = function (roomId, memberId, hostToken) {
    var db = readDemo();
    var room = db.rooms[roomId];
    var target = db.members[memberId];
    if (!target || target.room_id !== roomId) return Promise.reject(new Error('member_not_found'));
    return C.sha256Hex(hostToken || '').then(function (hash) {
      if (!room || hash !== room.host_token_hash) throw new Error('not_host');
      if (target.kind === 'host') throw new Error('cannot_kick_host');
      delete db.members[memberId];
      writeDemo(db);
      return { ok: true };
    });
  };

  DemoStore.prototype.inviteInfo = function (token) {
    var parsed = C.parseInviteToken(token);
    if (!parsed) return Promise.resolve(null);
    var db = readDemo();
    return C.sha256Hex(parsed.tokenId).then(function (hash) {
      var inv = null;
      Object.keys(db.invites).forEach(function (id) {
        if (db.invites[id].token_hash === hash) inv = db.invites[id];
      });
      if (!inv) return null;
      var room = db.rooms[inv.room_id];
      if (!room) return null;
      var count = Object.keys(db.members).filter(function (id) {
        return db.members[id].room_id === inv.room_id;
      }).length;
      return {
        room_id: inv.room_id,
        room_name: room.name,
        label: inv.label,
        member_count: count,
        uses: inv.uses || 0,
        max_uses: inv.max_uses,
        unlimited: isUnlimitedUses(inv.max_uses),
        full: isFullInvite(inv.uses, inv.max_uses),
        expires_at: inv.expires_at,
        revoked: inv.revoked,
        locked_until: inv.locked_until,
        fail_count: inv.fail_count,
        pass_salt: inv.pass_salt
      };
    });
  };

  /** 같은 이름(방장 제외)의 기존 멤버를 찾는다. 없으면 null. */
  function findMemberByName(db, roomId, name) {
    var found = null;
    Object.keys(db.members).forEach(function (id) {
      var m = db.members[id];
      if (m.room_id !== roomId) return;
      if (m.kind === 'host') return; // 방장 자리는 이름으로 빼앗을 수 없다
      if (!sameName(m.name, name)) return;
      if (!found || String(m.created_at || '') < String(found.created_at || '')) found = m;
    });
    return found;
  }

  DemoStore.prototype.joinInvite = function (opts) {
    var parsed = C.parseInviteToken(opts.token);
    if (!parsed) return Promise.resolve({ ok: false, error: 'invalid_invite' });
    var db = readDemo();
    var tokenHash = opts.tokenHash;
    var name = String(opts.name || '').slice(0, 24).trim();
    return C.sha256Hex(parsed.tokenId).then(function (hash) {
      var invite = null;
      Object.keys(db.invites).forEach(function (id) {
        if (db.invites[id].token_hash === (tokenHash || hash)) invite = db.invites[id];
      });
      if (!invite) return { ok: false, error: 'invalid_invite' };
      if (invite.revoked) return { ok: false, error: 'revoked' };
      if (invite.expires_at && Date.parse(invite.expires_at) < Date.now()) {
        return { ok: false, error: 'expired' };
      }
      var lockedUntil = invite.locked_until ? Date.parse(invite.locked_until) : 0;
      if (lockedUntil > Date.now()) {
        return { ok: false, error: 'locked', locked_until: invite.locked_until };
      }
      return C.passcodeHash(opts.passcode, invite.pass_salt).then(function (hashPass) {
        if (hashPass !== invite.pass_hash) {
          invite.fail_count = (invite.fail_count || 0) + 1;
          var remaining = PASSCODE_FAIL_LIMIT - invite.fail_count;
          if (remaining <= 0) {
            invite.fail_count = 0;
            invite.locked_until = new Date(Date.now() + PASSCODE_LOCK_MS).toISOString();
            writeDemo(db);
            return { ok: false, error: 'locked', locked_until: invite.locked_until };
          }
          writeDemo(db);
          return { ok: false, error: 'bad_passcode', remaining: remaining };
        }

        var existing = findMemberByName(db, invite.room_id, name);
        // 정원이 찬 초대라도 이미 있는 이름이면 다시 들어올 수 있다
        if (!existing && isFullInvite(invite.uses, invite.max_uses)) {
          return { ok: false, error: 'used_up' };
        }

        invite.fail_count = 0;
        invite.locked_until = null;
        var memberToken = C.randomToken(32);
        var newAvatar = opts.avatar || null;
        var systemPrompt = opts.systemPrompt || null;
        var rejoined = !!existing;
        var memberId = existing ? existing.id : uid('mem');
        if (!existing) invite.uses = (invite.uses || 0) + 1; // 재입장은 사용 횟수를 늘리지 않는다

        return C.sha256Hex(memberToken).then(function (memberHash) {
          if (existing) {
            // 기존 신분을 그대로 이어받는다. 새 사진이 없으면 사진·색을 유지하고, 새 사진이 있으면 갱신한다.
            existing.name = name || existing.name;
            existing.avatar = newAvatar || existing.avatar || null;
            if (newAvatar) existing.accent = opts.accent || existing.accent || 'blue';
            existing.system_prompt = systemPrompt || existing.system_prompt || null;
            existing.member_token_hash = memberHash;
            existing.last_seen = nowIso();
          } else {
            db.members[memberId] = {
              id: memberId,
              room_id: invite.room_id,
              name: name || '게스트',
              kind: opts.kind === 'ai' ? 'ai' : 'guest',
              accent: opts.accent || 'blue',
              avatar: newAvatar,
              system_prompt: systemPrompt,
              member_token_hash: memberHash,
              created_at: nowIso(),
              last_seen: nowIso()
            };
          }
          writeDemo(db);
          return C.unwrapRoomKey(invite.wrapped_key, parsed.wrapKeyB64).then(function (roomKey) {
            return {
              ok: true,
              room_id: invite.room_id,
              room_name: db.rooms[invite.room_id].name,
              member_id: memberId,
              member_token: memberToken,
              room_key: roomKey,
              rejoined: rejoined,
              name: db.members[memberId].name,
              kind: db.members[memberId].kind
            };
          });
        });
      });
    });
  };

  /* ---------------------------------------------------------------- 방 단위 로그인 (루트 주소)
   *  초대 링크 없이 '방 비밀번호'만으로 들어오는 길. 데모도 실시간과 같은 규칙을 쓴다.
   */

  function roomPublicInfo(db, room) {
    if (!room) return null;
    var count = Object.keys(db.members).filter(function (id) {
      return db.members[id].room_id === room.id;
    }).length;
    return {
      id: room.id,
      name: room.name,
      member_count: count,
      has_password: !!(room.pass_hash && room.wrapped_key),
      pass_salt: room.pass_salt || null,
      locked_until: room.locked_until || null,
      created_at: room.created_at,
      last_active: room.last_active || room.created_at
    };
  }

  DemoStore.prototype.defaultRoom = function () {
    var db = readDemo();
    var rooms = Object.keys(db.rooms).map(function (id) {
      return db.rooms[id];
    });
    if (!rooms.length) return Promise.resolve(null);
    rooms.sort(function (a, b) {
      return String(b.last_active || b.created_at).localeCompare(String(a.last_active || a.created_at));
    });
    return Promise.resolve(roomPublicInfo(db, rooms[0]));
  };

  DemoStore.prototype.publicRoomInfo = function (roomId) {
    var db = readDemo();
    return Promise.resolve(roomPublicInfo(db, db.rooms[roomId]));
  };

  DemoStore.prototype.setRoomPassword = function (opts) {
    var db = readDemo();
    var room = db.rooms[opts.roomId];
    if (!room) return Promise.reject(new Error('room_not_found'));
    var passcode = String(opts.passcode || '');
    if (passcode.length < 4) return Promise.reject(new Error('passcode_too_short'));
    return C.sha256Hex(opts.hostToken || '').then(function (hash) {
      if (hash !== room.host_token_hash) throw new Error('not_host');
      return C.wrapRoomKeyWithPassword(opts.roomKey, passcode);
    }).then(function (w) {
      room.pass_salt = w.passSalt;
      room.pass_hash = w.passHash;
      room.wrapped_key = w.wrappedKey;
      room.fail_count = 0;
      room.locked_until = null;
      room.has_password = true;
      writeDemo(db);
      return { ok: true };
    });
  };

  DemoStore.prototype.checkRoomPassword = function (roomId, password) {
    var db = readDemo();
    var room = db.rooms[roomId];
    if (!room) return Promise.resolve({ ok: false, error: 'room_not_found' });
    if (!room.pass_hash || !room.wrapped_key) return Promise.resolve({ ok: false, error: 'room_password_missing' });
    var lockedUntil = room.locked_until ? Date.parse(room.locked_until) : 0;
    if (lockedUntil > Date.now()) {
      return Promise.resolve({ ok: false, error: 'locked', locked_until: room.locked_until });
    }
    return C.passcodeHash(String(password || ''), room.pass_salt).then(function (hash) {
      if (hash === room.pass_hash) {
        room.fail_count = 0;
        writeDemo(db);
        return { ok: true };
      }
      room.fail_count = (room.fail_count || 0) + 1;
      var remaining = PASSCODE_FAIL_LIMIT - room.fail_count;
      if (remaining <= 0) {
        room.fail_count = 0;
        room.locked_until = new Date(Date.now() + PASSCODE_LOCK_MS).toISOString();
        writeDemo(db);
        return { ok: false, error: 'locked', locked_until: room.locked_until };
      }
      writeDemo(db);
      return { ok: false, error: 'bad_passcode', remaining: remaining };
    });
  };

  DemoStore.prototype.roomLogin = function (opts) {
    var db = readDemo();
    var room = db.rooms[opts.roomId];
    if (!room) return Promise.resolve({ ok: false, error: 'room_not_found' });
    if (!room.pass_hash || !room.wrapped_key) return Promise.resolve({ ok: false, error: 'room_password_missing' });
    var lockedUntil = room.locked_until ? Date.parse(room.locked_until) : 0;
    if (lockedUntil > Date.now()) {
      return Promise.resolve({ ok: false, error: 'locked', locked_until: room.locked_until });
    }
    var passcode = String(opts.password || '');
    var name = String(opts.name || '').slice(0, 24).trim();
    return C.passcodeHash(passcode, room.pass_salt).then(function (hash) {
      if (hash !== room.pass_hash) {
        room.fail_count = (room.fail_count || 0) + 1;
        var remaining = PASSCODE_FAIL_LIMIT - room.fail_count;
        if (remaining <= 0) {
          room.fail_count = 0;
          room.locked_until = new Date(Date.now() + PASSCODE_LOCK_MS).toISOString();
          writeDemo(db);
          return { ok: false, error: 'locked', locked_until: room.locked_until };
        }
        writeDemo(db);
        return { ok: false, error: 'bad_passcode', remaining: remaining };
      }
      room.fail_count = 0;
      room.locked_until = null;
      room.last_active = nowIso();

      var hostLogin = isHostAlias(name);
      var existing = hostLogin ? null : findMemberByName(db, room.id, name);
      var newAvatar = opts.avatar || null;
      var memberToken = C.randomToken(32);
      var memberId = existing ? existing.id : uid('mem');
      return C.sha256Hex(memberToken).then(function (memberHash) {
        if (hostLogin) {
          var host = null;
          Object.keys(db.members).forEach(function (id) {
            var m = db.members[id];
            if (m.room_id === room.id && m.kind === 'host') host = m;
          });
          if (!host) return { ok: false, error: 'host_not_found' };
          host.member_token_hash = memberHash;
          host.last_seen = nowIso();
          room.host_token_hash = memberHash; // 이 브라우저가 방장 권한을 이어받는다
          memberId = host.id;
        } else if (existing) {
          existing.avatar = newAvatar || existing.avatar || null;
          if (newAvatar) existing.accent = opts.accent || existing.accent || 'blue';
          if (opts.systemPrompt) existing.system_prompt = opts.systemPrompt;
          existing.member_token_hash = memberHash;
          existing.last_seen = nowIso();
        } else {
          db.members[memberId] = {
            id: memberId,
            room_id: room.id,
            name: name || '게스트',
            kind: opts.kind === 'ai' ? 'ai' : 'guest',
            accent: opts.accent || 'blue',
            avatar: newAvatar,
            system_prompt: opts.systemPrompt || null,
            member_token_hash: memberHash,
            created_at: nowIso(),
            last_seen: nowIso()
          };
        }
        writeDemo(db);
        return C.unwrapRoomKeyWithPassword(room.wrapped_key, passcode, room.pass_salt).then(function (roomKey) {
          return {
            ok: true,
            room_id: room.id,
            room_name: room.name,
            member_id: memberId,
            member_token: memberToken,
            room_key: roomKey,
            is_host: hostLogin,
            rejoined: !!existing,
            kind: db.members[memberId].kind,
            name: db.members[memberId].name
          };
        });
      });
    });
  };

  DemoStore.prototype.resetAll = function () {
    try {
      localStorage.removeItem(DEMO_DB_KEY);
    } catch (e) {
      /* noop */
    }
    var ch = channel();
    if (ch) {
      try {
        ch.postMessage({ type: 'changed', at: Date.now() });
      } catch (e) {
        /* noop */
      }
    }
    return Promise.resolve({ ok: true });
  };

  /* ---------------------------------------------------------------- Supabase store */

  var SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
  var supabaseLoader = null;

  function loadSupabaseSdk() {
    if (global.supabase && typeof global.supabase.createClient === 'function') return Promise.resolve(global.supabase);
    if (supabaseLoader) return supabaseLoader;
    supabaseLoader = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = SUPABASE_CDN;
      s.async = true;
      s.crossOrigin = 'anonymous';
      s.onload = function () {
        if (global.supabase) resolve(global.supabase);
        else reject(new Error('supabase_sdk_missing'));
      };
      s.onerror = function () {
        reject(new Error('supabase_sdk_failed'));
      };
      document.head.appendChild(s);
    });
    return supabaseLoader;
  }

  function SupabaseStore(cfg) {
    this.mode = 'live';
    this.label = 'Supabase';
    this.url = cfg.supabaseUrl;
    this.key = cfg.supabaseKey;
    this.client = null;
    // 서버(스키마)가 어느 수준인지. 예전 스키마(무제한·재입장 없음)면 빈 객체로 남는다.
    this.caps = {};
  }

  SupabaseStore.prototype.init = function () {
    var self = this;
    if (!C.hasSubtle()) return Promise.reject(new Error('crypto_unavailable'));
    return loadSupabaseSdk()
      .then(function (sdk) {
        self.client = sdk.createClient(self.url, self.key, {
          auth: { persistSession: false, autoRefreshToken: false },
          realtime: { params: { eventsPerSecond: 8 } }
        });
        return self.detectCapabilities();
      })
      .then(function () {
        return self;
      });
  };

  /* schema.sql 을 다시 실행하지 않은 예전 프로젝트에서도 앱이 깨지지 않게 하는 탐침.
   * 함수가 없으면(예전 스키마) 빈 객체 → 무제한·같은 이름 재입장 기능만 꺼진다. */
  SupabaseStore.prototype.detectCapabilities = function () {
    var self = this;
    return this.rpc('squad_capabilities', {})
      .then(function (data) {
        if (data && typeof data === 'object' && !data.error && data.version) self.caps = data;
        else self.caps = {};
      })
      .catch(function () {
        self.caps = {};
      });
  };

  SupabaseStore.prototype.supportsUnlimited = function () {
    return !!(this.caps && this.caps.unlimited);
  };

  SupabaseStore.prototype.supportsRejoin = function () {
    return !!(this.caps && this.caps.rejoin);
  };

  SupabaseStore.prototype.supportsRoomLogin = function () {
    return !!(this.caps && this.caps.room_login);
  };

  /** 초대 링크 없이 들어올 때: 가장 최근에 쓰인 방의 공개 정보 (없으면 null) */
  SupabaseStore.prototype.defaultRoom = function () {
    if (!this.supportsRoomLogin()) return Promise.resolve(null);
    return this.rpc('squad_default_room', {})
      .then(function (data) {
        if (!data || data.error) return null;
        return data.room || null;
      })
      .catch(function () {
        return null;
      });
  };

  SupabaseStore.prototype.publicRoomInfo = function (roomId) {
    if (!this.supportsRoomLogin()) return Promise.resolve(null);
    return this.rpc('squad_room_info', { p_room_id: roomId })
      .then(function (data) {
        if (!data || data.error || !data.id) return null;
        return data;
      })
      .catch(function () {
        return null;
      });
  };

  /** 방 비밀번호만 먼저 확인 (실패 횟수는 서버가 센다) */
  SupabaseStore.prototype.checkRoomPassword = function (roomId, password) {
    var self = this;
    if (!this.supportsRoomLogin()) return Promise.resolve({ ok: false, error: 'server_needs_update' });
    return this.publicRoomInfo(roomId).then(function (info) {
      if (!info) return { ok: false, error: 'room_not_found' };
      if (!info.has_password) return { ok: false, error: 'room_password_missing' };
      if (info.locked_until && Date.parse(info.locked_until) > Date.now()) {
        return { ok: false, error: 'locked', locked_until: info.locked_until };
      }
      return C.passcodeHash(String(password || ''), info.pass_salt).then(function (passHash) {
        return self.rpc('squad_room_check_pass', { p_room_id: roomId, p_pass_hash: passHash });
      });
    });
  };

  /** 방장이 방 비밀번호를 정한다 (방 열쇠를 비밀번호로 감싸 서버에 둔다) */
  SupabaseStore.prototype.setRoomPassword = function (opts) {
    var self = this;
    var passcode = String(opts.passcode || '');
    if (passcode.length < 4) return Promise.reject(new Error('passcode_too_short'));
    if (!this.supportsRoomLogin()) return Promise.reject(new Error('server_needs_update'));
    return C.wrapRoomKeyWithPassword(opts.roomKey, passcode)
      .then(function (w) {
        return self.rpc('squad_room_password_set', {
          p_room_id: opts.roomId,
          p_host_token: opts.hostToken,
          p_pass_salt: w.passSalt,
          p_pass_hash: w.passHash,
          p_wrapped_key: w.wrappedKey
        });
      })
      .then(function (data) {
        if (!data || data.error) throw new Error((data && data.error) || 'room_password_failed');
        return { ok: true };
      });
  };

  /** 방 비밀번호 + 이름(taewoo → 방장) 으로 들어온다 */
  SupabaseStore.prototype.roomLogin = function (opts) {
    var self = this;
    if (!this.supportsRoomLogin()) return Promise.reject(new Error('server_needs_update'));
    var passcode = String(opts.password || '');
    var memberToken = C.randomToken(32);
    var name = String(opts.name || '').slice(0, 24).trim();
    return this.publicRoomInfo(opts.roomId)
      .then(function (info) {
        if (!info) return { ok: false, error: 'room_not_found' };
        if (!info.has_password) return { ok: false, error: 'room_password_missing' };
        if (info.locked_until && Date.parse(info.locked_until) > Date.now()) {
          return { ok: false, error: 'locked', locked_until: info.locked_until };
        }
        return C.passcodeHash(passcode, info.pass_salt).then(function (passHash) {
          return self
            .rpc('squad_room_login', {
              p_room_id: opts.roomId,
              p_pass_hash: passHash,
              p_name: name,
              p_member_token: memberToken,
              p_kind: opts.kind === 'ai' ? 'ai' : 'guest',
              p_accent: opts.accent || 'blue',
              p_avatar: opts.avatar || null,
              p_system_prompt: opts.systemPrompt || null
            })
            .then(function (data) {
              if (!data) return { ok: false, error: 'login_failed' };
              if (data.error) return data;
              return C.unwrapRoomKeyWithPassword(data.wrapped_key, passcode, info.pass_salt)
                .then(function (roomKey) {
                  return {
                    ok: true,
                    room_id: data.room_id,
                    room_name: data.room_name,
                    member_id: data.member_id,
                    member_token: memberToken,
                    room_key: roomKey,
                    is_host: !!data.is_host,
                    rejoined: !!data.rejoined,
                    kind: data.kind,
                    name: data.name || name
                  };
                })
                .catch(function () {
                  return { ok: false, error: 'room_password_mismatch' };
                });
            });
        });
      });
  };

  SupabaseStore.prototype.rpc = function (name, args) {
    return this.client.rpc(name, args).then(function (res) {
      if (res.error) {
        var err = new Error(res.error.message || 'rpc_failed');
        err.code = res.error.code;
        err.details = res.error.details;
        err.hint = res.error.hint;
        throw err;
      }
      return res.data;
    });
  };

  SupabaseStore.prototype.createRoom = function (opts) {
    var hostToken = C.randomToken(32);
    return this.rpc('squad_create_room', {
      p_name: (opts.name || 'AI 공용방').slice(0, 40),
      p_host_name: (opts.hostName || '방장').slice(0, 24),
      p_host_token: hostToken,
      p_host_accent: opts.accent || 'blue',
      p_host_avatar: opts.avatar || null
    }).then(function (data) {
      if (!data || data.error) throw new Error((data && data.error) || 'room_create_failed');
      return {
        roomId: data.room_id,
        memberId: data.member_id,
        memberToken: hostToken,
        roomKey: C.newRoomKey()
      };
    });
  };

  SupabaseStore.prototype.hostAddMember = function (opts) {
    var token = C.randomToken(32);
    return this.rpc('squad_host_add_member', {
      p_room_id: opts.roomId,
      p_host_token: opts.hostToken,
      p_member_token: token,
      p_name: String(opts.name || '').slice(0, 24),
      p_kind: opts.kind === 'ai' ? 'ai' : 'guest',
      p_accent: opts.accent || 'blue',
      p_avatar: opts.avatar || null,
      p_system_prompt: opts.systemPrompt || null
    }).then(function (data) {
      if (!data || data.error) throw new Error((data && data.error) || 'member_add_failed');
      return { memberId: data.member_id, memberToken: token };
    });
  };

  SupabaseStore.prototype.listMembers = function (roomId) {
    return this.client
      .from('squad_members')
      .select('id,room_id,name,kind,accent,avatar,created_at')
      .eq('room_id', roomId)
      .order('created_at', { ascending: true })
      .then(function (res) {
        if (res.error) throw new Error(res.error.message);
        return res.data || [];
      });
  };

  SupabaseStore.prototype.roomInfo = function (roomId) {
    return this.listMembers(roomId).then(function (members) {
      // 방 이름은 세션(초대 응답 / 방 만들기 응답)에 있으므로 여기서는 인원만 센다
      return { id: roomId, name: null, member_count: members.length };
    });
  };

  SupabaseStore.prototype.listMessages = function (roomId) {
    return this.client
      .from('squad_messages')
      .select('id,room_id,member_id,author_name,author_kind,body_ct,created_at')
      .eq('room_id', roomId)
      .order('id', { ascending: true })
      .limit(500)
      .then(function (res) {
        if (res.error) throw new Error(res.error.message);
        return (res.data || []).map(function (r) {
          return {
            id: String(r.id),
            room_id: r.room_id,
            member_id: r.member_id,
            author_name: r.author_name,
            author_kind: r.author_kind,
            body_ct: r.body_ct,
            created_at: r.created_at
          };
        });
      });
  };

  SupabaseStore.prototype.postMessage = function (opts) {
    var self = this;
    var body = String(opts.body || '');
    if (!body.trim()) return Promise.reject(new Error('empty_message'));
    if (body.length > 4000) body = body.slice(0, 4000);
    return C.encryptString(C.roomKeyBytes(opts.roomKey), body)
      .then(function (ct) {
        return self.rpc('squad_post_message', {
          p_room_id: opts.roomId,
          p_member_token: opts.memberToken,
          p_body_ct: ct
        });
      })
      .then(function (data) {
        if (!data || data.error) throw new Error((data && data.error) || 'post_failed');
        return {
          id: String(data.id),
          room_id: opts.roomId,
          member_id: data.member_id,
          author_name: data.author_name,
          author_kind: data.author_kind,
          body_ct: data.body_ct,
          created_at: data.created_at
        };
      });
  };

  SupabaseStore.prototype.createInvite = function (opts) {
    var self = this;
    var maxUses = normalizeMaxUses(opts.maxUses);
    // 예전 스키마는 무제한(null)을 1명으로 바꿔 버린다. 그렇게 조용히 만들지 않고 기능을 꺼 둔다.
    if (maxUses === null && !this.supportsUnlimited()) {
      return Promise.reject(new Error('server_needs_update'));
    }
    return C.makeInvite(opts.roomKey, String(opts.passcode || '')).then(function (invite) {
      var expiresAt = opts.expiresInMinutes ? new Date(Date.now() + opts.expiresInMinutes * 60000).toISOString() : null;
      return self.rpc('squad_create_invite', {
        p_room_id: opts.roomId,
        p_host_token: opts.hostToken,
        p_label: String(opts.label || '').slice(0, 40) || null,
        p_token_hash: invite.tokenHash,
        p_wrapped_key: invite.wrappedKey,
        p_pass_salt: invite.passSalt,
        p_pass_hash: invite.passHash,
        p_max_uses: maxUses,
        p_expires_at: expiresAt
      }).then(function (data) {
        if (!data || data.error) throw new Error((data && data.error) || 'invite_create_failed');
        return {
          id: data.id,
          token: invite.token,
          expires_at: expiresAt,
          max_uses: data.max_uses === undefined ? maxUses : data.max_uses
        };
      });
    });
  };

  SupabaseStore.prototype.checkPasscode = function (token, passcode) {
    var parsed = C.parseInviteToken(token);
    if (!parsed) return Promise.resolve({ ok: false, error: 'invalid_invite' });
    var self = this;
    return C.sha256Hex(parsed.tokenId).then(function (hash) {
      return self.rpc('squad_invite_info', { p_token_hash: hash }).then(function (info) {
        if (!info || info.error || !info.room_id) return { ok: false, error: 'invalid_invite' };
        if (info.revoked) return { ok: false, error: 'revoked' };
        if (info.expires_at && Date.parse(info.expires_at) < Date.now()) return { ok: false, error: 'expired' };
        // 정원이 찼어도 여기서 막지 않는다 — 같은 이름으로 다시 들어오는 사람은 통과해야 한다.
        // 예전 스키마는 squad_check_pass 가 used_up 을 돌려주므로 그때만 그대로 막힌다.
        var full = isFullInvite(info.uses, info.max_uses);
        if (full && !self.supportsRejoin()) return { ok: false, error: 'used_up' };
        if (info.locked_until && Date.parse(info.locked_until) > Date.now()) {
          return { ok: false, error: 'locked', locked_until: info.locked_until };
        }
        return C.passcodeHash(passcode, info.pass_salt).then(function (passHash) {
          return self.rpc('squad_check_pass', { p_token_hash: hash, p_pass_hash: passHash }).then(function (res) {
            if (res && res.ok) return { ok: true, full: res.full === undefined ? full : !!res.full };
            return res || { ok: false, error: 'check_failed' };
          });
        });
      });
    });
  };

  SupabaseStore.prototype.listInvites = function (roomId, hostToken) {
    return this.rpc('squad_list_invites', { p_room_id: roomId, p_host_token: hostToken }).then(function (data) {
      return (data && data.invites) || [];
    });
  };

  SupabaseStore.prototype.revokeInvite = function (roomId, inviteId, hostToken) {
    return this.rpc('squad_revoke_invite', {
      p_room_id: roomId,
      p_host_token: hostToken,
      p_invite_id: inviteId
    });
  };

  SupabaseStore.prototype.kickMember = function (roomId, memberId, hostToken) {
    return this.rpc('squad_kick_member', {
      p_room_id: roomId,
      p_host_token: hostToken,
      p_member_id: memberId
    });
  };

  SupabaseStore.prototype.inviteInfo = function (token) {
    var parsed = C.parseInviteToken(token);
    if (!parsed) return Promise.resolve(null);
    return C.sha256Hex(parsed.tokenId).then(function (hash) {
      return this.rpc('squad_invite_info', { p_token_hash: hash });
    }.bind(this)).then(function (data) {
      if (!data || data.error || !data.room_id) return null;
      return data;
    });
  };

  SupabaseStore.prototype.joinInvite = function (opts) {
    var parsed = C.parseInviteToken(opts.token);
    if (!parsed) return Promise.resolve({ ok: false, error: 'invalid_invite' });
    var self = this;
    var memberToken = C.randomToken(32);
    var tokenHash = opts.tokenHash;

    // 1) 서버에서 초대 정보(salt 포함)를 받는다 — 감싼 방 열쇠는 아직 오지 않는다
    return C.sha256Hex(parsed.tokenId)
      .then(function (hash) {
        tokenHash = hash;
        return self.rpc('squad_invite_info', { p_token_hash: hash });
      })
      .then(function (info) {
        if (!info || info.error || !info.room_id) return { ok: false, error: 'invalid_invite' };
        if (info.revoked) return { ok: false, error: 'revoked' };
        if (info.expires_at && Date.parse(info.expires_at) < Date.now()) return { ok: false, error: 'expired' };
        if (Number(info.uses) >= Number(info.max_uses)) return { ok: false, error: 'used_up' };
        if (info.locked_until && Date.parse(info.locked_until) > Date.now()) {
          return { ok: false, error: 'locked', locked_until: info.locked_until };
        }
        // 2) 입장 암호는 클라이언트에서 salt 붙여 해시한 뒤 검증을 맡긴다
        return C.passcodeHash(opts.passcode, info.pass_salt).then(function (passHash) {
          return self.rpc('squad_join', {
            p_token_hash: tokenHash,
            p_pass_hash: passHash,
            p_name: String(opts.name || '').slice(0, 24),
            p_kind: opts.kind === 'ai' ? 'ai' : 'guest',
            p_accent: opts.accent || 'blue',
            p_avatar: opts.avatar || null,
            p_system_prompt: opts.systemPrompt || null,
            p_member_token: memberToken
          });
        });
      })
      .then(function (data) {
        if (!data) return { ok: false, error: 'join_failed' };
        if (data.error) return data;
        // 3) 방 열쇠는 링크의 wrapKey 로만 풀린다
        return C.unwrapRoomKey(data.wrapped_key, parsed.wrapKeyB64).then(function (roomKey) {
          return {
            ok: true,
            room_id: data.room_id,
            room_name: data.room_name,
            member_id: data.member_id,
            member_token: memberToken,
            room_key: roomKey,
            rejoined: !!data.rejoined,
            name: data.name || String(opts.name || '').slice(0, 24)
          };
        });
      });
  };

  SupabaseStore.prototype.subscribe = function (roomId, handlers) {
    var self = this;
    handlers = handlers || {};
    var channel = this.client
      .channel('squad-room-' + roomId)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'squad_messages', filter: 'room_id=eq.' + roomId },
        function (payload) {
          if (!payload || !payload.new) return;
          var row = payload.new;
          if (handlers.onMessage) {
            handlers.onMessage({
              id: String(row.id),
              room_id: row.room_id,
              member_id: row.member_id,
              author_name: row.author_name,
              author_kind: row.author_kind,
              body_ct: row.body_ct,
              created_at: row.created_at
            });
          }
        }
      )
      .subscribe(function (status) {
        if (handlers.onStatus) handlers.onStatus(status);
      });

    // 폴링 폴백 — Realtime 이 막혀 있어도 새 메시지를 놓치지 않는다
    var lastIds = {};
    var pollTimer = setInterval(function () {
      self.listMessages(roomId).then(function (rows) {
        rows.forEach(function (r) {
          if (lastIds[r.id]) return;
          lastIds[r.id] = true;
          if (handlers.onMessage) handlers.onMessage(r);
        });
      }).catch(function () {});
    }, 5000);
    this.listMessages(roomId).then(function (rows) {
      rows.forEach(function (r) {
        lastIds[r.id] = true;
      });
    }).catch(function () {});

    return function () {
      clearInterval(pollTimer);
      try {
        self.client.removeChannel(channel);
      } catch (e) {
        /* noop */
      }
    };
  };

  SupabaseStore.prototype.resetAll = function () {
    return Promise.resolve({ ok: false, error: 'live_mode_no_reset' });
  };

  /* ---------------------------------------------------------------- 팩토리 */

  function createStore() {
    if (isLiveConfigured()) {
      var cfg = loadConfig();
      return new SupabaseStore(cfg);
    }
    return new DemoStore();
  }

  global.SquadStore = {
    createStore: createStore,
    DemoStore: DemoStore,
    SupabaseStore: SupabaseStore,
    loadConfig: loadConfig,
    saveConfig: saveConfig,
    isLiveConfigured: isLiveConfigured,
    getSession: getSession,
    saveSession: saveSession,
    dropSession: dropSession,
    currentSession: currentSession,
    getActiveSession: getActiveSession,
    listSessions: listSessions,
    getAiTokens: getAiTokens,
    saveAiToken: saveAiToken,
    isUnlimitedUses: isUnlimitedUses,
    normalizeMaxUses: normalizeMaxUses,
    isFullInvite: isFullInvite,
    isHostAlias: isHostAlias,
    MAX_USES_CAP: MAX_USES_CAP,
    PASSCODE_FAIL_LIMIT: PASSCODE_FAIL_LIMIT,
    PASSCODE_LOCK_MS: PASSCODE_LOCK_MS
  };
})(typeof window !== 'undefined' ? window : this);
