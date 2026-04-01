# Hex Reactor IO

실시간 팀 클리커 게임입니다. 서버가 클릭, 업그레이드, 자동 수입, 세션, 저장을 직접 관리합니다.

## 로컬 실행

```bash
npm install
npm start
```

브라우저에서 `http://localhost:3000` 으로 접속합니다.

## 운영형 기능

- 학번 기반 단일 세션: 같은 학번으로 다시 접속하면 이전 세션이 종료됩니다.
- 클릭 속도 제한: 초당 과도한 클릭은 서버가 차단합니다.
- 저장: `REDIS_URL` 이 있으면 Redis, 없으면 `data/game-state.json` 파일에 저장합니다.
- 환경변수 기반 CORS: `ALLOWED_ORIGINS` 로 허용 도메인을 제한할 수 있습니다.

## 환경변수

기본 예시는 `.env.example` 에 있습니다.

- `PORT`: 서버 포트
- `ALLOWED_ORIGINS`: 허용 도메인 목록, 쉼표로 구분
- `REDIS_URL`: Redis 연결 문자열
- `REDIS_KEY`: Redis 저장 키
- `STATE_FILE`: 파일 저장 경로
- `MAX_CLICKS_PER_WINDOW`: 클릭 제한 횟수
- `CLICK_WINDOW_MS`: 클릭 제한 측정 구간
- `CLICK_RATE_LIMIT_COOLDOWN_MS`: 제한 후 대기 시간

## 배포 전 해야 할 일

- 실제 로그인 방식 붙이기
- `ALLOWED_ORIGINS` 를 실도메인으로 고정
- Redis 같은 외부 저장소 연결
- HTTPS, 로그 수집, 프로세스 재시작 정책 구성
