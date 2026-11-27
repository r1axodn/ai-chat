-- ============================================================================
--  AI 공용방 (squad_) — Supabase 스키마  ·  버전 3
--
--  Supabase 대시보드 → SQL Editor 에 통째로 붙여넣고 RUN 하면 끝입니다.
--  기존 cubetimer / friday-hud 테이블과 충돌하지 않도록 모든 객체에 squad_ 접두사를 씁니다.
--  여러 번 실행해도 안전하도록 create ... if not exists / or replace 로 작성했습니다.
--  (버전 1 로 만든 DB 에 그대로 다시 RUN 해도 됩니다. 아래 '기존 DB 업그레이드' 가 max_uses 를 비울 수 있게 바꿉니다.)
--
--  버전 2 에서 더해진 것
--   · 초대 인원 무제한 : max_uses 가 null 이면 무제한(uses 는 세기만 함)
--   · 같은 이름 재입장 : 초대·암호를 통과한 뒤 방에 이미 있는 이름(방장 제외)을 쓰면
--                        새 멤버를 만들지 않고 그 멤버의 신분을 이어받는다 (사용 횟수도 늘지 않음)
--   · squad_capabilities() : 앱이 서버 스키마 버전을 확인하는 탐침 (없으면 앱이 예전 동작으로 물러남)
--
--  버전 3 에서 더해진 것 (초대 링크 없이 루트 주소로 들어오기)
--   · 방 비밀번호 : squad_rooms.pass_salt / pass_hash (PBKDF2 해시만 저장)
--   · 방 열쇠를 그 비밀번호로 감싼 room_wrapped_key — 비밀번호를 아는 기기만 방 열쇠를 풀 수 있다
--   · squad_room_login : 이름이 taewoo/태우 면 기존 방장 멤버로 로그인, 아니면 같은 이름 재입장 또는 새 멤버
--   · squad_default_room / squad_room_info / squad_room_password_set / squad_room_check_pass
--
--  설계 요약
--   · 클라이언트는 테이블에 직접 쓰지 못합니다. 모든 쓰기는 SECURITY DEFINER RPC 로만.
--   · 입장 암호는 PBKDF2-SHA256 해시(pass_salt, pass_hash)로만 저장합니다.
--   · 방 열쇠(room key)는 DB 에 평문으로 없습니다. 초대마다 AES-GCM 으로 감싼 wrapped_key 만 저장하고,
--     그 열쇠를 풀려면 (1) 초대 링크의 wrapKey (2) 입장 암호 두 가지가 모두 필요합니다.
--   · 메시지 본문(body_ct)도 방 열쇠로 암호화된 암호문만 저장합니다.
--     그래서 anon 에게 messages SELECT 를 열어도(Realtime 구독용) 내용은 읽히지 않습니다.
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------- tables

create table if not exists public.squad_rooms (
  id              uuid primary key default gen_random_uuid(),
  name            text not null default 'AI 공용방' check (char_length(name) between 1 and 40),
  host_token_hash text not null,
  pass_salt       text,          -- 방 비밀번호 salt (null 이면 아직 비밀번호 없음)
  pass_hash       text,          -- 방 비밀번호 PBKDF2 해시
  room_wrapped_key text,         -- 방 열쇠를 방 비밀번호로 감싼 것 (AES-GCM)
  fail_count      int not null default 0,
  locked_until    timestamptz,
  last_active     timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

-- 버전 3 업그레이드: 이미 있는 방 테이블에 컬럼을 더한다 (여러 번 실행해도 안전)
alter table public.squad_rooms
  add column if not exists pass_salt        text,
  add column if not exists pass_hash        text,
  add column if not exists room_wrapped_key text,
  add column if not exists fail_count       int not null default 0,
  add column if not exists locked_until     timestamptz,
  add column if not exists last_active      timestamptz not null default now();

create table if not exists public.squad_members (
  id                uuid primary key default gen_random_uuid(),
  room_id           uuid not null references public.squad_rooms(id) on delete cascade,
  name              text not null check (char_length(name) between 1 and 24),
  kind              text not null default 'guest' check (kind in ('host', 'ai', 'guest')),
  accent            text not null default 'blue' check (accent in ('green','blue','orange','purple','rose','slate')),
  avatar            text,
  system_prompt     text,
  member_token_hash text not null,
  created_at        timestamptz not null default now(),
  last_seen         timestamptz not null default now()
);

create table if not exists public.squad_invites (
  id           uuid primary key default gen_random_uuid(),
  room_id      uuid not null references public.squad_rooms(id) on delete cascade,
  label        text check (char_length(label) <= 40),
  token_hash   text not null unique,
  wrapped_key  text not null,
  pass_salt    text not null,
  pass_hash    text not null,
  max_uses     int  default 1,          -- null = 무제한
  uses         int  not null default 0,
  expires_at   timestamptz,
  revoked      boolean not null default false,
  fail_count   int  not null default 0,
  locked_until timestamptz,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------- 기존 DB 업그레이드
--  버전 1 로 만든 테이블이 이미 있어도 여기서 바뀝니다. (여러 번 실행해도 안전)

-- 1) max_uses 를 비울 수 있게 (null = 무제한)
alter table public.squad_invites alter column max_uses drop not null;
alter table public.squad_invites alter column max_uses set default 1;

-- 2) 예전 '1~20' check 제한을 지우고 'null 또는 1~1000' 으로 다시 건다
do $$
declare
  r record;
begin
  for r in
    select conname
      from pg_constraint
     where conrelid = 'public.squad_invites'::regclass
       and contype = 'c'
       and conname like '%max_uses%'
  loop
    execute format('alter table public.squad_invites drop constraint %I', r.conname);
  end loop;
end $$;

alter table public.squad_invites
  add constraint squad_invites_max_uses_range
  check (max_uses is null or max_uses between 1 and 1000);

create table if not exists public.squad_messages (
  id          bigserial primary key,
  room_id     uuid not null references public.squad_rooms(id) on delete cascade,
  member_id   uuid references public.squad_members(id) on delete set null,
  author_name text not null,
  author_kind text not null default 'guest' check (author_kind in ('host', 'ai', 'guest', 'system')),
  body_ct     text not null,
  created_at  timestamptz not null default now()
);

create index if not exists squad_messages_room_idx on public.squad_messages (room_id, id);
create index if not exists squad_invites_token_idx on public.squad_invites (token_hash);
create index if not exists squad_members_room_idx on public.squad_members (room_id, created_at);

-- ---------------------------------------------------------------- helper

create or replace function public.squad_sha256(p_text text)
returns text
language sql
immutable
as $$
  select encode(extensions.digest(coalesce(p_text, ''), 'sha256'), 'hex');
$$;

-- 앱이 서버 스키마 버전을 확인하는 탐침. 이 함수가 없으면(버전 1) 앱이 예전 동작으로 물러난다.
create or replace function public.squad_capabilities()
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'version', 3,
    'unlimited', true,      -- 초대 인원 무제한(max_uses null)
    'rejoin', true,         -- 같은 이름 재입장 (멤버 재사용 · 사용 횟수 미증가)
    'full_rejoin', true,    -- 정원이 찬 초대도 기존 이름이면 입장 허용
    'room_login', true      -- 초대 링크 없이 방 비밀번호로 로그인 (taewoo = 방장)
  );
$$;

-- ---------------------------------------------------------------- RLS
--  rooms / invites : 정책 없음 → anon 은 아예 못 본다 (RPC 만이 문)
--  members        : 프로필 컬럼만 SELECT 공개 (토큰 해시는 컬럼 권한에서 제외)
--  messages       : 암호문만 SELECT 공개 (Realtime 구독에 필요)

alter table public.squad_rooms    enable row level security;
alter table public.squad_members  enable row level security;
alter table public.squad_invites  enable row level security;
alter table public.squad_messages enable row level security;

drop policy if exists squad_members_read on public.squad_members;
create policy squad_members_read on public.squad_members for select using (true);

drop policy if exists squad_messages_read on public.squad_messages;
create policy squad_messages_read on public.squad_messages for select using (true);

revoke all on public.squad_rooms    from anon, authenticated;
revoke all on public.squad_invites  from anon, authenticated;
revoke all on public.squad_members  from anon, authenticated;
revoke all on public.squad_messages from anon, authenticated;

grant select (id, room_id, name, kind, accent, avatar, created_at) on public.squad_members to anon;
grant select on public.squad_messages to anon;
grant usage on sequence public.squad_messages_id_seq to anon;

-- ---------------------------------------------------------------- 방 만들기
--  방장 토큰을 그대로 방장 멤버의 토큰으로 쓴다.

create or replace function public.squad_create_room(
  p_name text,
  p_host_name text,
  p_host_token text,
  p_host_accent text default 'blue',
  p_host_avatar text default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_room uuid;
  v_member uuid;
  v_hash text;
  v_name text;
  v_avatar text;
begin
  if p_host_token is null or length(p_host_token) < 32 then
    raise exception 'weak_token';
  end if;
  if p_host_avatar is not null and p_host_avatar !~ '^data:image/(png|jpeg|webp);base64,' then
    raise exception 'bad_avatar';
  end if;

  v_hash := squad_sha256(p_host_token);
  v_name := left(coalesce(nullif(btrim(p_host_name), ''), '방장'), 24);
  v_avatar := case when length(coalesce(p_host_avatar, '')) <= 300000 then p_host_avatar else null end;

  insert into squad_rooms (name, host_token_hash)
  values (left(coalesce(nullif(btrim(p_name), ''), 'AI 공용방'), 40), v_hash)
  returning id into v_room;

  insert into squad_members (room_id, name, kind, accent, avatar, member_token_hash)
  values (v_room, v_name, 'host', coalesce(p_host_accent, 'blue'), v_avatar, v_hash)
  returning id into v_member;

  return jsonb_build_object('room_id', v_room, 'member_id', v_member);
end $$;

create or replace function public.squad_host_add_member(
  p_room_id uuid,
  p_host_token text,
  p_member_token text,
  p_name text,
  p_kind text default 'guest',
  p_accent text default 'blue',
  p_avatar text default null,
  p_system_prompt text default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_member uuid;
  v_avatar text;
begin
  if not exists (
    select 1 from squad_rooms r
    where r.id = p_room_id and r.host_token_hash = squad_sha256(p_host_token)
  ) then
    return jsonb_build_object('error', 'not_host');
  end if;
  if p_member_token is null or length(p_member_token) < 32 then
    raise exception 'weak_token';
  end if;
  if p_avatar is not null and p_avatar !~ '^data:image/(png|jpeg|webp);base64,' then
    raise exception 'bad_avatar';
  end if;

  v_avatar := case when length(coalesce(p_avatar, '')) <= 300000 then p_avatar else null end;

  insert into squad_members (room_id, name, kind, accent, avatar, system_prompt, member_token_hash)
  values (
    p_room_id,
    left(coalesce(nullif(btrim(p_name), ''), '멤버'), 24),
    case when p_kind = 'ai' then 'ai' else 'guest' end,
    coalesce(p_accent, 'blue'),
    v_avatar,
    left(p_system_prompt, 600),
    squad_sha256(p_member_token)
  )
  returning id into v_member;

  return jsonb_build_object('member_id', v_member);
end $$;

-- ---------------------------------------------------------------- 초대

create or replace function public.squad_create_invite(
  p_room_id uuid,
  p_host_token text,
  p_token_hash text,
  p_wrapped_key text,
  p_pass_salt text,
  p_pass_hash text,
  p_label text default null,
  p_max_uses int default 1,
  p_expires_at timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_id uuid;
  v_max int;
begin
  if not exists (
    select 1 from squad_rooms r
    where r.id = p_room_id and r.host_token_hash = squad_sha256(p_host_token)
  ) then
    return jsonb_build_object('error', 'not_host');
  end if;
  if p_token_hash is null or length(p_token_hash) < 32 or p_wrapped_key is null or p_pass_hash is null then
    raise exception 'bad_invite';
  end if;

  -- null(또는 0 이하) = 무제한 → max_uses null 로 저장
  v_max := case
             when p_max_uses is null or p_max_uses <= 0 then null
             else greatest(1, least(1000, p_max_uses))
           end;

  insert into squad_invites (room_id, label, token_hash, wrapped_key, pass_salt, pass_hash, max_uses, expires_at)
  values (
    p_room_id,
    nullif(left(coalesce(btrim(p_label), ''), 40), ''),
    p_token_hash,
    p_wrapped_key,
    p_pass_salt,
    p_pass_hash,
    v_max,
    p_expires_at
  )
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'max_uses', v_max, 'unlimited', v_max is null);
end $$;

create or replace function public.squad_list_invites(p_room_id uuid, p_host_token text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_rows jsonb;
begin
  if not exists (
    select 1 from squad_rooms r
    where r.id = p_room_id and r.host_token_hash = squad_sha256(p_host_token)
  ) then
    return jsonb_build_object('error', 'not_host');
  end if;

  select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc), '[]'::jsonb)
  into v_rows
  from (
    select id, room_id, label, max_uses, uses, expires_at, revoked, created_at
    from squad_invites
    where room_id = p_room_id
  ) t;

  return jsonb_build_object('invites', v_rows);
end $$;

create or replace function public.squad_revoke_invite(p_room_id uuid, p_host_token text, p_invite_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not exists (
    select 1 from squad_rooms r
    where r.id = p_room_id and r.host_token_hash = squad_sha256(p_host_token)
  ) then
    return jsonb_build_object('error', 'not_host');
  end if;

  update squad_invites set revoked = true where id = p_invite_id and room_id = p_room_id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.squad_kick_member(p_room_id uuid, p_host_token text, p_member_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not exists (
    select 1 from squad_rooms r
    where r.id = p_room_id and r.host_token_hash = squad_sha256(p_host_token)
  ) then
    return jsonb_build_object('error', 'not_host');
  end if;
  if exists (
    select 1 from squad_members m
    where m.id = p_member_id and m.room_id = p_room_id and m.kind = 'host'
  ) then
    return jsonb_build_object('error', 'cannot_kick_host');
  end if;

  delete from squad_members where id = p_member_id and room_id = p_room_id;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- 입장

-- 감싼 방 열쇠는 돌려주지 않는다. (암호를 통과해야만 squad_join 이 준다)
create or replace function public.squad_invite_info(p_token_hash text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_inv squad_invites;
  v_room squad_rooms;
  v_count int;
begin
  select * into v_inv from squad_invites where token_hash = p_token_hash;
  if v_inv.id is null then
    return jsonb_build_object('error', 'invalid_invite');
  end if;
  select * into v_room from squad_rooms where id = v_inv.room_id;
  select count(*) into v_count from squad_members where room_id = v_inv.room_id;

  return jsonb_build_object(
    'room_id', v_inv.room_id,
    'room_name', coalesce(v_room.name, 'AI 공용방'),
    'label', v_inv.label,
    'member_count', v_count,
    'uses', v_inv.uses,
    'max_uses', v_inv.max_uses,
    'unlimited', v_inv.max_uses is null,
    'full', (v_inv.max_uses is not null and v_inv.uses >= v_inv.max_uses),
    'expires_at', v_inv.expires_at,
    'revoked', v_inv.revoked,
    'locked_until', v_inv.locked_until,
    'fail_count', v_inv.fail_count,
    'pass_salt', v_inv.pass_salt
  );
end $$;

-- 1단계: 암호만 검증 (실패 횟수/잠금 처리)
create or replace function public.squad_check_pass(p_token_hash text, p_pass_hash text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_inv squad_invites;
begin
  select * into v_inv from squad_invites where token_hash = p_token_hash for update;
  if v_inv.id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_invite');
  end if;
  if v_inv.revoked then
    return jsonb_build_object('ok', false, 'error', 'revoked');
  end if;
  if v_inv.expires_at is not null and v_inv.expires_at < now() then
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;
  if v_inv.locked_until is not null and v_inv.locked_until > now() then
    return jsonb_build_object('ok', false, 'error', 'locked', 'locked_until', v_inv.locked_until);
  end if;

  if v_inv.pass_hash = p_pass_hash then
    update squad_invites set fail_count = 0 where id = v_inv.id;
    -- 정원이 찼어도 여기서 막지 않는다: 같은 이름으로 다시 들어오는 사람이 통과해야 한다.
    -- (새 이름인지 판단은 이름을 받는 squad_join 이 한다)
    return jsonb_build_object('ok', true,
                              'full', (v_inv.max_uses is not null and v_inv.uses >= v_inv.max_uses));
  end if;

  if v_inv.fail_count + 1 >= 5 then
    update squad_invites
       set fail_count = 0, locked_until = now() + interval '15 minutes'
     where id = v_inv.id;
    return jsonb_build_object('ok', false, 'error', 'locked',
                              'locked_until', now() + interval '15 minutes');
  end if;

  update squad_invites set fail_count = v_inv.fail_count + 1 where id = v_inv.id;
  return jsonb_build_object('ok', false, 'error', 'bad_passcode', 'remaining', 5 - (v_inv.fail_count + 1));
end $$;

-- 2단계: 암호 재확인 후 멤버 확보 + 감싼 방 열쇠 반환
--   · 같은 이름(방장 제외)이 이미 있으면 새 row 를 만들지 않고 그 멤버로 다시 들어온다.
--     - 새 사진을 올렸으면 사진(+이름표 색) 갱신, 안 올렸으면 기존 사진·색 유지
--     - 시스템 프롬프트를 새로 적었으면 갱신, 비었으면 기존 것 유지
--     - 초대 사용 횟수(uses)는 늘지 않는다 · 정원이 찬 초대라도 기존 이름이면 허용
--     - 멤버 토큰은 새 것으로 바꾼다(이전 토큰은 더 이상 통하지 않음) = 신분 이동
--   · 방장(kind='host')은 이름으로 빼앗을 수 없다.
create or replace function public.squad_join(
  p_token_hash text,
  p_pass_hash text,
  p_name text,
  p_member_token text,
  p_kind text default 'guest',
  p_accent text default 'blue',
  p_avatar text default null,
  p_system_prompt text default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_inv squad_invites;
  v_room squad_rooms;
  v_member uuid;
  v_existing squad_members;
  v_rejoined boolean := false;
  v_avatar text;
  v_name text;
  v_kind text;
begin
  select * into v_inv from squad_invites where token_hash = p_token_hash for update;
  if v_inv.id is null then
    return jsonb_build_object('error', 'invalid_invite');
  end if;
  if v_inv.revoked then
    return jsonb_build_object('error', 'revoked');
  end if;
  if v_inv.expires_at is not null and v_inv.expires_at < now() then
    return jsonb_build_object('error', 'expired');
  end if;
  if v_inv.locked_until is not null and v_inv.locked_until > now() then
    return jsonb_build_object('error', 'locked', 'locked_until', v_inv.locked_until);
  end if;
  if v_inv.pass_hash <> p_pass_hash then
    return jsonb_build_object('error', 'bad_passcode');
  end if;
  if p_member_token is null or length(p_member_token) < 32 then
    raise exception 'weak_token';
  end if;
  if p_avatar is not null and p_avatar !~ '^data:image/(png|jpeg|webp);base64,' then
    raise exception 'bad_avatar';
  end if;

  v_avatar := case when length(coalesce(p_avatar, '')) <= 300000 then p_avatar else null end;
  v_name := left(coalesce(nullif(btrim(p_name), ''), '게스트'), 24);
  v_kind := case when p_kind = 'ai' then 'ai' else 'guest' end;

  -- 같은 이름의 기존 멤버 (방장 제외 · 오래된 것 하나)
  select * into v_existing
  from squad_members m
  where m.room_id = v_inv.room_id
    and m.kind <> 'host'
    and lower(btrim(m.name)) = lower(btrim(v_name))
  order by m.created_at asc
  limit 1;

  if v_existing.id is not null then
    v_rejoined := true;
    v_member := v_existing.id;
    v_kind := v_existing.kind;  -- 신분의 성격(AI/참여자)은 그대로 둔다

    update squad_members m
       set member_token_hash = squad_sha256(p_member_token),
           avatar = coalesce(v_avatar, m.avatar),
           accent = case when v_avatar is not null then coalesce(p_accent, m.accent) else m.accent end,
           system_prompt = coalesce(nullif(btrim(coalesce(p_system_prompt, '')), ''), m.system_prompt),
           last_seen = now()
     where m.id = v_existing.id;

    -- 사용 횟수는 그대로 둔다 (재입장으로 정원이 줄지 않게)
    update squad_invites
       set fail_count = 0, locked_until = null
     where id = v_inv.id;
  else
    if v_inv.max_uses is not null and v_inv.uses >= v_inv.max_uses then
      return jsonb_build_object('error', 'used_up');
    end if;

    update squad_invites
       set uses = uses + 1, fail_count = 0, locked_until = null
     where id = v_inv.id;

    insert into squad_members (room_id, name, kind, accent, avatar, system_prompt, member_token_hash)
    values (
      v_inv.room_id,
      v_name,
      v_kind,
      coalesce(p_accent, 'blue'),
      v_avatar,
      left(p_system_prompt, 600),
      squad_sha256(p_member_token)
    )
    returning id into v_member;
  end if;

  select * into v_room from squad_rooms where id = v_inv.room_id;

  return jsonb_build_object(
    'ok', true,
    'room_id', v_inv.room_id,
    'room_name', coalesce(v_room.name, 'AI 공용방'),
    'member_id', v_member,
    'rejoined', v_rejoined,
    'kind', v_kind,
    'unlimited', v_inv.max_uses is null,
    'wrapped_key', v_inv.wrapped_key
  );
end $$;

-- ---------------------------------------------------------------- 메시지

create or replace function public.squad_post_message(
  p_room_id uuid,
  p_member_token text,
  p_body_ct text
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_member squad_members;
  v_row squad_messages;
begin
  if p_body_ct is null or length(p_body_ct) > 12000 then
    return jsonb_build_object('error', 'bad_body');
  end if;

  select * into v_member
  from squad_members
  where room_id = p_room_id and member_token_hash = squad_sha256(p_member_token);

  if v_member.id is null then
    return jsonb_build_object('error', 'bad_member_token');
  end if;

  insert into squad_messages (room_id, member_id, author_name, author_kind, body_ct)
  values (p_room_id, v_member.id, v_member.name, v_member.kind, p_body_ct)
  returning * into v_row;

  update squad_members set last_seen = now() where id = v_member.id;
  update squad_rooms set last_active = now() where id = p_room_id;

  return jsonb_build_object(
    'id', v_row.id,
    'member_id', v_row.member_id,
    'author_name', v_row.author_name,
    'author_kind', v_row.author_kind,
    'body_ct', v_row.body_ct,
    'created_at', v_row.created_at
  );
end $$;

-- ---------------------------------------------------------------- 방 로그인 (초대 링크 없이)
--  루트 주소에서 방 이름 + 방 비밀번호만으로 들어오는 길.
--  방 열쇠는 비밀번호를 통과한 뒤에만(room_wrapped_key) 돌려준다. 그래서 비밀번호를 모르면
--  방 열쇠도, 메시지 평문도 얻을 수 없다. 검증 해시(pass_hash)와 감싼 열쇠의 키는 서로 다른
--  PBKDF2 유도값이라, DB 를 읽은 사람도 pass_hash 로 방 열쇠를 풀 수 없다.

create or replace function public.squad_room_info(p_room_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_room squad_rooms;
  v_count int;
begin
  select * into v_room from squad_rooms where id = p_room_id;
  if v_room.id is null then
    return jsonb_build_object('error', 'room_not_found');
  end if;
  select count(*) into v_count from squad_members where room_id = v_room.id;
  return jsonb_build_object(
    'id', v_room.id,
    'name', v_room.name,
    'member_count', v_count,
    'has_password', (v_room.pass_hash is not null and v_room.room_wrapped_key is not null),
    'pass_salt', v_room.pass_salt,
    'locked_until', v_room.locked_until,
    'created_at', v_room.created_at,
    'last_active', v_room.last_active
  );
end $$;

-- 가장 최근에 쓰인 방 하나 (앱이 루트 주소에서 보여 줄 방)
create or replace function public.squad_default_room()
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_room squad_rooms;
  v_info jsonb;
begin
  select * into v_room
  from squad_rooms
  order by coalesce(last_active, created_at) desc, created_at desc
  limit 1;
  if v_room.id is null then
    return jsonb_build_object('room', null);
  end if;
  v_info := squad_room_info(v_room.id);
  return jsonb_build_object('room', v_info);
end $$;

-- 방장이 방 비밀번호를 정한다 (방 열쇠를 비밀번호로 감싸 함께 저장)
create or replace function public.squad_room_password_set(
  p_room_id uuid,
  p_host_token text,
  p_pass_salt text,
  p_pass_hash text,
  p_wrapped_key text
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not exists (
    select 1 from squad_rooms r
    where r.id = p_room_id and r.host_token_hash = squad_sha256(p_host_token)
  ) then
    return jsonb_build_object('error', 'not_host');
  end if;
  if p_pass_salt is null or p_pass_hash is null or p_wrapped_key is null then
    raise exception 'bad_room_password';
  end if;

  update squad_rooms
     set pass_salt = p_pass_salt,
         pass_hash = p_pass_hash,
         room_wrapped_key = p_wrapped_key,
         fail_count = 0,
         locked_until = null,
         last_active = now()
   where id = p_room_id;

  return jsonb_build_object('ok', true);
end $$;

-- 1단계: 방 비밀번호만 검증 (실패 횟수/잠금은 방에 기록)
create or replace function public.squad_room_check_pass(p_room_id uuid, p_pass_hash text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_room squad_rooms;
begin
  select * into v_room from squad_rooms where id = p_room_id for update;
  if v_room.id is null then
    return jsonb_build_object('ok', false, 'error', 'room_not_found');
  end if;
  if v_room.pass_hash is null or v_room.room_wrapped_key is null then
    return jsonb_build_object('ok', false, 'error', 'room_password_missing');
  end if;
  if v_room.locked_until is not null and v_room.locked_until > now() then
    return jsonb_build_object('ok', false, 'error', 'locked', 'locked_until', v_room.locked_until);
  end if;

  if v_room.pass_hash = p_pass_hash then
    update squad_rooms set fail_count = 0 where id = v_room.id;
    return jsonb_build_object('ok', true);
  end if;

  if v_room.fail_count + 1 >= 5 then
    update squad_rooms
       set fail_count = 0, locked_until = now() + interval '15 minutes'
     where id = v_room.id;
    return jsonb_build_object('ok', false, 'error', 'locked',
                              'locked_until', now() + interval '15 minutes');
  end if;

  update squad_rooms set fail_count = v_room.fail_count + 1 where id = v_room.id;
  return jsonb_build_object('ok', false, 'error', 'bad_passcode', 'remaining', 5 - (v_room.fail_count + 1));
end $$;

-- 2단계: 방 비밀번호 확인 후 로그인
--   · 이름이 taewoo / 태우 → 기존 방장 멤버로 로그인 (새 멤버를 만들지 않음, 방장 권한)
--   · 그 밖의 이름 → 같은 이름 재입장(멤버 재사용) 또는 새 멤버
create or replace function public.squad_room_login(
  p_room_id uuid,
  p_pass_hash text,
  p_name text,
  p_member_token text,
  p_kind text default 'guest',
  p_accent text default 'blue',
  p_avatar text default null,
  p_system_prompt text default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_room squad_rooms;
  v_member uuid;
  v_existing squad_members;
  v_host squad_members;
  v_name text;
  v_kind text;
  v_avatar text;
  v_is_host boolean := false;
  v_rejoined boolean := false;
begin
  select * into v_room from squad_rooms where id = p_room_id for update;
  if v_room.id is null then
    return jsonb_build_object('error', 'room_not_found');
  end if;
  if v_room.pass_hash is null or v_room.room_wrapped_key is null then
    return jsonb_build_object('error', 'room_password_missing');
  end if;
  if v_room.locked_until is not null and v_room.locked_until > now() then
    return jsonb_build_object('error', 'locked', 'locked_until', v_room.locked_until);
  end if;
  if v_room.pass_hash <> p_pass_hash then
    if v_room.fail_count + 1 >= 5 then
      update squad_rooms set fail_count = 0, locked_until = now() + interval '15 minutes' where id = p_room_id;
      return jsonb_build_object('error', 'locked', 'locked_until', now() + interval '15 minutes');
    end if;
    update squad_rooms set fail_count = v_room.fail_count + 1 where id = p_room_id;
    return jsonb_build_object('error', 'bad_passcode', 'remaining', 5 - (v_room.fail_count + 1));
  end if;

  if p_member_token is null or length(p_member_token) < 32 then
    raise exception 'weak_token';
  end if;
  if p_avatar is not null and p_avatar !~ '^data:image/(png|jpeg|webp);base64,' then
    raise exception 'bad_avatar';
  end if;

  update squad_rooms set fail_count = 0, locked_until = null, last_active = now() where id = p_room_id;

  v_avatar := case when length(coalesce(p_avatar, '')) <= 300000 then p_avatar else null end;
  v_name := left(coalesce(nullif(btrim(p_name), ''), '게스트'), 24);

  if lower(btrim(v_name)) in ('taewoo', '태우') then
    -- 방장 로그인: 기존 방장 멤버를 그대로 쓰고, 이 기기가 방장 권한을 이어받는다
    select * into v_host
    from squad_members m
    where m.room_id = p_room_id and m.kind = 'host'
    order by m.created_at asc
    limit 1;
    if v_host.id is null then
      return jsonb_build_object('error', 'host_not_found');
    end if;
    update squad_members
       set member_token_hash = squad_sha256(p_member_token), last_seen = now()
     where id = v_host.id;
    update squad_rooms set host_token_hash = squad_sha256(p_member_token) where id = p_room_id;
    v_member := v_host.id;
    v_is_host := true;
    v_rejoined := true;
    v_kind := 'host';
  else
    select * into v_existing
    from squad_members m
    where m.room_id = p_room_id
      and m.kind <> 'host'
      and lower(btrim(m.name)) = lower(v_name)
    order by m.created_at asc
    limit 1;

    if v_existing.id is not null then
      v_rejoined := true;
      v_member := v_existing.id;
      v_kind := v_existing.kind;
      update squad_members m
         set member_token_hash = squad_sha256(p_member_token),
             avatar = coalesce(v_avatar, m.avatar),
             accent = case when v_avatar is not null then coalesce(p_accent, m.accent) else m.accent end,
             system_prompt = coalesce(nullif(btrim(coalesce(p_system_prompt, '')), ''), m.system_prompt),
             last_seen = now()
       where m.id = v_existing.id;
    else
      v_kind := case when p_kind = 'ai' then 'ai' else 'guest' end;
      insert into squad_members (room_id, name, kind, accent, avatar, system_prompt, member_token_hash)
      values (p_room_id, v_name, v_kind, coalesce(p_accent, 'blue'), v_avatar,
              left(p_system_prompt, 600), squad_sha256(p_member_token))
      returning id into v_member;
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'room_id', v_room.id,
    'room_name', v_room.name,
    'member_id', v_member,
    'name', (select m.name from squad_members m where m.id = v_member),
    'is_host', v_is_host,
    'rejoined', v_rejoined,
    'kind', v_kind,
    'pass_salt', v_room.pass_salt,
    'wrapped_key', v_room.room_wrapped_key
  );
end $$;

-- ---------------------------------------------------------------- 권한

grant execute on function public.squad_create_room(text, text, text, text, text) to anon;
grant execute on function public.squad_host_add_member(uuid, text, text, text, text, text, text, text) to anon;
grant execute on function public.squad_create_invite(uuid, text, text, text, text, text, text, int, timestamptz) to anon;
grant execute on function public.squad_list_invites(uuid, text) to anon;
grant execute on function public.squad_revoke_invite(uuid, text, uuid) to anon;
grant execute on function public.squad_kick_member(uuid, text, uuid) to anon;
grant execute on function public.squad_invite_info(text) to anon;
grant execute on function public.squad_check_pass(text, text) to anon;
grant execute on function public.squad_join(text, text, text, text, text, text, text, text) to anon;
grant execute on function public.squad_post_message(uuid, text, text) to anon;
grant execute on function public.squad_capabilities() to anon;
grant execute on function public.squad_room_info(uuid) to anon;
grant execute on function public.squad_default_room() to anon;
grant execute on function public.squad_room_password_set(uuid, text, text, text, text) to anon;
grant execute on function public.squad_room_check_pass(uuid, text) to anon;
grant execute on function public.squad_room_login(uuid, text, text, text, text, text, text, text) to anon;

-- ---------------------------------------------------------------- Realtime

do $$
begin
  alter publication supabase_realtime add table public.squad_messages;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;

-- ---------------------------------------------------------------- 확인

select
  to_regclass('public.squad_rooms')    is not null as squad_rooms_ok,
  to_regclass('public.squad_members')  is not null as squad_members_ok,
  to_regclass('public.squad_invites')  is not null as squad_invites_ok,
  to_regclass('public.squad_messages') is not null as squad_messages_ok,
  to_regprocedure('public.squad_capabilities()') is not null as squad_capabilities_ok,
  to_regprocedure('public.squad_room_login(uuid, text, text, text, text, text, text, text)') is not null as squad_room_login_ok,
  (select is_nullable = 'YES' from information_schema.columns
    where table_schema = 'public' and table_name = 'squad_invites' and column_name = 'max_uses') as max_uses_nullable,
  exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'squad_messages'
  ) as realtime_ok;
