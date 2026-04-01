# Hex Siege IO

실시간 팀 땅따먹기 게임입니다. 보드 타일 클릭이 핵심이고, 서버가 공격 판정, 점령, 방어력, 업그레이드, 세션, 저장을 직접 관리합니다.

## 로컬 실행

```bash
npm install
npm start
```

브라우저에서 `http://localhost:3000` 으로 접속합니다.

## 게임 규칙

- 우리 영토와 맞닿은 중립/적 타일을 클릭하면 공격합니다.
- 우리 타일을 클릭하면 방어력을 올립니다.
- 폭탄 아이템을 구매하면 비본진 타일을 거리 제한 없이 폐허로 만들어 아예 비활성화할 수 있습니다.
- 다만 폭탄을 실제로 사용할 때는 추가 골드와 아군 타일 약화 페널티가 발생합니다.
- 폐허 재건으로 무너진 칸을 다시 활성화해 전초기지로 바꿀 수 있습니다.
- 미개척 개척으로 맵 바깥 유휴 칸을 사서 새 땅을 만들 수 있습니다.
- 팀 보급으로 같은 팀 접속 인원 전체에게 즉시 골드를 뿌릴 수 있습니다.
- 업그레이드로 공격력과 자동 골드를 강화할 수 있습니다.
- 관리자 콘솔 로그인 후 접속 중 학번을 밴하거나 해제할 수 있습니다.
- 관리자는 개별/팀/전체 골드 지급, 폐허 일괄 정리, 타일 강제 편집, 게임 초기화까지 실행할 수 있습니다.
- 팀 순위는 점령 칸 수와 총 방어력으로 계산됩니다.

## 운영형 기능

- 학번 기반 단일 세션: 같은 학번으로 다시 접속하면 이전 세션이 종료됩니다.
- 클릭 속도 제한: 초당 과도한 클릭은 서버가 차단합니다.
- 반복적인 클릭 속도 제한 위반은 오토클릭으로 판단해 자동 밴됩니다.
- 아군 폭탄 시도, 폭탄 난사, 반복 도배 채팅 같은 분탕 패턴은 의심 점수로 누적되어 자동 밴될 수 있습니다.
- 저장: `REDIS_URL` 이 있으면 Redis, 없으면 `data/game-state.json` 파일에 저장합니다.
- 환경변수 기반 CORS: `ALLOWED_ORIGINS` 로 허용 도메인을 제한할 수 있습니다.
- 보안 헤더, 소켓 페이로드 제한, IP 기준 접속 제한, 관리자 로그인 잠금이 적용됩니다.

## 환경변수

기본 예시는 `.env.example` 에 있습니다.

- `PORT`: 서버 포트
- `ALLOWED_ORIGINS`: 허용 도메인 목록, 쉼표로 구분
- `ADMIN_PASSWORD`: 관리자 콘솔 비밀번호
- `SOCKET_MAX_PAYLOAD_BYTES`: 소켓 메시지 최대 바이트 수
- `MAX_CONNECTIONS_PER_WINDOW`: 같은 IP의 접속 시도 제한 횟수
- `CONNECTION_WINDOW_MS`: 접속 시도 제한 시간 구간
- `MAX_ADMIN_LOGIN_ATTEMPTS`: 관리자 로그인 최대 실패 횟수
- `ADMIN_LOGIN_WINDOW_MS`: 관리자 로그인 실패 측정 시간 구간
- `ADMIN_LOGIN_LOCKOUT_MS`: 관리자 로그인 잠금 시간
- `MAP_RADIUS`: 육각 맵 반경
- `REDIS_URL`: Redis 연결 문자열
- `REDIS_KEY`: Redis 저장 키
- `STATE_FILE`: 파일 저장 경로
- `BASE_TILE_STRENGTH`: 본진 타일 기본 방어력
- `NEUTRAL_TILE_STRENGTH`: 중립 타일 기본 방어력
- `CAPTURED_TILE_STRENGTH`: 점령 직후 타일 방어력
- `MAX_TILE_STRENGTH`: 타일 최대 방어력
- `BOMB_COST`: 폭탄 1개 구매 가격
- `BOMB_USE_PENALTY_GOLD`: 폭탄 사용 시 추가로 드는 골드
- `BOMB_BACKLASH_DAMAGE`: 폭탄 사용 후 아군 타일 1칸에 들어가는 약화 수치
- `REBUILD_COST`: 폐허 재건 가격
- `EXPAND_COST`: 바깥 땅 개척 가격
- `EXPANDED_TILE_STRENGTH`: 재건/개척 직후 타일 방어력
- `TEAM_SUPPLY_COST`: 팀 보급 1회 비용
- `TEAM_SUPPLY_GOLD`: 팀 보급 1회당 팀원 1명에게 지급되는 골드
- `MAX_CLICKS_PER_WINDOW`: 클릭 제한 횟수
- `CLICK_WINDOW_MS`: 클릭 제한 측정 구간
- `CLICK_RATE_LIMIT_COOLDOWN_MS`: 제한 후 대기 시간
- `AUTO_BAN_RATE_LIMIT_STRIKES`: 자동 밴이 발동하는 제한 누적 횟수
- `AUTO_BAN_WINDOW_MS`: 제한 누적을 계산하는 시간 구간
- `SUSPICION_WINDOW_MS`: 분탕 의심 점수 누적 시간 구간
- `SUSPICION_AUTO_BAN_SCORE`: 자동 밴이 발동하는 의심 점수 기준
- `DUPLICATE_CHAT_WINDOW_MS`: 반복 도배 채팅을 판단하는 시간 구간
- `BOMB_SPAM_WINDOW_MS`: 폭탄 난사를 판단하는 시간 구간
- `BOMB_SPAM_THRESHOLD`: 난사로 보는 폭탄 사용 횟수

## 배포 전 해야 할 일

- 실제 로그인 방식 붙이기
- `ALLOWED_ORIGINS` 를 실도메인으로 고정
- Redis 같은 외부 저장소 연결
- HTTPS, 로그 수집, 프로세스 재시작 정책 구성
