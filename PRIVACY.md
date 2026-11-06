# Privacy Policy

**English** · [한국어](#개인정보처리방침)

Effective date: November 6, 2026

Nuri is open-source software that runs on your own computer. The Nuri project has no server and does not collect, receive or sell any information about you. This policy explains what the app stores on your computer and what it sends to other services when you use it.

## 1. What the Nuri project collects

Nothing. The app has no analytics, telemetry, crash reporting, advertising or account system. The developers cannot see your tasks, files, logins or usage.

## 2. What is stored on your computer

| Data | Where | Notes |
|---|---|---|
| Settings and schedules | `%APPDATA%\Nuri` | Scheduled tasks are encrypted with your Windows account (DPAPI). |
| Cookies and logins of sites you use in the app, including the Google sign-in profile | `%APPDATA%\Nuri` | Kept so you stay signed in. Cookies are encrypted by Chromium. |
| Task history (your requests and the agent's steps and results) | the app's local storage in `%APPDATA%\Nuri` | Limited by Settings > General > Task history size. |
| Result files, downloads and copies of attached files | the work folder (`%APPDATA%\Nuri\workspace`) and the download folder you choose | Copies of attached files are deleted after 30 days. |
| Logs (including the text of your requests) | `%APPDATA%\Nuri\logs` | Used only for troubleshooting on your computer. |
| Local engine token | `%APPDATA%\Nuri\.anb-data` | Lets only this app talk to its local AI engine. |

When run from source, logs, the work folder and the token are kept in the repository folder instead.

## 3. What is sent to other services

Nuri sends data only where it must to do the task you asked for:

- **The AI provider you choose** (Anthropic for Claude, OpenAI for GPT, Google for Gemini), through that provider's official command-line tool and your own subscription sign-in. To decide each step, the AI receives your request, a text view of the current page or window, screenshots when needed, the contents of files you attach, and earlier steps of the task. The provider handles this data under its own terms and privacy policy, which you accepted when you signed in to its tool.
- **Websites** the agent or you open. They receive what any browser sends, such as your IP address and their cookies, and whatever the task enters into them.
- **Google**, once when you set up from source: `npm run get-chromium` downloads Chromium (Chrome for Testing) from Google's servers. When you use Google sign-in, the app also opens your Google session about once a day to keep it from expiring.

Nuri does not send API keys: it removes API-key environment variables so usage always goes through your subscription.

## 4. Sensitive information

The agent stops and leaves sign-ins, passwords and certificate logins to you. Still, anything shown on a page the agent reads, or in a file you attach, can reach the AI provider. Do not give Nuri tasks involving information you do not want that provider to process.

## 5. Your choices

- Clear the task history: Settings > Data · Diagnostics > Clear task history.
- Reset settings: Settings > Data · Diagnostics > Reset settings.
- Sign out of a site in the app as in any browser, or sign out of an AI tool with its own command (for example `claude auth logout`).
- Remove everything: uninstall Nuri, then delete the `%APPDATA%\Nuri` folder.

## 6. Children

Nuri is not directed to children under 14 and the project does not knowingly process their information.

## 7. Changes and contact

Changes to this policy are published in this repository with a new effective date. Questions: open an issue at <https://github.com/lsszz2100/Nuri/issues>.

---

# 개인정보처리방침

[English](#privacy-policy) · **한국어**

시행일: 2026년 11월 6일

Nuri는 사용자의 컴퓨터에서 실행되는 오픈소스 소프트웨어입니다. Nuri 프로젝트는 서버가 없으며, 사용자에 관한 어떤 정보도 수집하거나 받거나 판매하지 않습니다. 이 방침은 앱이 사용자의 컴퓨터에 무엇을 저장하고, 사용 중에 다른 서비스로 무엇을 보내는지 설명합니다.

## 1. Nuri 프로젝트가 수집하는 정보

없습니다. 앱에는 사용 통계, 원격 측정, 오류 보고, 광고, 회원 가입 기능이 없습니다. 개발자는 사용자의 작업, 파일, 로그인, 사용 기록을 볼 수 없습니다.

## 2. 사용자의 컴퓨터에 저장되는 정보

| 정보 | 위치 | 참고 |
|---|---|---|
| 설정, 예약 작업 | `%APPDATA%\Nuri` | 예약 작업은 Windows 계정 기준으로 암호화됩니다(DPAPI). |
| 앱에서 쓰는 사이트의 쿠키와 로그인 상태(Google 로그인 프로필 포함) | `%APPDATA%\Nuri` | 로그인을 유지하기 위해 보관합니다. 쿠키는 Chromium이 암호화합니다. |
| 작업 기록(요청, 에이전트의 단계와 결과) | `%APPDATA%\Nuri` 안의 앱 저장소 | 설정 > 일반 > 작업 기록 보관 개수만큼 보관합니다. |
| 결과 파일, 내려받은 파일, 첨부 파일 복사본 | 작업 폴더(`%APPDATA%\Nuri\workspace`)와 사용자가 정한 다운로드 폴더 | 첨부 파일 복사본은 30일 뒤 지웁니다. |
| 로그(요청 내용 포함) | `%APPDATA%\Nuri\logs` | 사용자 컴퓨터에서 문제를 확인할 때만 씁니다. |
| 로컬 엔진 토큰 | `%APPDATA%\Nuri\.anb-data` | 이 앱만 로컬 AI 엔진에 접속할 수 있게 합니다. |

소스에서 실행하면 로그, 작업 폴더, 토큰은 저장소 폴더에 저장됩니다.

## 3. 다른 서비스로 보내는 정보

Nuri는 사용자가 요청한 작업에 꼭 필요한 곳으로만 정보를 보냅니다.

- **사용자가 고른 AI 회사**(Claude는 Anthropic, GPT는 OpenAI, Gemini는 Google): 각 회사의 공식 CLI와 사용자의 구독 로그인을 통해 보냅니다. AI가 단계마다 판단할 수 있도록 요청 내용, 현재 페이지나 창의 텍스트, 필요할 때의 스크린샷, 첨부한 파일 내용, 앞선 단계가 전달됩니다. 이 정보는 사용자가 해당 CLI에 로그인할 때 동의한 각 회사의 약관과 개인정보처리방침에 따라 처리됩니다.
- **웹사이트**: 에이전트나 사용자가 연 사이트는 일반 브라우저와 마찬가지로 IP 주소와 해당 사이트의 쿠키, 그리고 작업 중 입력한 내용을 받습니다.
- **Google**: 소스에서 설치할 때 `npm run get-chromium`이 Google 서버에서 Chromium(Chrome for Testing)을 한 번 내려받습니다. Google 로그인을 쓰면 로그인이 만료되지 않도록 하루 한 번 정도 Google 세션을 열어 확인합니다.

Nuri는 API 키를 보내지 않습니다. API 키 환경 변수를 지우고 실행하므로 사용량은 항상 구독으로 처리됩니다.

## 4. 민감한 정보

에이전트는 로그인, 비밀번호, 공동인증서 입력을 사용자에게 맡기고 멈춥니다. 그래도 에이전트가 읽는 페이지나 첨부한 파일에 보이는 내용은 AI 회사로 전달될 수 있습니다. AI 회사가 처리하지 않았으면 하는 정보가 담긴 작업은 맡기지 마세요.

## 5. 사용자의 선택

- 작업 기록 지우기: 설정 > 데이터 · 진단 > 작업 기록 지우기
- 설정 초기화: 설정 > 데이터 · 진단 > 설정 초기화
- 사이트 로그아웃은 일반 브라우저처럼 하고, AI 도구 로그아웃은 각 도구의 명령으로 합니다(예: `claude auth logout`).
- 모두 지우기: Nuri를 제거한 뒤 `%APPDATA%\Nuri` 폴더를 지웁니다.

## 6. 아동

Nuri는 만 14세 미만 아동을 대상으로 하지 않으며, 프로젝트는 아동의 정보를 알면서 처리하지 않습니다.

## 7. 변경과 문의

이 방침이 바뀌면 새 시행일과 함께 이 저장소에 공개합니다. 문의는 <https://github.com/lsszz2100/Nuri/issues>에 이슈로 남겨 주세요.
