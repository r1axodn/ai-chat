/*!
 * gemini.js — Gemini 응답 엔진 (3가지 모드)
 *
 *  mock    : 키·서버 함수가 없는 '데모' 상태. 자동 응답을 보내지 않는다.
 *            (예전처럼 예시 문장을 대신 찍어내지 않는다 — 자동 응답 기본값 OFF)
 *  session : 방장이 화면에서 임시로 넣은 키를 sessionStorage(=탭 메모리)에만 두고
 *            브라우저 → Google Gemini REST 로 직접 호출한다. 코드·DB·localStorage 에는 남기지 않는다.
 *  edge    : 배포된 Supabase Edge Function(supabase/functions/gemini-chat)을 호출한다.
 *            실제 키는 함수의 GEMINI_API_KEY 환경변수에만 있고 브라우저로 오지 않는다.
 */
(function (global) {
  'use strict';

  var SESSION_KEY_NAME = 'squad.gemini.key'; // sessionStorage 전용
  var SETTINGS_KEY = 'squad.gemini.settings.v1';
  var ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/';

  // 구글이 새 모델을 내면 이 목록만 고치면 된다. 저장된 모델명이 목록에 없어도 그대로 쓴다.
  var DEFAULT_MODEL = 'gemini-3.8-flash';

  var MODELS = [
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
    { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
    { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite' },
    { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (구형)' },
    { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite (구형)' }
  ];

  /* 'models/gemini-3.8-flash' 처럼 들어와도 받아 준다. 빈 값이면 기본 모델. */
  function normalizeModel(model) {
    var m = String(model == null ? '' : model).trim().replace(/^models\//i, '').trim();
    return m || DEFAULT_MODEL;
  }

  /* Gemini 3 이상은 temperature 대신 thinkingLevel 을 쓰고, 생각 토큰이 출력 한도에 포함된다. */
  function isThinkingModel(model) {
    return /^gemini-([34])([.\-]|$)/i.test(normalizeModel(model));
  }

  /* 신규 키에서 막힌 모델. 저장된 설정이 이 값이면 한 번만 새 기본값으로 옮긴다. */
  var RETIRED_MODELS = {
    'gemini-2.5-flash': 1,
    'gemini-2.5-pro': 1,
    'gemini-2.0-flash': 1,
    'gemini-2.0-flash-lite': 1,
    'gemini-1.5-flash': 1,
    'gemini-1.5-pro': 1
  };

  function isRetiredModel(model) {
    return !!RETIRED_MODELS[String(model == null ? '' : model).trim().replace(/^models\//i, '')];
  }

  function generationConfigFor(model) {
    if (isThinkingModel(model)) {
      return {
        maxOutputTokens: 1024,
        thinkingConfig: { thinkingLevel: 'low' }
      };
    }
    return { temperature: 0.9, maxOutputTokens: 220, topP: 0.95 };
  }

  function readSettings() {
    var v = {};
    try {
      var raw = localStorage.getItem(SETTINGS_KEY);
      v = (raw ? JSON.parse(raw) : null) || {};
    } catch (e) {
      v = {};
    }
    var model = normalizeModel(v.model);
    // 예전 기본값(2.5 Flash 등)이 그대로 저장돼 있으면 한 번만 새 기본값으로 옮긴다.
    // 한 번 옮긴 뒤에 사용자가 직접 구형 모델을 고르면 그 선택은 건드리지 않는다.
    var migrated = v.modelMigrated === true;
    if (!migrated) {
      if (!v.model || isRetiredModel(v.model)) model = DEFAULT_MODEL;
      migrated = true;
    }
    var next = {
      mode: v.mode || 'mock',
      model: model,
      autoReply: v.autoReply === true,
      aiToAi: v.aiToAi === true,
      modelMigrated: migrated,
      autoReplyDefault: v.autoReplyDefault === true
    };
    // 자동 응답·AI끼리 반응은 기본 OFF. 예전 기본값(ON)이 저장돼 있던 브라우저도 한 번만 OFF로 맞춘다.
    // 한 번 맞춘 뒤에 사용자가 직접 켜면 그 선택은 건드리지 않는다.
    if (next.autoReplyDefault !== true) {
      next.autoReply = false;
      next.aiToAi = false;
      next.autoReplyDefault = true;
    }
    if (v.modelMigrated !== true || v.autoReplyDefault !== true) {
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      } catch (e) {
        /* noop */
      }
    }
    return next;
  }

  function writeSettings(patch) {
    var next = Object.assign(readSettings(), patch || {});
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    } catch (e) {
      /* noop */
    }
    return next;
  }

  function sessionKey() {
    try {
      return sessionStorage.getItem(SESSION_KEY_NAME) || '';
    } catch (e) {
      return '';
    }
  }

  function setSessionKey(key) {
    try {
      if (key) sessionStorage.setItem(SESSION_KEY_NAME, key);
      else sessionStorage.removeItem(SESSION_KEY_NAME);
    } catch (e) {
      /* noop */
    }
  }

  /* 대화 기록 → Gemini contents 형식의 단일 프롬프트 */
  function buildTranscript(history, self, roomName) {
    var lines = history.slice(-14).map(function (m) {
      var who = m.author_name + (m.author_kind === 'ai' ? ' (AI)' : '');
      return who + ': ' + m.text;
    });
    return (
      '다음은 "' + (roomName || 'AI 공용방') + '" 단체 채팅방의 최근 대화다.\n' +
      lines.join('\n') +
      '\n\n지금 "' + self.name + '"으로서 이 대화에 이어서 답한다. ' +
      '한국어 반말로 1~2문장, 80자 이내로 짧게. 이모지와 마크다운 없이. ' +
      '같은 말 반복 없이 방금 흐름에 실제로 보탬이 되는 말만. 이름표는 붙이지 말고 말만 출력.'
    );
  }

  function callGemini(opts) {
    var key = opts.key;
    var model = normalizeModel(opts.model);
    var url = ENDPOINT + encodeURIComponent(model) + ':generateContent';
    var body = {
      contents: [{ role: 'user', parts: [{ text: opts.prompt }] }],
      generationConfig: generationConfigFor(model)
    };
    if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] };
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body)
    })
      .then(function (res) {
        return res.json().then(function (json) {
          if (!res.ok) {
            var msg = (json && json.error && json.error.message) || ('HTTP ' + res.status);
            var err = new Error(msg);
            err.status = res.status;
            throw err;
          }
          return json;
        });
      })
      .then(function (json) {
        var cand = json && json.candidates && json.candidates[0];
        var parts = (cand && cand.content && cand.content.parts) || [];
        var text = parts
          .filter(function (p) { return p && !p.thought && p.text; })
          .map(function (p) { return String(p.text); })
          .join('')
          .trim();
        if (!text) {
          var blocked = json && json.promptFeedback && json.promptFeedback.blockReason;
          var finish = cand && cand.finishReason;
          if (blocked) throw new Error('안전 필터에 걸렸어요 (' + blocked + ')');
          if (finish === 'MAX_TOKENS') throw new Error('응답이 잘렸어요 (MAX_TOKENS). 다른 모델로 바꿔 보세요.');
          if (finish && finish !== 'STOP') throw new Error('응답이 비었어요 (' + finish + ')');
          throw new Error('empty_response');
        }
        return text.replace(/^["'“”]|["'“”]$/g, '').slice(0, 400);
      });
  }

  function callEdge(opts) {
    if (!opts.edgeUrl) return Promise.reject(new Error('edge_not_configured'));
    return fetch(opts.edgeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: opts.projectKey || '',
        Authorization: 'Bearer ' + (opts.projectKey || '')
      },
      body: JSON.stringify({
        model: opts.model,
        system: opts.system,
        prompt: opts.prompt,
        room: opts.roomName || ''
      })
    })
      .then(function (res) {
        return res.json().then(function (json) {
          if (!res.ok || !json || !json.text) {
            throw new Error((json && json.error) || ('HTTP ' + res.status));
          }
          return String(json.text).trim().slice(0, 400);
        });
      });
  }

  /* ------------------------------------------------------------ 자동 응답 가능 여부
   *  데모(mock) 상태에서는 예시 문장을 대신 보내지 않는다.
   *  진짜 Gemini 키(내 키 모드 + 키 있음) 또는 서버 함수(edge + 배포 URL)일 때만 답한다.
   */

  function canAutoReply(opts) {
    var settings = readSettings();
    if (settings.mode === 'session') return !!sessionKey();
    if (settings.mode === 'edge') return !!(opts && opts.edgeUrl);
    return false;
  }

  /* ------------------------------------------------------------ 공개 API */

  function reply(opts) {
    var settings = readSettings();
    var mode = opts.mode || settings.mode;
    var key = opts.key || sessionKey();
    var edgeUrl = opts.edgeUrl;
    var projectKey = opts.projectKey;

    if (mode === 'session' && key) {
      return callGemini({
        key: key,
        model: settings.model,
        system: opts.system || '',
        prompt: buildTranscript(opts.history, opts.member || { name: opts.name }, opts.roomName)
      }).then(function (text) {
        return { text: text, source: 'gemini' };
      });
    }
    if (mode === 'edge' && edgeUrl) {
      return callEdge({
        edgeUrl: edgeUrl,
        projectKey: projectKey,
        model: settings.model,
        system: opts.system || '',
        prompt: buildTranscript(opts.history, opts.member || { name: opts.name }, opts.roomName),
          roomName: opts.roomName
      }).then(function (text) {
        return { text: text, source: 'gemini' };
      });
    }
    // 데모 상태: 가짜 예시 문장을 대신 보내지 않는다.
    return Promise.reject(new Error('데모 모드에서는 자동으로 답하지 않아요'));
  }

  function testKey(opts) {
    var settings = readSettings();
    if (settings.mode === 'edge') {
      return callEdge({
        edgeUrl: opts.edgeUrl,
        projectKey: opts.projectKey,
        model: settings.model,
        system: '아주 짧게 답한다.',
        prompt: '연결 테스트입니다. "연결됨"이라고만 답하세요.'
      });
    }
    return callGemini({
      key: opts.key || sessionKey(),
      model: settings.model,
      system: '아주 짧게 답한다.',
      prompt: '연결 테스트입니다. "연결됨"이라고만 답하세요.'
    });
  }

  global.SquadGemini = {
    MODELS: MODELS,
    DEFAULT_MODEL: DEFAULT_MODEL,
    normalizeModel: normalizeModel,
    settings: readSettings,
    update: writeSettings,
    sessionKey: sessionKey,
    setSessionKey: setSessionKey,
    reply: reply,
    canAutoReply: canAutoReply,
    testKey: testKey
  };
})(typeof window !== 'undefined' ? window : this);
