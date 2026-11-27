/*!
 * gemini.js — Gemini 응답 엔진 (3가지 모드)
 *
 *  mock    : API 키 없이 도는 데모 응답. 대화 흐름에 맞춰 짧게 답한다.
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
    try {
      var raw = localStorage.getItem(SETTINGS_KEY);
      var v = raw ? JSON.parse(raw) : {};
      return {
        mode: v.mode || 'mock',
        model: normalizeModel(v.model),
        autoReply: v.autoReply !== false,
        aiToAi: !!v.aiToAi
      };
    } catch (e) {
      return { mode: 'mock', model: DEFAULT_MODEL, autoReply: true, aiToAi: false };
    }
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

  /* ------------------------------------------------------------ 데모 응답 */

  var MOCK = {
    generic: [
      '확인했어요. 바로 정리해 둘게요.',
      '좋아요, 그 방향으로 맞춰 볼게요.',
      '일정이랑 같이 보면 무리 없어 보여요.',
      '두 가지로 나눠서 짧게 정리해 봤어요.',
      '제 쪽은 준비 끝났어요.'
    ],
    question: [
      '네, 지금 확인해 볼게요.',
      '그건 제가 맡아서 확인해 볼 수 있어요.',
      '한 번 더 확인하고 바로 알려드릴게요.'
    ],
    plan: [
      '그럼 순서는 정리 → 확인 → 공유로 가면 되겠네요.',
      '제가 체크리스트로 묶어서 올려 둘게요.',
      '시간 넉넉해요. 그 순서면 문제없습니다.'
    ],
    greeting: [
      '안녕하세요, 준비돼 있어요.',
      '부르셨나요? 바로 볼게요.'
    ],
    persona: {
      Pickle: ['일정 쪽은 제가 챙길게요.', '방금 캘린더랑 겹치는 거 없이 확인했어요.', '제가 정리해서 올려 둘게요.'],
      Instinct: ['링크랑 준비물은 제가 최신으로 맞춰 뒀어요.', '신청 쪽은 문제없어 보여요.', '리스트 다시 한 번 훑어볼게요.'],
      Claude: ['비교표로 묶어서 보여드릴게요.', '요약은 짧게 정리했습니다.', '장단점 두 줄로 정리해 봤어요.']
    }
  };

  function pick(list, seed) {
    var i = Math.abs(hash(seed || '')) % list.length;
    return list[i];
  }

  function hash(text) {
    var h = 0;
    for (var i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
    return h;
  }

  function mockReply(opts) {
    var last = (opts.history || []).filter(function (m) {
      return m.author_kind !== 'ai';
    }).pop();
    var text = last ? last.text : '';
    var persona = MOCK.persona[opts.name] || null;
    var bank;
    if (/[?？]\s*$/.test(text)) bank = MOCK.question;
    else if (/(하자|할까|어때|계획|일정|언제|몇 시)/.test(text)) bank = MOCK.plan;
    else if (/(안녕|하이|반가)/.test(text)) bank = MOCK.greeting;
    else bank = MOCK.generic;
    if (persona && Math.random() < 0.6) bank = persona;
    var seed = opts.name + '|' + text + '|' + (opts.history || []).length;
    return Promise.resolve(pick(bank, seed));
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
    return mockReply(opts).then(function (text) {
      return { text: text, source: 'mock' };
    });
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
    testKey: testKey
  };
})(typeof window !== 'undefined' ? window : this);
