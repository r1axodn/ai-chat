/* AI 공용방 — 런타임 설정
 *
 * 아래 값이 채워져 있으면 처음 방문해도 곧바로 'Supabase 실시간' 모드로 열립니다.
 * (friday-hud·cubetimer 와 같은 Supabase 프로젝트의 공개용 URL 과 publishable 키입니다)
 *   · service_role(시크릿) 키는 절대 넣으면 안 됩니다. (브라우저에 노출되는 키입니다)
 *   · 다른 프로젝트를 쓰려면 화면의 [방 관리 → 연결]에서 바꾸세요. 그 값은 이 브라우저에만 저장됩니다.
 *   · 값을 비워 두면 '로컬 데모'로 열립니다. (localStorage 에 모든 기록 저장)
 */
window.SQUAD_CONFIG = {
  supabaseUrl: 'https://vipaohlgodyrbjnsewuo.supabase.co',
  supabaseKey: 'sb_publishable_pl28DHu3fwfqU-Nw92hyPg_nLcdeJaS'
};
