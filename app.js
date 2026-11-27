/*!
 * app.js — AI 공용방 화면/흐름
 *
 * 보안 메모
 *  · 사용자 입력은 전부 textContent 로만 그린다. innerHTML 은 이 파일 전체에서 쓰지 않는다.
 *  · 프로필 사진은 data:image/(png|jpeg|webp) 만 허용하고, 캔버스로 160px 정사각형까지 줄여 저장한다.
 *  · Gemini 키는 sessionStorage 에만 둔다(코드·localStorage·DB 저장 없음).
 *  · 데모 모드의 모든 기록은 localStorage 에 남아 새로고침·재접속 후에도 복원된다.
 */
(function () {
  'use strict';

  var C = window.SquadCrypto;
  var Store = window.SquadStore;
  var Gemini = window.SquadGemini;

  var ACCENTS = ['blue', 'green', 'orange', 'purple', 'rose', 'slate'];
  var AVATAR_MAX_BYTES = 2 * 1024 * 1024;
  var AVATAR_SIZE = 160;

  var state = {
    store: null,
    mode: 'demo',
    session: null,
    room: null,
    members: [],
    messages: [],
    seen: {},
    settings: null,
    unsub: null,
    inviteInfo: null,
    joinToken: null,
    joinPasscode: '',
    pendingAvatar: null,
    accent: 'blue',
    aiAccent: 'green',
    atBottom: true,
    busy: {},
    typing: {},
    booted: false
  };

  /* ══════════════════════════════════ helpers ══════════════════════════════════ */

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function show(node, on) {
    if (!node) return;
    if (on) node.hidden = false;
    else node.hidden = true;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function safeText(value, max) {
    var s = typeof value === 'string' ? value : value == null ? '' : String(value);
    s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
    return max ? s.slice(0, max) : s;
  }

  function fmtTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    try {
      return new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit' }).format(d);
    } catch (e) {
      return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
    }
  }

  function fmtDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var today = new Date();
    var same = d.toDateString() === today.toDateString();
    if (same) return '오늘';
    var y = new Date(today.getTime() - 86400000);
    if (d.toDateString() === y.toDateString()) return '어제';
    try {
      return new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric' }).format(d);
    } catch (e) {
      return d.getMonth() + 1 + '월 ' + d.getDate() + '일';
    }
  }

  function fmtUntil(iso) {
    if (!iso) return '무제한';
    var t = Date.parse(iso) - Date.now();
    if (isNaN(t)) return '무제한';
    if (t <= 0) return '만료됨';
    var min = Math.round(t / 60000);
    if (min < 60) return min + '분 후 만료';
    var hour = Math.round(min / 60);
    if (hour < 24) return hour + '시간 후 만료';
    return Math.round(hour / 24) + '일 후 만료';
  }

  var toastTimer = null;
  function toast(message) {
    var node = $('toast');
    node.textContent = message;
    node.hidden = false;
    requestAnimationFrame(function () {
      node.classList.add('is-on');
    });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      node.classList.remove('is-on');
      setTimeout(function () {
        node.hidden = true;
      }, 200);
    }, 2200);
  }

  function initials(name) {
    var s = String(name || '?').trim();
    if (!s) return '?';
    return s.slice(0, 1);
  }

  function safeAvatar(src) {
    if (typeof src !== 'string') return null;
    if (!/^data:image\/(png|jpeg|webp);base64,/i.test(src)) return null;
    return src;
  }

  function avatarEl(member, extraClass) {
    var node = el('div', 'avatar ' + (extraClass || ''));
    node.setAttribute('data-accent', (member && member.accent) || 'slate');
    var pic = member ? safeAvatar(member.avatar) : null;
    if (pic) {
      var img = el('img');
      img.src = pic;
      img.alt = '';
      img.loading = 'lazy';
      node.appendChild(img);
    } else {
      node.textContent = initials(member && member.name);
    }
    return node;
  }

  function memberById(id) {
    for (var i = 0; i < state.members.length; i++) {
      if (state.members[i].id === id) return state.members[i];
    }
    return null;
  }

  /* ══════════════════════════════════ screens ══════════════════════════════════ */

  function showScreen(name) {
    ['chat', 'join', 'home'].forEach(function (key) {
      show($('screen-' + key), key === name);
    });
    if (name === 'home') renderHome();
  }

  function openSheet(name) {
    show($('modal-' + name), true);
    var panel = $('modal-' + name).querySelector('.sheet-panel');
    if (panel) panel.scrollTop = 0;
  }

  function closeSheet(name) {
    show($('modal-' + name), false);
  }

  function closeAllSheets() {
    ['invite', 'host', 'search', 'ai'].forEach(closeSheet);
  }

  /* ══════════════════════════════════ boot ══════════════════════════════════ */

  function fatal(message) {
    showScreen('home');
    var form = $('form-create');
    if (form) form.style.display = 'none';
    var head = document.querySelector('#screen-home .join-sub');
    if (head) head.textContent = message;
  }

  async function boot() {
    state.settings = Gemini.settings();

    if (!C.hasSubtle()) {
      fatal('이 브라우저에서는 암호화(Web Crypto)를 쓸 수 없어요. https:// 또는 http://localhost 주소로 열어 주세요.');
      return;
    }

    state.store = Store.createStore();
    state.mode = state.store.mode;
    try {
      await state.store.init();
    } catch (e) {
      // Supabase 모듈을 못 불러오면 데모로 물러난다
      state.store = new Store.DemoStore();
      state.mode = 'demo';
      await state.store.init();
      toast('실시간 연결에 실패해 데모 모드로 열었어요');
    }

    bindGlobalEvents();

    var params = new URLSearchParams(location.search);
    var inviteToken = params.get('invite');
    if (inviteToken) {
      startJoin(inviteToken);
      return;
    }

    var session = Store.currentSession();
    if (session && session.roomId) {
      openRoom(session);
      return;
    }

    if (state.mode === 'demo' && !localStorage.getItem('squad.demo.clean')) {
      var seeded = await seedDemoRoom();
      if (seeded) {
        openRoom(seeded);
        return;
      }
    }
    showScreen('home');
  }

  /* ══════════════════════════════════ 데모 씨앗 ══════════════════════════════════ */

  async function seedDemoRoom() {
    var room = await state.store.createRoom({ name: 'AI 공용방', hostName: 'Taewoo', accent: 'blue' });
    var presets = [
      { name: 'Pickle', accent: 'green', role: '일정·날씨 담당', prompt: '일정과 날씨를 먼저 확인하고 짧게 보고한다.' },
      { name: 'Instinct', accent: 'blue', role: '링크·준비물 담당', prompt: '신청 링크와 준비물을 정리해서 알려준다.' },
      { name: 'Claude', accent: 'orange', role: '비교·요약 담당', prompt: '선택지를 비교표로 요약한다.' }
    ];
    var aiTokens = [];
    for (var i = 0; i < presets.length; i++) {
      var p = presets[i];
      var added = await state.store.hostAddMember({
        roomId: room.roomId,
        hostToken: room.memberToken,
        name: p.name,
        kind: 'ai',
        accent: p.accent,
        systemPrompt: p.role + '. ' + p.prompt
      });
      aiTokens.push(added.memberToken);
      Store.saveAiToken(room.roomId, added.memberId, added.memberToken);
    }

    var base = Date.now() - 6 * 60000;
    var seed = [
      { token: aiTokens[0], text: '일정이랑 날씨 확인 끝났어요. 토요일 저녁 7시 어때요?', at: base },
      { token: aiTokens[1], text: '신청 링크랑 준비물 리스트 정리해 뒀어요.', at: base + 60000 },
      { token: aiTokens[2], text: '비교표로 요약 완료했습니다.', at: base + 120000 },
      { token: room.memberToken, text: '좋아요, 1번안으로 진행해 주세요.', at: base + 180000 }
    ];
    for (var k = 0; k < seed.length; k++) {
      await state.store.postMessage({
        roomId: room.roomId,
        memberToken: seed[k].token,
        roomKey: room.roomKey,
        body: seed[k].text,
        at: new Date(seed[k].at).toISOString()
      });
    }

    var session = {
      roomId: room.roomId,
      memberId: room.memberId,
      memberToken: room.memberToken,
      roomKey: room.roomKey,
      kind: 'host',
      name: 'Taewoo',
      roomName: 'AI 공용방',
      at: nowIso()
    };
    Store.saveSession(session);
    return session;
  }

  /* ══════════════════════════════════ 방 열기 ══════════════════════════════════ */

  async function openRoom(session) {
    state.session = session;
    state.seen = {};
    state.messages = [];
    state.atBottom = true;
    clear($('messages'));

    var info = null;
    try {
      info = await state.store.roomInfo(session.roomId);
    } catch (e) {
      info = null;
    }
    if (!info) {
      Store.dropSession(session.roomId);
      state.session = null;
      toast('방을 찾을 수 없어요');
      showScreen('home');
      return;
    }

    state.room = { id: info.id, name: info.name || session.roomName || 'AI 공용방', member_count: info.member_count };
    $('roomTitle').textContent = safeText(state.room.name, 40);
    show($('modeChip'), state.mode === 'demo');
    $('modeChip').textContent = state.mode === 'demo' ? '데모' : '실시간';
    showScreen('chat');
    show($('btn-invite'), session.kind === 'host');

    await refreshMembers();
    await loadMessages();

    if (state.unsub) state.unsub();
    state.unsub = state.store.subscribe(session.roomId, {
      onMessage: function (row) {
        ingest([row]);
      },
      onChange: function () {
        refreshMembers();
      },
      onStatus: function (status) {
        if (status === 'SUBSCRIBED') {
          $('composerHint').textContent = '';
          show($('composerHint'), false);
        }
      }
    });

    setTimeout(scrollToBottom, 30);
    updateComposerHint();
  }

  async function refreshMembers() {
    if (!state.session) return;
    var rows = [];
    try {
      rows = await state.store.listMembers(state.session.roomId);
    } catch (e) {
      rows = [];
    }
    state.members = rows;
    renderMemberStrip();
    renderHostMembers();
    $('memberCount').textContent = String(rows.length || 0);
    $('hostMemberCount').textContent = '(' + (rows.length || 0) + ')';
  }

  async function loadMessages() {
    var rows = [];
    try {
      rows = await state.store.listMessages(state.session.roomId);
    } catch (e) {
      rows = [];
    }
    await ingest(rows, true);
    renderMessages();
  }

  /* ══════════════════════════════════ 메시지 ══════════════════════════════════ */

  async function ingest(rows, silent) {
    if (!rows || !rows.length) return;
    var added = false;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var id = String(row.id);
      if (state.seen[id]) continue;
      state.seen[id] = true;
      var text = '';
      if (typeof row.text === 'string') {
        text = row.text;
      } else {
        try {
          text = await C.decryptString(C.roomKeyBytes(state.session.roomKey), row.body_ct);
        } catch (e) {
          text = '이 메시지는 이 초대로는 열 수 없어요.';
        }
      }
      state.messages.push({
        id: id,
        member_id: row.member_id,
        author_name: row.author_name || '알 수 없음',
        author_kind: row.author_kind || 'guest',
        text: text,
        created_at: row.created_at || nowIso(),
        depth: row.depth || 0
      });
      added = true;
    }
    if (!added) return;
    state.messages.sort(function (a, b) {
      var t = String(a.created_at).localeCompare(String(b.created_at));
      return t !== 0 ? t : String(a.id).localeCompare(String(b.id));
    });
    if (!silent) {
      renderMessages();
      var last = state.messages[state.messages.length - 1];
      if (state.atBottom) scrollToBottom();
      else showJump(true);
      if (last && last.author_kind !== 'ai' && !state.seen['_ai_' + last.id]) {
        state.seen['_ai_' + last.id] = true;
        scheduleAiReplies(last);
      }
    }
  }

  async function sendMessage(text, asMember) {
    var session = state.session;
    if (!session) return;
    var body = safeText(text, 2000).trim();
    if (!body) return;

    var token = session.memberToken;
    var member = asMember || { id: session.memberId, name: session.name };
    if (asMember) {
      var tokens = Store.getAiTokens(session.roomId);
      token = tokens[asMember.id];
      if (!token) return;
    }

    try {
      var row = await state.store.postMessage({
        roomId: session.roomId,
        memberToken: token,
        roomKey: session.roomKey,
        body: body
      });
      var m = memberById(asMember ? asMember.id : session.memberId);
      await ingest([
        {
          id: String(row.id || 'local_' + Date.now()),
          member_id: (row && row.member_id) || (m && m.id) || session.memberId,
          author_name: (row && row.author_name) || (m && m.name) || session.name || '나',
          author_kind: (row && row.author_kind) || (m && m.kind) || 'host',
          text: body,
          created_at: (row && row.created_at) || nowIso(),
          depth: asMember ? 1 : 0
        }
      ]);
      state.atBottom = true;
      scrollToBottom();
    } catch (e) {
      toast('메시지를 보내지 못했어요');
    }
  }

  function renderMessages() {
    var wrap = $('messages');
    clear(wrap);
    var prevDate = '';
    var ownId = state.session ? state.session.memberId : null;

    if (!state.messages.length) {
      show($('chatEmpty'), true);
    } else {
      show($('chatEmpty'), false);
    }

    state.messages.forEach(function (msg) {
      var dateKey = new Date(msg.created_at).toDateString();
      if (dateKey !== prevDate) {
        prevDate = dateKey;
        var sep = el('div', 'date-sep', fmtDate(msg.created_at));
        wrap.appendChild(sep);
      }

      var member = memberById(msg.member_id);
      var isOwn = msg.member_id === ownId;
      var row = el('div', 'msg' + (isOwn ? ' is-own' : '') + (msg.author_kind === 'system' ? ' is-system' : ''));
      row.setAttribute('data-msg-id', msg.id);

      if (msg.author_kind === 'system') {
        var colS = el('div', 'msg-col');
        colS.appendChild(el('div', 'bubble', msg.text));
        row.appendChild(colS);
        wrap.appendChild(row);
        return;
      }

      row.appendChild(avatarEl(member || { name: msg.author_name, accent: 'slate' }, 'msg-avatar'));

      var col = el('div', 'msg-col');
      var name = el('div', 'msg-name', msg.author_name);
      name.setAttribute('data-accent', (member && member.accent) || 'slate');
      col.appendChild(name);
      col.appendChild(el('div', 'bubble', msg.text));
      col.appendChild(el('div', 'msg-meta', fmtTime(msg.created_at)));
      row.appendChild(col);
      wrap.appendChild(row);
    });

    renderTyping();
  }

  function addTypingEl(member) {
    state.typing[member.id] = true;
    renderTyping();
  }

  function removeTypingEl(memberId) {
    delete state.typing[memberId];
    renderTyping();
  }

  function renderTyping() {
    var wrap = $('messages');
    var existing = wrap.querySelectorAll('.msg.is-typing');
    for (var i = 0; i < existing.length; i++) existing[i].remove();
    Object.keys(state.typing).forEach(function (id) {
      var member = memberById(id) || { id: id, name: 'AI', accent: 'slate' };
      var row = el('div', 'msg is-typing');
      row.appendChild(avatarEl(member, 'msg-avatar'));
      var col = el('div', 'msg-col');
      var name = el('div', 'msg-name', member.name + ' 답하는 중');
      name.setAttribute('data-accent', member.accent || 'slate');
      col.appendChild(name);
      var bubble = el('div', 'bubble');
      var dots = el('span', 'typing');
      dots.appendChild(el('i'));
      dots.appendChild(el('i'));
      dots.appendChild(el('i'));
      bubble.appendChild(dots);
      col.appendChild(bubble);
      row.appendChild(col);
      wrap.appendChild(row);
    });
    if (Object.keys(state.typing).length && state.atBottom) scrollToBottom();
  }

  function renderMemberStrip() {
    var strip = $('memberStrip');
    clear(strip);
    var ordered = state.members.slice().sort(function (a, b) {
      if (a.kind === 'host' && b.kind !== 'host') return 1;
      if (b.kind === 'host' && a.kind !== 'host') return -1;
      return String(a.created_at).localeCompare(String(b.created_at));
    });
    ordered.forEach(function (member) {
      var item = el('button', 'strip-item');
      item.type = 'button';
      item.title = member.name;
      item.appendChild(avatarEl(member));
      var label = el('span', 'strip-name', member.name);
      item.appendChild(label);
      item.addEventListener('click', function () {
        var input = $('input');
        input.value = (input.value ? input.value + ' ' : '') + '@' + member.name + ' ';
        input.focus();
      });
      strip.appendChild(item);
    });
  }

  function scrollToBottom() {
    var body = $('chatBody');
    if (!body) return;
    body.scrollTop = body.scrollHeight;
    state.atBottom = true;
    showJump(false);
  }

  function showJump(on) {
    show($('jumpLatest'), on);
  }

  function updateComposerHint() {
    var hint = $('composerHint');
    var aiCount = state.members.filter(function (m) {
      return m.kind === 'ai';
    }).length;
    if (state.mode === 'demo') {
      hint.textContent = aiCount
        ? '데모 모드 · AI 응답은 예시 문장이에요. 대화는 이 브라우저에 저장됩니다.'
        : '데모 모드 · 대화는 이 브라우저에 저장됩니다.';
      show(hint, true);
    } else {
      hint.textContent = '';
      show(hint, false);
    }
  }

  /* ══════════════════════════════════ AI 응답 ══════════════════════════════════ */

  function aiMembersIcanSpeakFor() {
    var tokens = Store.getAiTokens(state.session.roomId);
    return state.members.filter(function (m) {
      return m.kind === 'ai' && tokens[m.id];
    });
  }

  function scheduleAiReplies(trigger) {
    var settings = Gemini.settings();
    if (!settings.autoReply) return;
    if (trigger.author_kind === 'ai') {
      if (!settings.aiToAi) return;
      if ((trigger.depth || 0) >= 1) return;
    }

    var targets = [];

    // 내가 AI 멤버로 들어온 경우: 내가 직접 답한다
    if (state.session.kind === 'ai' && state.session.memberId !== trigger.member_id) {
      var me = memberById(state.session.memberId);
      if (me) targets.push(me);
    }

    aiMembersIcanSpeakFor().forEach(function (m) {
      if (m.id === trigger.member_id) return;
      if (targets.some(function (t) {
        return t.id === m.id;
      })) return;
      targets.push(m);
    });

    if (!targets.length) return;

    // 이름을 부르면 그 AI만, 아니면 최대 2명까지
    var mentioned = targets.filter(function (m) {
      return trigger.text.indexOf('@' + m.name) >= 0 || trigger.text.indexOf(m.name) >= 0;
    });
    if (mentioned.length) targets = mentioned;
    else targets = targets.slice(0, 2);

    targets.forEach(function (member, index) {
      if (state.busy[member.id]) return;
      var delay = 650 + index * 1100 + Math.floor(Math.random() * 350);
      setTimeout(function () {
        runAiReply(member, trigger);
      }, delay);
    });
  }

  async function runAiReply(member, trigger) {
    if (!state.session) return;
    state.busy[member.id] = true;
    addTypingEl(member);
    var history = state.messages.slice(-12).map(function (m) {
      return { author_name: m.author_name, author_kind: m.author_kind, text: m.text };
    });
    try {
      var res = await Gemini.reply({
        member: member,
        name: member.name,
        system: (member.system_prompt || '') + ' 지금은 "' + (state.room.name || 'AI 공용방') + '" 단체 채팅방에 있다.',
        history: history,
        roomName: state.room.name,
        edgeUrl: state.store.mode === 'live' ? state.store.url + '/functions/v1/gemini-chat' : '',
        projectKey: state.store.mode === 'live' ? state.store.key : ''
      });
      removeTypingEl(member.id);
      if (res && res.text) await sendMessage(res.text, { id: member.id, name: member.name });
    } catch (e) {
      removeTypingEl(member.id);
      toast('AI 응답 실패: ' + (e && e.message ? e.message : '알 수 없음'));
    } finally {
      state.busy[member.id] = false;
    }
  }

  /* ══════════════════════════════════ 참여 흐름 ══════════════════════════════════ */

  async function startJoin(token) {
    state.joinToken = token;
    state.joinPasscode = '';
    state.pendingAvatar = null;
    state.accent = 'blue';
    showScreen('join');
    show($('step-pass'), false);
    show($('step-profile'), false);
    $('joinTitle').textContent = '초대 링크로 입장';
    $('joinSub').textContent = '초대 정보를 확인하는 중…';

    var info = null;
    try {
      info = await state.store.inviteInfo(token);
    } catch (e) {
      info = null;
    }
    state.inviteInfo = info;

    if (!info) {
      showJoinError('초대를 찾을 수 없어요. 링크가 만료됐거나 폐기됐을 수 있어요.');
      return;
    }

    $('inviteRoom').textContent = safeText(info.room_name || 'AI 공용방', 40);
    $('inviteLabel').textContent = info.label ? safeText(info.label, 40) : '초대';
    $('inviteExpiry').textContent = fmtUntil(info.expires_at);
    $('inviteUses').textContent = (info.uses || 0) + ' / ' + (info.max_uses || 1) + '명';
    $('joinSub').textContent = '입장 암호를 입력해 주세요.';

    if (info.revoked) return showJoinError('이 초대는 폐기됐어요. 방장에게 새 링크를 받아 주세요.');
    if (info.expires_at && Date.parse(info.expires_at) < Date.now()) return showJoinError('초대 링크가 만료됐어요.');
    if (Number(info.uses) >= Number(info.max_uses)) return showJoinError('이미 정원이 찬 초대예요.');

    var lockedUntil = info.locked_until ? Date.parse(info.locked_until) : 0;
    if (lockedUntil > Date.now()) return showLocked(lockedUntil);

    show($('step-pass'), true);
    $('passcode').value = '';
    setTimeout(function () {
      $('passcode').focus();
    }, 120);
  }

  function showJoinError(message) {
    $('joinSub').textContent = message;
    show($('step-pass'), false);
    show($('step-profile'), false);
    show($('modal-invite'), false);
  }

  function showLocked(until) {
    show($('step-pass'), false);
    var min = Math.max(1, Math.ceil((until - Date.now()) / 60000));
    $('joinSub').textContent = '암호를 5번 틀려서 잠겼어요. 약 ' + min + '분 뒤에 다시 시도해 주세요.';
  }

  async function submitPasscode(event) {
    event.preventDefault();
    var passcode = $('passcode').value;
    var err = $('passError');
    show(err, false);
    if (!passcode) {
      err.textContent = '암호를 입력해 주세요.';
      show(err, true);
      return;
    }
    $('btn-pass').disabled = true;
    var res = null;
    try {
      res = await state.store.checkPasscode(state.joinToken, passcode);
    } catch (e) {
      res = { ok: false, error: 'request_failed' };
    }
    $('btn-pass').disabled = false;

    if (res && res.ok) {
      state.joinPasscode = passcode;
      show($('step-pass'), false);
      showJoinProfile();
      return;
    }
    if (res && res.error === 'locked') {
      showLocked(Date.parse(res.locked_until));
      return;
    }
    if (res && res.error === 'bad_passcode') {
      err.textContent = '암호가 맞지 않아요. 남은 시도 ' + res.remaining + '회.';
      show(err, true);
      $('passcode').select();
      return;
    }
    if (res && res.error === 'expired') return showJoinError('초대 링크가 만료됐어요.');
    if (res && res.error === 'revoked') return showJoinError('이 초대는 폐기됐어요.');
    if (res && res.error === 'used_up') return showJoinError('이미 정원이 찬 초대예요.');
    err.textContent = '확인하지 못했어요. 잠시 뒤 다시 시도해 주세요.';
    show(err, true);
  }

  function showJoinProfile() {
    show($('step-profile'), true);
    $('joinSub').textContent = '프로필을 정하고 들어가 주세요.';
    $('profileName').value = '';
    $('profilePrompt').value = '';
    $('profileRole').value = '';
    $('toggleAi').checked = false;
    show($('aiFields'), false);
    show($('profileError'), false);
    setAvatarPreview(null);
    renderAccentRow($('accentRow'), state.accent);
    setTimeout(function () {
      $('profileName').focus();
    }, 80);
  }

  function setAvatarPreview(dataUrl) {
    state.pendingAvatar = dataUrl;
    var box = $('avatarPreview');
    clear(box);
    if (dataUrl) {
      var img = el('img');
      img.src = dataUrl;
      img.alt = '';
      box.appendChild(img);
    } else {
      box.textContent = '+';
    }
  }

  async function handleAvatarFile(file) {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/i.test(file.type)) {
      toast('PNG · JPEG · WEBP 사진만 쓸 수 있어요');
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      toast('사진은 2MB 까지 가능해요');
      return;
    }
    try {
      var dataUrl = await resizeImage(file, AVATAR_SIZE);
      setAvatarPreview(dataUrl);
    } catch (e) {
      toast('사진을 불러오지 못했어요');
    }
  }

  function resizeImage(file, size) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          var canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          var ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, size, size);
          var scale = Math.max(size / img.width, size / img.height);
          var w = img.width * scale;
          var h = img.height * scale;
          ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
          var out = canvas.toDataURL('image/webp', 0.82);
          if (out.indexOf('data:image/webp') !== 0) out = canvas.toDataURL('image/jpeg', 0.85);
          URL.revokeObjectURL(url);
          resolve(out);
        } catch (err) {
          URL.revokeObjectURL(url);
          reject(err);
        }
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('image_load_failed'));
      };
      img.src = url;
    });
  }

  async function submitProfile(event) {
    event.preventDefault();
    var err = $('profileError');
    show(err, false);
    var name = safeText($('profileName').value, 24).trim();
    if (!name) {
      err.textContent = '이름을 입력해 주세요.';
      show(err, true);
      return;
    }
    var isAi = $('toggleAi').checked;
    var role = safeText($('profileRole').value, 40).trim();
    var prompt = safeText($('profilePrompt').value, 600).trim();
    var systemPrompt = [role ? '역할: ' + role : '', prompt].filter(Boolean).join('\n') || null;

    $('btn-enter').disabled = true;
    var res = null;
    try {
      res = await state.store.joinInvite({
        token: state.joinToken,
        passcode: state.joinPasscode,
        name: name,
        kind: isAi ? 'ai' : 'guest',
        accent: state.accent,
        avatar: state.pendingAvatar,
        systemPrompt: systemPrompt
      });
    } catch (e) {
      res = { ok: false, error: 'join_failed' };
    }
    $('btn-enter').disabled = false;

    if (!res || !res.ok) {
      var map = {
        bad_passcode: '암호가 맞지 않아요.',
        locked: '시도 횟수를 넘겨 잠시 잠겼어요.',
        used_up: '정원이 찬 초대예요.',
        expired: '초대가 만료됐어요.',
        revoked: '폐기된 초대예요.',
        invite_key_mismatch: '초대 링크가 올바르지 않아요.'
      };
      err.textContent = mappedError(map, res && res.error);
      show(err, true);
      return;
    }

    var session = {
      roomId: res.room_id,
      memberId: res.member_id,
      memberToken: res.member_token,
      roomKey: res.room_key,
      kind: isAi ? 'ai' : 'guest',
      name: name,
      roomName: res.room_name || 'AI 공용방',
      at: nowIso()
    };
    Store.saveSession(session);
    if (isAi) Store.saveAiToken(res.room_id, res.member_id, res.member_token);
    if (window.history && history.replaceState) {
      history.replaceState(null, '', location.pathname);
    }
    // 들어간 뒤에는 새 초대 링크로 다시 열리지 않게 주소를 정리한다
    show($('step-profile'), false);
    openRoom(session);
  }

  function mappedError(map, code) {
    return map[code] || '입장하지 못했어요. 잠시 뒤 다시 시도해 주세요.';
  }

  /* ══════════════════════════════════ 초대 만들기 ══════════════════════════════════ */

  function openInviteSheet() {
    if (!state.session) return;
    closeSheet('host');
    show($('form-invite'), true);
    show($('inviteResult'), false);
    show($('inviteError'), false);
    $('inviteName').value = '';
    $('invitePass').value = suggestPasscode();
    $('inviteExpiryInput').value = '1440';
    $('inviteUsesInput').value = '1';
    show($('inviteDemoNote'), state.mode === 'demo');
    openSheet('invite');
    refreshInviteList();
  }

  function suggestPasscode() {
    var words = ['orbit', 'maple', 'solar', 'harbor', 'nimble', 'quartz', 'willow', 'pixel'];
    var a = words[Math.floor(Math.random() * words.length)];
    var n = String(Math.floor(100 + Math.random() * 900));
    return a + '-' + n;
  }

  async function submitInvite(event) {
    event.preventDefault();
    var err = $('inviteError');
    show(err, false);
    var passcode = $('invitePass').value.trim();
    if (passcode.length < 4) {
      err.textContent = '암호는 4자 이상으로 정해 주세요.';
      show(err, true);
      return;
    }
    var minutes = Number($('inviteExpiryInput').value) || 0;
    var uses = Number($('inviteUsesInput').value) || 1;
    $('btn-create-invite').disabled = true;
    try {
      var res = await state.store.createInvite({
        roomId: state.session.roomId,
        hostToken: state.session.memberToken,
        roomKey: state.session.roomKey,
        label: safeText($('inviteName').value, 40).trim(),
        passcode: passcode,
        expiresInMinutes: minutes,
        maxUses: uses
      });
      var link = location.origin + location.pathname + '?invite=' + encodeURIComponent(res.token);
      $('inviteLinkText').textContent = link;
      $('inviteResult').setAttribute('data-link', link);
      $('inviteResult').setAttribute('data-pass', passcode);
      show($('form-invite'), false);
      show($('inviteResult'), true);
      refreshInviteList();
    } catch (e) {
      err.textContent = '초대 링크를 만들지 못했어요. ' + (e && e.message ? e.message : '');
      show(err, true);
    } finally {
      $('btn-create-invite').disabled = false;
    }
  }

  async function copyText(text, okMessage) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        toast(okMessage);
        return;
      }
      throw new Error('no clipboard');
    } catch (e) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        toast(okMessage);
      } catch (err) {
        toast('복사하지 못했어요. 길게 눌러 복사해 주세요.');
      }
      document.body.removeChild(ta);
    }
  }

  async function refreshInviteList() {
    var list = $('inviteList');
    clear(list);
    if (!state.session) return;
    var rows = [];
    try {
      rows = await state.store.listInvites(
        state.session.roomId,
        state.session.memberToken
      );
    } catch (e) {
      rows = [];
    }
    if (!rows.length) {
      list.appendChild(el('li', 'empty-line', '아직 만든 초대가 없어요.'));
      return;
    }
    rows.forEach(function (inv) {
      var li = el('li', 'invite-item');
      var main = el('div', 'item-main');
      var title = el('div', 'item-title', inv.label || '초대');
      var sub = el('div', 'item-sub', (inv.uses || 0) + '/' + (inv.max_uses || 1) + '명 사용 · ' + fmtUntil(inv.expires_at));
      main.appendChild(title);
      main.appendChild(sub);
      li.appendChild(main);

      var dead = inv.revoked || (inv.expires_at && Date.parse(inv.expires_at) < Date.now()) || inv.uses >= inv.max_uses;
      var badge = el('span', 'badge' + (dead ? ' dead' : ''), dead ? (inv.revoked ? '폐기' : '종료') : '사용 가능');
      li.appendChild(badge);

      if (!inv.revoked) {
        var btn = el('button', 'mini-btn subtle', '폐기');
        btn.type = 'button';
        btn.addEventListener('click', async function () {
          try {
            await state.store.revokeInvite(state.session.roomId, inv.id, state.session.memberToken);
            toast('초대를 폐기했어요');
            refreshInviteList();
          } catch (e) {
            toast('폐기하지 못했어요');
          }
        });
        li.appendChild(btn);
      }
      list.appendChild(li);
    });
  }

  /* ══════════════════════════════════ 방 관리 ══════════════════════════════════ */

  function renderHostMembers() {
    var list = $('hostMemberList');
    if (!list) return;
    clear(list);
    state.members.forEach(function (member) {
      var li = el('li', 'member-item');
      li.appendChild(avatarEl(member));
      var main = el('div', 'item-main');
      var title = el('div', 'item-title', member.name);
      var sub = el('div', 'item-sub', member.kind === 'host' ? '방장' : member.kind === 'ai' ? 'AI 멤버' : '참여자');
      main.appendChild(title);
      main.appendChild(sub);
      li.appendChild(main);

      if (member.id === state.session.memberId) {
        li.appendChild(el('span', 'badge host', '나'));
      } else if (isHost()) {
        var btn = el('button', 'mini-btn subtle', '내보내기');
        btn.type = 'button';
        btn.addEventListener('click', async function () {
          if (!window.confirm(member.name + ' 님을 내보낼까요?')) return;
          try {
            await state.store.kickMember(state.session.roomId, member.id, state.session.memberToken);
            toast('내보냈어요');
            await refreshMembers();
          } catch (e) {
            toast('내보내지 못했어요');
          }
        });
        li.appendChild(btn);
      }
      list.appendChild(li);
    });
  }

  function isHost() {
    return !!(state.session && state.session.kind === 'host');
  }

  function openHostSheet() {
    if (!state.session) return;
    renderHostMembers();
    $('hostMemberCount').textContent = '(' + state.members.length + ')';
    $('aiModel').value = state.settings.model || 'gemini-2.5-flash';
    $('toggleAuto').checked = state.settings.autoReply !== false;
    $('toggleAiToAi').checked = !!state.settings.aiToAi;
    show($('sessionKeyBox'), state.settings.mode === 'session');
    $('geminiKey').value = '';
    $('geminiKey').placeholder = Gemini.sessionKey() ? '저장된 키가 이 탭에 있어요' : 'AIza...';
    $('connHint').textContent = state.mode === 'demo' ? '로컬 데모' : 'Supabase 연결됨';
    var cfg = Store.loadConfig();
    $('cfgUrl').value = cfg.supabaseUrl || '';
    $('cfgKey').value = '';
    $('cfgKey').placeholder = cfg.supabaseKey ? '저장된 키가 있어요' : 'sb_publishable_...';
    $('aiModeHint').textContent =
      state.settings.mode === 'mock' ? '데모 응답' : state.settings.mode === 'session' ? '내 키 사용' : '서버 함수';
    setSegmented($('aiModeGroup'), state.settings.mode);
    openSheet('host');
  }

  function setSegmented(group, mode) {
    var buttons = group.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      var on = buttons[i].getAttribute('data-mode') === mode;
      if (on) buttons[i].classList.add('is-on');
      else buttons[i].classList.remove('is-on');
    }
  }

  /* ══════════════════════════════════ 홈 ══════════════════════════════════ */

  function renderHome() {
    $('homeMode').textContent = state.mode === 'demo' ? '로컬 데모' : 'Supabase 실시간';
    $('homeStorage').textContent = state.mode === 'demo' ? '이 브라우저 (localStorage)' : 'Supabase + 이 브라우저';
    var list = $('homeRooms');
    if (!list) return;
    clear(list);
    var sessions = Store.listSessions();
    var ids = Object.keys(sessions);
    if (!ids.length) {
      list.appendChild(el('div', 'empty-line', '아직 들어간 방이 없어요.'));
      return;
    }
    ids.forEach(function (roomId) {
      var s = sessions[roomId];
      var row = el('button', 'member-item');
      row.type = 'button';
      var main = el('div', 'item-main');
      main.appendChild(el('div', 'item-title', s.roomName || s.name || 'AI 공용방'));
      main.appendChild(el('div', 'item-sub', s.kind === 'ai' ? 'AI 멤버로 참여 중' : s.kind === 'host' ? '방장' : '참여자'));
      row.appendChild(main);
      row.appendChild(el('span', 'badge', '열기'));
      row.addEventListener('click', function () {
        openRoom(s);
      });
      list.appendChild(row);
    });
  }

  async function createRoomFromHome(event) {
    event.preventDefault();
    var name = safeText($('createRoomName').value, 40).trim() || 'AI 공용방';
    var hostName = safeText($('createHostName').value, 24).trim() || '방장';
    try {
      var room = await state.store.createRoom({ name: name, hostName: hostName, accent: 'blue' });
      var session = {
        roomId: room.roomId,
        memberId: room.memberId,
        memberToken: room.memberToken,
        roomKey: room.roomKey,
        kind: 'host',
        name: hostName,
        roomName: name,
        at: nowIso()
      };
      Store.saveSession(session);
      openRoom(session);
    } catch (e) {
      toast('방을 만들지 못했어요');
    }
  }

  /* ══════════════════════════════════ 이벤트 ══════════════════════════════════ */

  var bound = false;

  function bindGlobalEvents() {
    if (bound) return;
    bound = true;

    $('composer').addEventListener('submit', function (event) {
      event.preventDefault();
      var input = $('input');
      var text = input.value;
      if (!text.trim()) return;
      input.value = '';
      sendMessage(text);
    });

    $('chatBody').addEventListener('scroll', function () {
      var body = $('chatBody');
      var near = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
      state.atBottom = near;
      if (near) showJump(false);
    });

    $('btnJumpLatest').addEventListener('click', scrollToBottom);
    $('btn-menu').addEventListener('click', openHostSheet);
    $('btn-invite').addEventListener('click', openInviteSheet);
    $('btn-back').addEventListener('click', function () {
      showScreen('home');
    });
    $('btn-search').addEventListener('click', function () {
      $('searchInput').value = '';
      renderSearchResults('');
      openSheet('search');
      setTimeout(function () {
        $('searchInput').focus();
      }, 120);
    });
    $('searchInput').addEventListener('input', function (event) {
      renderSearchResults(event.target.value);
    });

    document.querySelectorAll('[data-close]').forEach(function (node) {
      node.addEventListener('click', function () {
        closeSheet(node.getAttribute('data-close'));
      });
    });

    $('step-pass').addEventListener('submit', submitPasscode);
    $('step-profile').addEventListener('submit', submitProfile);
    $('form-create').addEventListener('submit', createRoomFromHome);
    $('form-invite').addEventListener('submit', submitInvite);
    $('form-ai').addEventListener('submit', submitAddAi);

    $('btn-avatar').addEventListener('click', function () {
      $('avatarInput').click();
    });
    $('avatarInput').addEventListener('change', function (event) {
      handleAvatarFile(event.target.files && event.target.files[0]);
      event.target.value = '';
    });
    $('toggleAi').addEventListener('change', function (event) {
      show($('aiFields'), event.target.checked);
      if (event.target.checked && !$('profileName').value) {
        $('profileName').value = '';
      }
    });

    $('btn-open-invite').addEventListener('click', openInviteSheet);
    $('btn-gen-pass').addEventListener('click', function () {
      $('invitePass').value = suggestPasscode();
    });
    $('btn-copy-link').addEventListener('click', function () {
      copyText($('inviteResult').getAttribute('data-link') || $('inviteLinkText').textContent, '링크를 복사했어요');
    });
    $('btn-copy-all').addEventListener('click', function () {
      var link = $('inviteResult').getAttribute('data-link') || '';
      var pass = $('inviteResult').getAttribute('data-pass') || '';
      copyText(link + '\n암호: ' + pass, '링크와 암호를 복사했어요');
    });
    $('btn-new-invite').addEventListener('click', function () {
      show($('inviteResult'), false);
      show($('form-invite'), true);
      $('invitePass').value = suggestPasscode();
    });

    $('aiModeGroup').addEventListener('click', function (event) {
      var btn = event.target.closest('button[data-mode]');
      if (!btn) return;
      var mode = btn.getAttribute('data-mode');
      state.settings = Gemini.update({ mode: mode });
      setSegmented($('aiModeGroup'), mode);
      show($('sessionKeyBox'), mode === 'session' || (mode === 'edge' && Gemini.sessionKey()));
      $('aiModeHint').textContent = mode === 'mock' ? '데모 응답' : mode === 'session' ? '내 키 사용' : '서버 함수';
      if (mode === 'edge') toast('서버 함수 모드는 Supabase Edge Function 배포가 필요해요');
    });

    $('aiModel').addEventListener('change', function (event) {
      state.settings = Gemini.update({ model: event.target.value });
    });

    $('toggleAuto').addEventListener('change', function (event) {
      state.settings = Gemini.update({ autoReply: event.target.checked });
    });
    $('toggleAiToAi').addEventListener('change', function (event) {
      state.settings = Gemini.update({ aiToAi: event.target.checked });
    });

    $('geminiKey').addEventListener('change', function (event) {
      var key = event.target.value.trim();
      if (!key) return;
      Gemini.setSessionKey(key);
      state.settings = Gemini.update({ mode: 'session' });
      setSegmented($('aiModeGroup'), 'session');
      show($('sessionKeyBox'), true);
      toast('이 탭에만 키를 두었어요');
    });

    $('btn-forget-key').addEventListener('click', function () {
      Gemini.setSessionKey('');
      $('geminiKey').value = '';
      $('geminiKey').placeholder = 'AIza...';
      toast('키를 지웠어요');
    });

    $('btn-test-key').addEventListener('click', async function () {
      var err = $('keyError');
      show(err, false);
      var key = $('geminiKey').value.trim() || Gemini.sessionKey();
      var s = Gemini.settings();
      if (s.mode === 'session' && !key) {
        err.textContent = '먼저 키를 넣어 주세요.';
        show(err, true);
        return;
      }
      $('btn-test-key').disabled = true;
      try {
        var text = await Gemini.testKey({
          key: key,
          edgeUrl: state.store.mode === 'live' ? state.store.url + '/functions/v1/gemini-chat' : '',
          projectKey: state.store.mode === 'live' ? state.store.key : ''
        });
        toast('연결됨: ' + String(text).slice(0, 40));
      } catch (e) {
        err.textContent = '연결 실패: ' + (e && e.message ? e.message : '알 수 없음');
        show(err, true);
      } finally {
        $('btn-test-key').disabled = false;
      }
    });

    $('btn-save-cfg').addEventListener('click', function () {
      var url = $('cfgUrl').value.trim();
      var key = $('cfgKey').value.trim() || (Store.loadConfig().supabaseKey || '');
      var err = $('cfgError');
      show(err, false);
      if (!/^https:\/\/.+\.supabase\.co$/.test(url)) {
        err.textContent = 'https://프로젝트.supabase.co 형식으로 넣어 주세요.';
        show(err, true);
        return;
      }
      if (!key) {
        err.textContent = 'publishable(또는 anon) 키를 넣어 주세요.';
        show(err, true);
        return;
      }
      if (/service_role/.test(key)) {
        err.textContent = 'service_role 키는 넣으면 안 됩니다. 공개용 키만 쓰세요.';
        show(err, true);
        return;
      }
      Store.saveConfig({ supabaseUrl: url, supabaseKey: key });
      toast('저장했어요. 새로고침하면 연결됩니다');
      setTimeout(function () {
        location.reload();
      }, 900);
    });

    $('btn-clear-cfg').addEventListener('click', function () {
      Store.saveConfig({ supabaseUrl: '', supabaseKey: '' });
      setTimeout(function () {
        location.reload();
      }, 200);
    });

    $('btn-leave').addEventListener('click', function () {
      if (!state.session) return;
      if (!window.confirm('이 방에서 나갈까요? 저장된 대화는 남아 있어요.')) return;
      Store.dropSession(state.session.roomId, state.session.memberId);
      state.session = null;
      if (state.unsub) state.unsub();
      closeAllSheets();
      showScreen('home');
    });

    $('btn-reset-demo').addEventListener('click', async function () {
      if (state.mode !== 'demo') {
        toast('데모 모드에서만 초기화할 수 있어요');
        return;
      }
      if (!window.confirm('이 브라우저의 데모 방·멤버·초대·대화를 모두 지울까요?')) return;
      await state.store.resetAll();
      var sessions = Store.listSessions();
      Object.keys(sessions).forEach(function (key) {
        Store.dropSession(sessions[key].roomId);
      });
      try {
        localStorage.removeItem('squad.aitokens.v1');
        localStorage.setItem('squad.demo.clean', '1');
      } catch (e) {
        /* noop */
      }
      state.session = null;
      state.messages = [];
      state.seen = {};
      closeAllSheets();
      toast('데모 데이터를 지웠어요');
      setTimeout(function () {
        location.reload();
      }, 500);
    });

    $('btn-add-ai').addEventListener('click', function () {
      closeSheet('host');
      $('aiName').value = '';
      $('aiRole').value = '';
      $('aiPrompt').value = '';
      show($('aiError'), false);
      renderAccentRow($('aiAccentRow'), state.aiAccent);
      openSheet('ai');
    });

    $('btn-demo-start').addEventListener('click', async function () {
      try {
        localStorage.removeItem('squad.demo.clean');
      } catch (e) {
        /* noop */
      }
      var session = Store.currentSession();
      if (!session) session = await seedDemoRoom();
      if (session) openRoom(session);
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closeAllSheets();
    });
  }

  function renderAccentRow(row, selected) {
    clear(row);
    ACCENTS.forEach(function (accent) {
      var dot = el('button', 'accent-dot' + (accent === selected ? ' is-on' : ''));
      dot.type = 'button';
      dot.setAttribute('data-accent', accent);
      dot.setAttribute('role', 'radio');
      dot.setAttribute('aria-checked', accent === selected ? 'true' : 'false');
      dot.addEventListener('click', function () {
        var isAiRow = row.id === 'aiAccentRow';
        if (isAiRow) state.aiAccent = accent;
        else state.accent = accent;
        renderAccentRow(row, accent);
      });
      row.appendChild(dot);
    });
  }

  async function submitAddAi(event) {
    event.preventDefault();
    var err = $('aiError');
    show(err, false);
    var name = safeText($('aiName').value, 24).trim();
    if (!name) {
      err.textContent = '이름을 입력해 주세요.';
      show(err, true);
      return;
    }
    var role = safeText($('aiRole').value, 40).trim();
    var prompt = safeText($('aiPrompt').value, 600).trim();
    try {
      var res = await state.store.hostAddMember({
        roomId: state.session.roomId,
        hostToken: state.session.memberToken,
        name: name,
        kind: 'ai',
        accent: state.aiAccent,
        systemPrompt: [role ? '역할: ' + role : '', prompt].filter(Boolean).join('\n') || null
      });
      Store.saveAiToken(state.session.roomId, res.memberId, res.memberToken);
      closeSheet('ai');
      await refreshMembers();
      updateComposerHint();
      toast(name + ' 님이 들어왔어요');
    } catch (e) {
      err.textContent = '추가하지 못했어요. 방장만 가능해요.';
      show(err, true);
    }
  }

  function renderSearchResults(query) {
    var list = $('searchResults');
    clear(list);
    var q = String(query || '').trim().toLowerCase();
    if (!q) {
      list.appendChild(el('li', 'empty-line', '검색어를 입력하세요.'));
      return;
    }
    var hits = state.messages.filter(function (m) {
      return String(m.text).toLowerCase().indexOf(q) >= 0;
    });
    if (!hits.length) {
      list.appendChild(el('li', 'empty-line', '찾는 대화가 없어요.'));
      return;
    }
    hits.slice(-30).reverse().forEach(function (m) {
      var li = el('li');
      var who = el('span', 'search-who', m.author_name);
      li.appendChild(who);
      li.appendChild(document.createTextNode(m.text.slice(0, 120)));
      li.appendChild(el('div', 'search-when', fmtDate(m.created_at) + ' ' + fmtTime(m.created_at)));
      li.addEventListener('click', function () {
        closeSheet('search');
        var node = document.querySelector('[data-msg-id="' + m.id + '"]');
        if (node) {
          node.scrollIntoView({ block: 'center' });
          node.classList.add('highlight');
          setTimeout(function () {
            node.classList.remove('highlight');
          }, 1600);
        }
      });
      list.appendChild(li);
    });
  }

  /* ══════════════════════════════════ 시작 ══════════════════════════════════ */

  function initModelSelect() {
    var select = $('aiModel');
    clear(select);
    Gemini.MODELS.forEach(function (model) {
      var opt = el('option', null, model.label);
      opt.value = model.id;
      select.appendChild(opt);
    });
    select.value = Gemini.settings().model;
  }

  document.addEventListener('DOMContentLoaded', function () {
    initModelSelect();
    boot();
  });

  // 테스트에서 쓰는 최소 인터페이스
  window.__squad = {
    state: state,
    openRoom: openRoom,
    openInviteSheet: openInviteSheet,
    openHostSheet: openHostSheet,
    boot: boot
  };
})();
