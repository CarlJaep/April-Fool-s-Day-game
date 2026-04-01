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
- 폐허 재건으로 무너진 칸을 다시 활성화해 전초기지로 바꿀 수 있습니다.
- 미개척 개척으로 맵 바깥 유휴 칸을 사서 새 땅을 만들 수 있습니다.
- 팀 보급으로 같은 팀 접속 인원 전체에게 즉시 골드를 뿌릴 수 있습니다.
- 업그레이드로 공격력과 자동 골드를 강화할 수 있습니다.
- 관리자 콘솔 로그인 후 접속 중 학번을 밴하거나 해제할 수 있습니다.
- 팀 순위는 점령 칸 수와 총 방어력으로 계산됩니다.

## 운영형 기능

- 학번 기반 단일 세션: 같은 학번으로 다시 접속하면 이전 세션이 종료됩니다.
- 클릭 속도 제한: 초당 과도한 클릭은 서버가 차단합니다.
- 반복적인 클릭 속도 제한 위반은 오토클릭으로 판단해 자동 밴됩니다.
- 저장: `REDIS_URL` 이 있으면 Redis, 없으면 `data/game-state.json` 파일에 저장합니다.
- 환경변수 기반 CORS: `ALLOWED_ORIGINS` 로 허용 도메인을 제한할 수 있습니다.

## 환경변수

기본 예시는 `.env.example` 에 있습니다.

- `PORT`: 서버 포트
- `ALLOWED_ORIGINS`: 허용 도메인 목록, 쉼표로 구분
- `ADMIN_PASSWORD`: 관리자 콘솔 비밀번호
- `MAP_RADIUS`: 육각 맵 반경
- `REDIS_URL`: Redis 연결 문자열
- `REDIS_KEY`: Redis 저장 키
- `STATE_FILE`: 파일 저장 경로
- `BASE_TILE_STRENGTH`: 본진 타일 기본 방어력
- `NEUTRAL_TILE_STRENGTH`: 중립 타일 기본 방어력
- `CAPTURED_TILE_STRENGTH`: 점령 직후 타일 방어력
- `MAX_TILE_STRENGTH`: 타일 최대 방어력
- `BOMB_COST`: 폭탄 1개 구매 가격
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

## 배포 전 해야 할 일

- 실제 로그인 방식 붙이기
- `ALLOWED_ORIGINS` 를 실도메인으로 고정
- Redis 같은 외부 저장소 연결
- HTTPS, 로그 수집, 프로세스 재시작 정책 구성
