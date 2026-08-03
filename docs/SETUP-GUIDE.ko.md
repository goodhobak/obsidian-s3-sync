# S3 Sync 설치 가이드 (한국어)

Obsidian **S3 Sync** 플러그인으로, 별도의 동기화 서버 없이 내 Obsidian
vault를 S3 호환 오브젝트 스토리지에 직접 동기화하는 방법을 처음부터 끝까지
안내합니다. 데스크톱과 모바일(Android/iOS)을 함께 씁니다.

> 이 문서의 Cloudflare R2 관련 수치·절차는 2026-08-04 기준 Cloudflare 공식
> 문서(developers.cloudflare.com)로 확인한 값입니다. 요금·무료 한도는 바뀔 수
> 있으니 실제 가입 시 현재 값을 다시 확인하세요.

---

## 1. 개요

S3 Sync는 Obsidian vault를 **S3 호환 버킷에 직접** 동기화합니다.

- **동기화 서버가 없습니다.** 플러그인이 AWS Signature V4로 버킷과 직접
  통신합니다. 중간 서버, 별도 계정, 구독이 없습니다.
- **어떤 S3 호환 백엔드든 지원합니다** — Cloudflare R2, AWS S3, MinIO,
  자체 호스팅 RustFS.
- **엔드투엔드 암호화(선택).** AES-256-GCM. 켜면 파일 내용과 메타데이터
  (manifest)까지 클라이언트에서 암호화되어, 스토리지 제공자는 내 노트의
  경로도 내용도 볼 수 없습니다.
- **중복 제거(dedup).** 모든 blob은 내용 기반 주소(content-addressed)라
  같은 내용은 딱 한 번만 저장됩니다.
- **버전 히스토리.** 파일마다 이전 버전을 서버에 보관(기본 5개)하고,
  비교·복원할 수 있습니다.
- **양방향·다중 기기 안전.** manifest를 조건부 요청(`If-Match`)으로 써서
  여러 기기가 동시에 동기화해도 서로 덮어쓰지 않습니다. 삭제는 tombstone으로
  전파되고, 대량 삭제 가드가 있습니다.
- **크로스 플랫폼.** 데스크톱과 모바일에서 동작하며, 모바일 네트워크가
  끊겨도 재개(resume)됩니다.

플러그인 정보: id `s3-sync`, 이름 **S3 Sync**, 데스크톱 전용 아님(모바일 지원).

---

## 2. 옵션 A: Cloudflare R2 (무료 배포, 권장)

가장 간단하고 저렴한 경로입니다. 서버를 직접 운영할 필요가 없고, **egress
(다운로드) 요금이 0원**이라 모바일에서 큰 vault를 반복 동기화해도 전송비
걱정이 없습니다.

### 2.1 무료 한도 (2026-08-04 기준, 현재 값 재확인 권장)

매월 계정마다 다음이 무료로 제공되며 매달 초기화됩니다.

| 항목 | 무료 한도 |
|------|-----------|
| 저장 용량(Storage) | 10 GB-month |
| Class A 작업 (쓰기/목록: PUT, LIST 등) | 월 100만 건 |
| Class B 작업 (읽기: GET 등) | 월 1,000만 건 |
| Egress (인터넷으로 전송) | 무료 (요금 없음) |

- 무료 한도는 **Standard 스토리지에만** 적용됩니다(Infrequent Access 제외).
- 한도를 넘으면 초과분만 과금됩니다. 개인 vault 규모에서는 대개 무료 범위
  안에 들어갑니다.
- 출처: [R2 Pricing](https://developers.cloudflare.com/r2/pricing/)

### 2.2 가입 및 R2 활성화

1. [dash.cloudflare.com](https://dash.cloudflare.com) 에서 계정을 만들거나
   로그인합니다.
2. 왼쪽 메뉴에서 **R2 Object Storage** 를 엽니다.
3. R2를 처음 켤 때 **결제 수단(신용카드 또는 PayPal) 등록이 필요합니다.**
   무료 한도 안에서는 청구되지 않지만, Cloudflare가 남용 방지를 위해 활성화
   시 카드 등록을 요구합니다(2026 기준). 한도를 넘지 않으면 요금은 0원입니다.

### 2.3 버킷 생성 (대시보드)

1. R2 페이지에서 **Create bucket** 을 클릭합니다.
2. 버킷 이름을 입력합니다. 이름 규칙: **소문자(a-z), 숫자(0-9), 하이픈(-)**
   만 사용, 길이 3~63자. 예: `obsidian-vault`.
3. Location은 자동(Automatic)으로 두면 됩니다. **Create bucket** 클릭.

> R2에는 MinIO/RustFS 같은 "관리자 콘솔 로그인(ID/비밀번호)"이 없습니다.
> 접근은 오직 API 토큰으로만 하고, 오브젝트는 Cloudflare 대시보드에서
> 눈으로 둘러봅니다.

### 2.4 R2 API 토큰(액세스 키) 만들기

1. R2 페이지 → **Manage API Tokens** (또는 계정 세부정보의 API Tokens 옆
   **Manage**) → **Create API token**.
2. 권한(Permissions)을 **Object Read & Write** 로 선택합니다.
3. 범위를 방금 만든 **버킷 하나로 한정(Specify bucket)** 합니다. (보안상
   전체 계정이 아니라 이 버킷만 허용하는 것을 권장.)
4. **Create** 를 누르면 다음 값이 나옵니다.
   - **Access Key ID**
   - **Secret Access Key** — ⚠️ 이 화면을 벗어나면 다시 볼 수 없습니다.
     지금 바로 안전한 곳에 복사해 두세요.
   - **S3 엔드포인트 URL** — 형식: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`
     (EU 관할 버킷은 `https://<ACCOUNT_ID>.eu.r2.cloudflarestorage.com`)
5. 출처: [R2 API Tokens](https://developers.cloudflare.com/r2/api/tokens/)

### 2.5 R2 값 → 플러그인 설정 매핑

| R2에서 얻은 값 | 플러그인 설정 필드 | 넣을 값 |
|----------------|-------------------|---------|
| S3 엔드포인트 | **Endpoint** | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` |
| (지역 없음) | **Region** | `auto` (또는 비워두거나 `us-east-1` — 셋 다 동일하게 동작) |
| 버킷 이름 | **Bucket** | 예: `obsidian-vault` |
| Access Key ID | **Access key ID** | R2 토큰의 Access Key ID |
| Secret Access Key | **Secret access key** | R2 토큰의 Secret Access Key |
| — | **Path-style addressing** | **ON (켬)** |
| (선택) | **Key prefix** | 한 버킷에 여러 vault를 넣을 때만. 보통 비워둠 |

> R2는 `auto`가 정식 region 값입니다. region을 요구하는 도구를 위해 빈 값과
> `us-east-1` 도 `auto`로 별칭 처리됩니다.
> ([R2 S3 API](https://developers.cloudflare.com/r2/api/s3/api/))

### 2.6 토큰 회전(rotate) / 폐기(revoke)

- R2 → **Manage API Tokens** 에서 기존 토큰을 **Delete/Revoke** 하면 그
  키는 즉시 무효화됩니다.
- 새 토큰을 만들어(2.4 반복) 플러그인의 Access key ID / Secret access key를
  갈아끼우고 **Test connection** 으로 확인합니다.
- 키가 유출됐다고 의심되면 즉시 폐기 후 재발급하세요.

---

## 3. 옵션 B: 자체 호스팅 RustFS (Docker)

내 서버에서 직접 오브젝트 스토리지를 운영하고 싶을 때. RustFS는 S3 호환
스토어이며, 콘솔 UI와 S3 API를 함께 제공합니다.

### 3.1 컨테이너 실행

포트 9000(S3 API)과 9001(콘솔)을 노출합니다. 아래 값은 **모두 예시/placeholder**
이므로 반드시 본인 값으로 바꾸세요.

```bash
docker run -d \
  --name rustfs \
  -p 9000:9000 \
  -p 9001:9001 \
  -e RUSTFS_VOLUMES=/data \
  -e RUSTFS_ACCESS_KEY=CHANGE_ME_ACCESS \
  -e RUSTFS_SECRET_KEY=CHANGE_ME_LONG_RANDOM_SECRET \
  -v rustfs-data:/data \
  rustfs/rustfs:latest
```

- `-v rustfs-data:/data` — 데이터 볼륨. 컨테이너를 지웠다 다시 만들어도
  이 볼륨이 남아 있으면 데이터는 보존됩니다.
- 포트 9000 = S3 API(플러그인이 접속), 9001 = 웹 콘솔.

### 3.2 어드민 아이디/비밀번호 = 액세스 키/시크릿 (중요)

RustFS는 환경변수 **`RUSTFS_ACCESS_KEY` / `RUSTFS_SECRET_KEY`** 를 root
자격증명으로 씁니다. 이 값이 곧 **콘솔 로그인 계정이자 S3 자격증명**입니다
(둘이 같습니다).

- ⚠️ **`rustfsadmin/rustfsadmin` 같은 기본값·약한 값을 절대 그대로 두지
  마세요.** 이 값을 아는 사람은 스토리지 전체를 읽고 지울 수 있습니다.
  긴 랜덤 문자열(예: `openssl rand -base64 24` 결과)을 시크릿으로 쓰세요.

**자격증명 변경 방법** — 컨테이너를 새 환경변수로 재생성합니다. 데이터
볼륨(`rustfs-data`)은 그대로 두므로 데이터는 유지됩니다.

```bash
docker rm -f rustfs
docker run -d \
  --name rustfs \
  -p 9000:9000 -p 9001:9001 \
  -e RUSTFS_VOLUMES=/data \
  -e RUSTFS_ACCESS_KEY=NEW_ACCESS_KEY \
  -e RUSTFS_SECRET_KEY=NEW_LONG_RANDOM_SECRET \
  -v rustfs-data:/data \
  rustfs/rustfs:latest
```

- 콘솔이 추가 스코프 키(별도 사용자 액세스 키) 생성을 지원한다면, root
  자격증명은 관리용으로만 두고 플러그인에는 버킷 하나만 접근 가능한 별도
  키를 발급해 쓰는 것이 더 안전합니다.

### 3.3 콘솔 접속

- 콘솔 URL: **`http://localhost:9001/rustfs/console/`**
- 로그인: 위에서 정한 **Access Key / Secret Key**.
- ⚠️ 루트 URL(`http://localhost:9001/`)은 **403**을 돌려줍니다. 반드시
  `/rustfs/console/` 경로로 접속하세요.

### 3.4 버킷 생성

콘솔에서 만들거나, AWS CLI로 만들 수 있습니다.

```bash
aws --endpoint-url http://localhost:9000 \
  s3 mb s3://obsidian
```

(AWS CLI에는 `aws configure` 로 위 액세스 키/시크릿을 미리 등록해 두세요.)

### 3.5 플러그인 설정 값 (RustFS)

| 필드 | 값 |
|------|-----|
| Endpoint | `http://localhost:9000` (또는 서버 주소) |
| Region | `us-east-1` (기본값 그대로 두면 됨) |
| Bucket | `obsidian` |
| Access key ID / Secret access key | `RUSTFS_ACCESS_KEY` / `RUSTFS_SECRET_KEY` 값 |
| Path-style addressing | **ON** |

### 3.6 인터넷에 안전하게 노출 (선택)

집/사설 서버의 RustFS를 외부 기기(모바일 등)에서 쓰려면, 포트를 그대로
공개하지 말고 다음 중 하나를 쓰는 것을 권장합니다(개념 안내만; 실제
도메인·IP·자격증명은 각자 환경에서 설정).

- **Cloudflare Tunnel** — 공인 IP·포트 개방 없이 HTTPS로 노출.
- **Tailscale** — 기기끼리 사설 메시 VPN으로 연결.

> Cloudflare Tunnel을 거치면 요청 본문 크기 제한(예: 100 MB)이 걸릴 수
> 있습니다. 큰 파일 동기화가 막히면 6장의 최대 파일 크기 설정으로 상한을
> 낮추세요. (R2 **직접** 연결에는 이 제한이 없습니다.)

---

## 4. 옵션 C: MinIO / AWS S3 (간단 안내)

- **MinIO** — RustFS와 거의 동일합니다. 환경변수만 다릅니다:
  `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` 가 root 자격증명이자 S3 키입니다.
  Path-style addressing **ON**, Endpoint는 MinIO 주소(`http://localhost:9000` 등).
- **AWS S3** — IAM에서 액세스 키를 발급해 사용합니다. Endpoint는 비워두거나
  리전 엔드포인트를 쓰고, Region은 버킷의 실제 리전(예: `ap-northeast-2`).
  AWS는 virtual-hosted 스타일이므로 **Path-style addressing 은 OFF** 로
  둡니다.

---

## 5. 플러그인 설치 (BRAT)

이 플러그인은 아직 커뮤니티 디렉터리에 없어서 **BRAT**로 설치합니다.

1. Obsidian → **Settings → Community plugins → Browse** 에서 **BRAT**
   (Beta Reviewers Auto-update Tool)를 설치하고 **Enable** 합니다.
2. **BRAT 설정 → Add beta plugin** 을 엽니다.
3. 저장소 주소 입력: `https://github.com/goodhobak/obsidian-s3-sync`
4. BRAT가 최신 릴리스를 받아 설치합니다. **Community plugins** 목록에서
   **S3 Sync** 를 **Enable** 합니다.
5. **자동 업데이트** — BRAT 설정의 **"Auto-update plugins at startup"** 을
   켜두면 Obsidian 시작 시 최신 릴리스로 갱신됩니다. 수동 확인은 BRAT →
   **Check for updates**.
6. 데스크톱과 모바일 모두에서 이 방식으로 설치·업데이트됩니다.

---

## 6. 플러그인 설정

**Settings → Community plugins → S3 Sync** 의 톱니 아이콘, 또는 리본의 구름
아이콘 패널 → **Settings** 탭에서 설정합니다.

### Connection (연결)

| 필드 | 설명 |
|------|------|
| **Endpoint** | S3 호환 엔드포인트 URL. R2는 `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, 로컬 RustFS는 `http://localhost:9000`. |
| **Region** | R2는 `auto`, RustFS/MinIO는 기본 `us-east-1`, AWS는 실제 리전. |
| **Bucket** | 버킷 이름. |
| **Key prefix** | (선택) 버킷 안의 하위 폴더. 예: `vaults/main`. 한 버킷에 여러 vault를 담을 때만 사용, 보통 비움. |
| **Access key ID** | 액세스 키. |
| **Secret access key** | 시크릿 키(입력칸은 가려짐). |
| **Path-style addressing** | R2 / RustFS / MinIO는 **ON**, AWS(virtual-hosted)는 **OFF**. |

설정 후 **Test connection → Test** 를 눌러 `connection OK` 가 뜨는지
확인합니다.

### Encryption (엔드투엔드 암호화)

- **End-to-end encryption** 토글. 켜면 파일 내용과 manifest를 클라이언트에서
  AES-256-GCM으로 암호화합니다.
- ⚠️ **vault의 첫 동기화 전에 결정하세요.** 원격 vault가 암호화 여부를
  기록하므로, 나중에 바꾸려면 사실상 새 vault로 다시 시작해야 합니다.
- 켜면 **Passphrase** 필드가 나옵니다. 패스프레이즈는 **기기마다 로컬에만**
  저장되고 서버로 올라가지 않습니다.
- ⚠️ **패스프레이즈를 잃어버리면 암호화된 원격 vault는 복구 불가능합니다.**
  확인 입력칸이 없으니 처음 만들 때 오타가 없는지 두 번 확인하고, 안전한
  곳에 따로 백업하세요.

### What to sync (무엇을 동기화할지)

- **Extensions besides markdown** — 마크다운은 항상 동기화됩니다. 추가로
  동기화할 확장자를 쉼표로 구분해 입력. 기본값: `png, jpg, jpeg, gif, webp,
  svg, mp3, wav, m4a, ogg, mp4, webm, mov, pdf`. 숨김 파일은 절대
  동기화되지 않습니다.
- **Excluded folders** — 제외할 폴더를 체크한 뒤 **Apply** 를 눌러야
  반영됩니다. **Include subfolders** 를 켜면 하위 폴더까지 함께 선택됩니다.
  큰 vault는 **Filter folders** 검색창으로 좁히세요.
- **Maximum file size (MB)** — 이 크기보다 큰 파일은 업로드·다운로드
  **양쪽** 모두 건너뜁니다. 데스크톱에서 `0` = 무제한. **모바일(폰/태블릿)
  에서는 `0`이 안전하게 50 MB 상한으로 동작**합니다(아주 큰 파일을 받다가
  앱이 죽는 것을 막기 위함). 모바일 권장: 50 MB 정도로 두기. 큰 파일은
  데스크톱에서 계속 동기화됩니다.

### App config (.obsidian)

- **Sync .obsidian config folder** — 플러그인·테마·스니펫·설정을 기기 간에
  동기화. 기본 **OFF**. 두 기기에서 모두 켜야 양방향으로 동작합니다.
- 이 플러그인 자신의 폴더와 기기별 workspace 레이아웃은 **항상 제외**되므로,
  S3 자격증명과 패스프레이즈는 절대 업로드되지 않습니다.

### When to sync (언제 동기화할지)

- **Automatic sync** — 로컬 변경 후(디바운스)와 주기적으로 자동 동기화. 기본 ON.
- **Sync interval (seconds)** — 주기적 동기화 간격. 기본 300초, 최소 30초.
- **Push debounce (seconds)** — 마지막 편집 후 업로드까지 대기 시간. 기본 15초.

### Safety & history (안전 및 히스토리)

- **Mass-delete confirmation threshold (%)** — 한 번의 동기화가 추적 파일의
  이 비율 이상을 삭제하려 하면 먼저 확인을 요구. 기본 50%.
- **Backups to keep per file** — 파일별 보관할 이전 버전 수. 기본 **5**,
  최대 50, `0`이면 백업 비활성화. 삭제된 파일도 이 개수만큼 백업을 유지하며,
  **Deleted files** 뷰에서 영구 삭제 전까지 복원할 수 있습니다.
- **Reset local sync state** — "무엇을 동기화했는지" 로컬 기록만 잊습니다
  (실제 파일은 건드리지 않음). 다음 동기화에서 원격과 전부 다시 비교합니다.

### Developer (개발자 모드)

- **Developer mode (diagnostic log)** — 각 동기화의 상세 로그(계획,
  체크포인트별 진행, 메모리, 큰 파일, 오류)를 플러그인 폴더의 파일에
  기록합니다. 문제 해결 시 켜세요(8장 참고).

---

## 7. 첫 동기화 & 다중 기기

1. **암호화 선택을 확정**합니다(6장). 여러 기기에서 **모두 동일**해야
   합니다 — 한 기기만 암호화를 켜면 서로 맞지 않습니다.
2. 리본의 구름 아이콘 패널 → **Sync now**, 또는 명령 팔레트에서
   **S3 Sync: Sync now** 를 실행합니다.
3. **두 번째 기기**에서는:
   - **동일한** Endpoint / Bucket / Access key / Secret key 를 입력하고,
   - 암호화를 쓴다면 **동일한 Passphrase** 를 입력합니다.
   - 그 뒤 **Sync now** 를 실행하면 첫 기기의 vault를 받아옵니다.
4. **모바일 첫 대량 동기화 팁:**
   - Wi-Fi에서 실행하세요(셀룰러 데이터·배터리 절약).
   - 중간에 끊겨도 **재개**됩니다. 큰 인바운드 동기화는 진행 상황을
     체크포인트로 저장하므로 처음부터 다시 받지 않습니다.
   - 50 MB 상한을 넘는 큰 파일은 모바일에서 건너뜁니다(데스크톱에서 동기화).
   - 다운로드는 작은 파일부터 처리해 꾸준히 진척됩니다.

---

## 8. 문제 해결 (Troubleshooting)

**진단 로그 켜기:** Settings → **Developer → Developer mode** 를 켠 뒤,
문제를 재현하고 **Copy log to clipboard** 로 로그를 복사해 공유합니다.
로그 파일 위치: `<vault>/.obsidian/plugins/s3-sync/debug-log.txt`.

자주 겪는 문제:

- **S3 엔드포인트 루트를 브라우저로 열면 `AccessDenied` XML이 뜬다** —
  정상입니다. S3 API는 인증 없는 루트 GET을 거부합니다. 플러그인 연결
  여부는 **Test connection** 으로 판단하세요.
- **연결 실패 / SignatureDoesNotMatch / 404** — 대개 **Path-style
  addressing** 설정이 틀렸습니다. R2 / RustFS / MinIO는 **ON**, AWS는
  **OFF**. Endpoint·Bucket·키 오타도 확인.
- **RustFS 콘솔이 403** — 루트 대신 `http://localhost:9001/rustfs/console/`
  경로로 접속하세요(3.3).
- **충돌(conflict)이 생겼다** — 명령 팔레트의 **S3 Sync: Resolve conflicts
  and errors**(또는 알림/로그의 "Resolve" 링크)로 창을 엽니다. 각 파일을
  *keep remote / use my version / open both* 중에서 선택하고, 상단의 일괄
  버튼(*keep all remote / use all my versions / retry all*)으로 한꺼번에
  처리할 수 있습니다. 겹치지 않는 편집은 자동 3-way 병합됩니다.
- **네트워크가 불안정하다** — 모든 요청은 지수 백오프로 자동 재시도합니다.
  완전히 끊기면 그 동기화는 일찍 멈추고 다음 동기화에서 이어집니다.
- **실수로 파일을 지웠다** — **S3 Sync: Deleted files (restore or
  permanently delete)** 명령으로 목록을 보고 **복원**할 수 있습니다. 삭제된
  파일은 타이머로 자동 삭제되지 않습니다.

---

## 9. 보안 주의사항

- **자격증명은 이 기기 안에만 있습니다.** S3 시크릿 키와 E2E 패스프레이즈는
  vault의 `.obsidian/plugins/s3-sync/data.json` 에 저장됩니다(Obsidian에
  보안 저장소 API가 없어서). **서버로 업로드되지는 않지만**, 그 폴더를 읽을
  수 있는 사람은 값을 볼 수 있습니다. 기기 자체를 신뢰 경계로 다루세요.
- **E2E 암호화를 켜세요.** 그래야 스토리지 제공자(R2/AWS 등)가 평문 내용도
  노트 경로도 보지 못합니다.
- **키 범위를 좁히세요.** R2/API 키는 vault를 담은 **버킷 하나로만** 스코프.
  RustFS/MinIO도 가능하면 root 대신 버킷 한정 키를 발급.
- **키를 주기적으로 회전**하고, 유출 의심 시 즉시 폐기·재발급하세요(2.6).
- **패스프레이즈가 암호화 콘텐츠를 지키는 유일한 열쇠입니다.** 잃어버리면
  복구 불가. 비밀번호 관리자 등 안전한 곳에 반드시 백업하세요.
- **`.obsidian` 설정 동기화를 켜도** 플러그인 폴더와 workspace는 항상
  제외되어 자격증명·패스프레이즈는 올라가지 않습니다.

---

### 부록: 유용한 명령 (명령 팔레트)

- **S3 Sync: Sync now** — 지금 동기화
- **S3 Sync: Open S3 Sync panel** — 사이드 패널 열기
- **S3 Sync: View version history for current file** — 현재 파일 버전 히스토리
- **S3 Sync: Show sync log** — 동기화 로그 보기
- **S3 Sync: Resolve conflicts and errors** — 충돌/오류 해결
- **S3 Sync: Deleted files (restore or permanently delete)** — 삭제 파일 복원
- **S3 Sync: Reset local sync state** — 로컬 동기화 상태 초기화
