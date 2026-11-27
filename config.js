/* AI 공용방 — 런타임 설정
 *
 * 여기 값을 비워 두면 앱은 '로컬 데모'로 열립니다. (localStorage 에 모든 기록 저장)
 * 실시간 모드로 쓰려면 Supabase 프로젝트 URL 과 공개용(publishable/anon) 키를 넣으세요.
 *   · service_role 키는 절대 넣으면 안 됩니다. (브라우저에 노출되는 키입니다)
 *   · 화면의 [방 관리 → 연결]에서 직접 넣어도 됩니다. 그 값은 이 브라우저에만 저장됩니다.
 */
window.SQUAD_CONFIG = {
  supabaseUrl: '',
  supabaseKey: ''
};
