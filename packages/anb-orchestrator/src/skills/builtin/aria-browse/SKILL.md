---
name: aria-browse
description: 접근성 트리(ARIA) #ref 기반 자율 웹 인터랙션 스킬
icon: 🌐
category: automation
platform: ["win", "mac", "linux"]
---
# ARIA Autonomous Browse Skill

접근성 트리(ARIA 스냅샷)로 페이지를 읽고 조작하는 자율 상호작용 스킬입니다.

## 작동 방식
1. 웹페이지의 DOM을 ARIA 트리로 파싱하여 `#ref1`, `#ref2` 등의 식별자를 생성합니다.
2. 에이전트는 해당 레퍼런스를 통해 검색창 입력, 버튼 클릭, 링크 이동을 결정합니다.
3. 텍스트/접근성 트리만을 전송하므로 기존 스크린샷 OCR 방식 대비 90% 이상의 토큰을 절약하고 지연시간을 단축합니다.
