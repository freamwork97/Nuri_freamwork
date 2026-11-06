---
name: captcha-solver
description: 스마트 캡차(CAPTCHA) 감지 및 L3 보안 사용자 승인 연동 스킬
icon: 🛡️
category: security
platform: ["win", "mac", "linux"]
---
# CAPTCHA Solver & Security Guard Skill

웹 서핑 도중 나타나는 reCAPTCHA, Cloudflare Turnstile, hCaptcha 등의 차단 요소를 실시간 감지합니다.

## 작동 방식
1. ARIA 스냅샷 엔진이 페이지 내 캡차 시그니처를 검출하면 `hasCaptcha: true`를 반환합니다.
2. 에이전트는 무리한 자동 시도를 중단하고, Cockpit UI에 L3 사용자 승인 모달을 띄워 사용자가 직접 캡차를 풀 수 있도록 안내합니다.
3. 사용자가 풀이를 완료하고 "계속 진행"을 누르면 즉시 이전 워크플로우를 이어받아 실행합니다.
