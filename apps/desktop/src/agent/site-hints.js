// Site playbooks: short, factual notes about where things are on sites whose UIs confuse agents.
// Injected into the step prompt only when the current URL or the goal matches. The agent still
// decides from the live snapshot; these only tell it what to look for. Keep each hint short.

const HINTS = [
  {
    id: 'naver-blog',
    match: (url, goal) => /blog\.naver\.com/.test(url) || /네이버\s*블로그|블로그.*(글|발행|포스팅)/.test(goal),
    text: `NAVER BLOG (SmartEditor ONE):
- Write page: https://blog.naver.com/GoBlogWrite.naver (needs login; if a login page shows, ask_user).
- On open, a popup "작성 중인 글이 있습니다" may appear: click "취소" to start fresh. Close the help panel ("도움말" / X) if it covers the editor.
- Title: the area with placeholder "제목". Body: the area with placeholder like "본문에 #을 이용하여 태그를 사용해보세요". Click it, then type. You can chain: type title -> click body -> type body.
- "저장" only saves a DRAFT. Publishing is the green "발행" button at the TOP RIGHT of the editor header (next to 저장). It opens a publish layer.
- In the publish layer: 공개 설정 radios "전체공개 / 이웃공개 / 서로이웃공개 / 비공개" — click the one the goal asks (비공개 = private). Then click the "발행" button at the BOTTOM of that layer to actually publish.
- Success: the page leaves the editor and shows the post (URL like blog.naver.com/<id>/<number>). Verify before done.`,
  },
  {
    id: 'youtube-upload',
    match: (url, goal) => /studio\.youtube\.com|youtube\.com\/upload/.test(url) || /쇼츠|shorts|유튜브.*(업로드|올려)|youtube.*upload/i.test(goal),
    text: `YOUTUBE UPLOAD / SHORTS (YouTube Studio):
- Go to https://studio.youtube.com (or https://www.youtube.com/upload which opens the upload dialog). Needs login.
- If Google asks "본인임을 확인해야 합니다" (verify it's you): only the user can finish it. ask_user to complete it in this browser window, then continue the upload.
- Upload: the "만들기"(Create) button -> "동영상 업로드", then the "파일 선택" button opens a file chooser -> use upload with the file path (find it with list_files if the user didn't give one). A Short = vertical (9:16) video up to 3 minutes; YouTube detects it automatically.
- Details step: title textbox ("제목(필수 항목)"), description textbox. "아동용 여부" radios are required: usually "아니요, 아동용이 아닙니다".
- Click "다음" until the "공개 상태"(Visibility) step: radios 비공개 / 일부 공개 / 공개. Then "저장" (or "게시"). Wait for the upload/processing to finish if a progress text is shown, then report the video link shown in the dialog.`,
  },
  {
    id: 'tistory',
    match: (url, goal) => /tistory\.com/.test(url) || /티스토리/.test(goal),
    text: `TISTORY: write page is https://<blog>.tistory.com/manage/newpost . Title textbox at top, body editor below (may be in an iframe). "완료" at the bottom opens publish options (공개/비공개/보호), then "공개 발행"/"비공개 저장" confirms.`,
  },
  {
    id: 'instagram',
    match: (url, goal) => /instagram\.com/.test(url) || /인스타/.test(goal),
    text: `INSTAGRAM (web): new post = the "+"/"만들기" item in the left sidebar -> "게시물" -> "컴퓨터에서 선택" opens a file chooser (use upload). Then "다음" -> "다음" -> caption textbox -> "공유하기".`,
  },
  {
    id: 'coupang',
    match: (url, goal) => /coupang\.com/.test(url) || /쿠팡/.test(goal),
    text: `COUPANG: search URL https://www.coupang.com/np/search?q=<query>. On a product page "장바구니 담기" adds to cart (safe). Never click 구매하기/바로구매 unless asked.`,
  },
];

function siteHints(url = '', goal = '') {
  return HINTS.filter((h) => {
    try {
      return h.match(String(url), String(goal));
    } catch {
      return false;
    }
  }).map((h) => h.text);
}

/** Tasks that must use the bundled Chromium's Google session (see google-browser.js). */
const needsRealBrowser = (goal) => /유튜브|youtube|쇼츠|shorts/i.test(goal) && /업로드|올려|게시|스튜디오|채널|프로필|배너|upload|publish|studio/i.test(goal);

module.exports = { siteHints, needsRealBrowser, HINTS };
