/* PSD 패스보이스 — 로컬 전용. 모든 데이터는 이 기기의 localStorage에만 저장되고
   서버로 전송되지 않는다. OCR(Tesseract.js)과 음성인식(Web Speech API)도 브라우저 안에서 처리된다. */

const DB_KEY = "psd_passvoice_db_v1";

function loadDB() {
  try {
    return JSON.parse(localStorage.getItem(DB_KEY) || "[]");
  } catch {
    return [];
  }
}
function saveDB(rows) {
  localStorage.setItem(DB_KEY, JSON.stringify(rows));
  renderDBCount();
}
function upsertRows(newRows) {
  const db = loadDB();
  for (const r of newRows) {
    const key = normalizeStation(r.station);
    if (!key) continue;
    const idx = db.findIndex(x => normalizeStation(x.station) === key);
    const record = {
      seq: r.seq || "",
      line: r.line || "",
      station: r.station.trim(),
      prev: r.prev || "",
      curr: r.curr || "",
      aux: r.aux || "",
      updatedAt: new Date().toISOString(),
    };
    if (idx >= 0) db[idx] = { ...db[idx], ...record };
    else db.push(record);
  }
  saveDB(db);
}
function deleteStation(station) {
  const db = loadDB().filter(x => x.station !== station);
  saveDB(db);
}
function normalizeStation(s) {
  return (s || "").trim().replace(/\s+/g, "").replace(/역$/, "");
}

function renderDBCount() {
  document.getElementById("dbcount").textContent = `${loadDB().length}개 역 저장됨`;
}

/* ---------- 탭 전환 ---------- */
document.querySelectorAll(".tabbtn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabbtn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "tab-list") renderListTab();
    if (btn.dataset.tab === "tab-voice") renderQuickList();
  });
});

/* ---------- 사진 → OCR → 파싱 ---------- */
const imgInput = document.getElementById("imgInput");
const scanPreview = document.getElementById("scanPreview");
const scanPreviewWrap = document.getElementById("scanPreviewWrap");
const ocrProgress = document.getElementById("ocrProgress");
const ocrBarFill = document.getElementById("ocrBarFill");
const ocrProgressText = document.getElementById("ocrProgressText");
const parsedWrap = document.getElementById("parsedWrap");
const parsedBody = document.getElementById("parsedBody");
const parsedCount = document.getElementById("parsedCount");

let currentParsedRows = [];

const ocrError = document.getElementById("ocrError");
const ocrErrorText = document.getElementById("ocrErrorText");
const ocrRetryBtn = document.getElementById("ocrRetryBtn");
let lastScanFile = null;

imgInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  lastScanFile = file;
  runOcr(file);
});
ocrRetryBtn.addEventListener("click", () => {
  if (lastScanFile) runOcr(lastScanFile);
});

/* ---------- OpenCV.js 기반 문서 스캐너 전처리 ---------- */
let openCvLoadPromise = null;
function loadOpenCv() {
  if (openCvLoadPromise) return openCvLoadPromise;
  openCvLoadPromise = new Promise((resolve, reject) => {
    if (window.cv && window.cv.Mat) { resolve(window.cv); return; }
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.12.0-release.1/dist/opencv.js";
    script.onload = () => {
      const cv = window.cv;
      if (!cv) { reject(new Error("OpenCV.js를 불러왔지만 cv 객체를 찾지 못했습니다.")); return; }
      if (cv.Mat) { resolve(cv); return; }
      cv["onRuntimeInitialized"] = () => resolve(cv);
    };
    script.onerror = () => reject(new Error("OpenCV.js 스크립트를 내려받지 못했습니다(네트워크 확인 필요)."));
    document.head.appendChild(script);
  });
  return openCvLoadPromise;
}

/** 4개 점을 [좌상, 우상, 우하, 좌하] 순서로 정렬한다. */
function orderQuadPoints(pts) {
  const sums = pts.map((p) => p.x + p.y);
  const diffs = pts.map((p) => p.x - p.y);
  const tl = pts[sums.indexOf(Math.min(...sums))];
  const br = pts[sums.indexOf(Math.max(...sums))];
  const tr = pts[diffs.indexOf(Math.max(...diffs))];
  const bl = pts[diffs.indexOf(Math.min(...diffs))];
  return [tl, tr, br, bl];
}

/**
 * 구글렌즈/오피스렌즈 같은 문서 스캐너 앱이 하는 것과 같은 순서로 전처리한다:
 * 1) 화면(문서) 경계를 찾아 2) 원근왜곡을 펴서 정면 크롭하고 3) 부분별 밝기 차이에
 * 강한 적응형 이진화로 깨끗한 흑백 문서를 만든다. 모니터 반사광·기울어진 촬영각·
 * 무아레 무늬에 전역 대비 조정보다 훨씬 강하다. 경계를 못 찾으면 원본 전체를
 * 그대로 이진화해서 최소한의 개선만 적용한다.
 */
async function scanDocument(file, onStatus) {
  const cv = await loadOpenCv();
  const cleanup = [];
  const track = (m) => { cleanup.push(m); return m; };

  try {
    onStatus && onStatus("문서 경계 찾는 중…");
    const bitmap = await createImageBitmap(file);
    const srcCanvas = document.createElement("canvas");
    srcCanvas.width = bitmap.width;
    srcCanvas.height = bitmap.height;
    srcCanvas.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close();

    const src = track(cv.imread(srcCanvas));

    const workWidth = 700;
    const scale = Math.min(1, workWidth / src.cols);
    const small = track(new cv.Mat());
    cv.resize(src, small, new cv.Size(Math.round(src.cols * scale), Math.round(src.rows * scale)));

    const gray = track(new cv.Mat());
    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
    const blurredSmall = track(new cv.Mat());
    cv.GaussianBlur(gray, blurredSmall, new cv.Size(5, 5), 0);
    const edges = track(new cv.Mat());
    cv.Canny(blurredSmall, edges, 50, 150);
    const kernel = track(cv.Mat.ones(3, 3, cv.CV_8U));
    const dilated = track(new cv.Mat());
    cv.dilate(edges, dilated, kernel);

    const contours = track(new cv.MatVector());
    const hierarchy = track(new cv.Mat());
    cv.findContours(dilated, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    let bestQuad = null;
    let bestArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const peri = cv.arcLength(cnt, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        const area = cv.contourArea(approx);
        if (area > bestArea && area > small.cols * small.rows * 0.2) {
          bestArea = area;
          if (bestQuad) bestQuad.delete();
          bestQuad = approx;
        } else {
          approx.delete();
        }
      } else {
        approx.delete();
      }
      cnt.delete();
    }

    let warped = null;
    if (bestQuad) {
      const pts = [];
      for (let i = 0; i < 4; i++) {
        const p = bestQuad.intPtr(i, 0);
        pts.push({ x: p[0] / scale, y: p[1] / scale });
      }
      bestQuad.delete();
      const [tl, tr, br, bl] = orderQuadPoints(pts);
      const widthTop = Math.hypot(tr.x - tl.x, tr.y - tl.y);
      const widthBottom = Math.hypot(br.x - bl.x, br.y - bl.y);
      const heightLeft = Math.hypot(bl.x - tl.x, bl.y - tl.y);
      const heightRight = Math.hypot(br.x - tr.x, br.y - tr.y);
      const dstW = Math.round(Math.max(widthTop, widthBottom));
      const dstH = Math.round(Math.max(heightLeft, heightRight));

      if (dstW > 150 && dstH > 150) {
        onStatus && onStatus("기울어진 각도 펴는 중…");
        const srcTri = track(cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]));
        const dstTri = track(cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, dstW, 0, dstW, dstH, 0, dstH]));
        const M = track(cv.getPerspectiveTransform(srcTri, dstTri));
        warped = track(new cv.Mat());
        cv.warpPerspective(src, warped, M, new cv.Size(dstW, dstH));
      }
    }

    onStatus && onStatus("흑백 문서로 정리하는 중…");
    const base = warped || src;
    const g2 = track(new cv.Mat());
    cv.cvtColor(base, g2, cv.COLOR_RGBA2GRAY);
    const denoised = track(new cv.Mat());
    cv.medianBlur(g2, denoised, 3);
    const thresh = track(new cv.Mat());
    cv.adaptiveThreshold(denoised, thresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 31, 15);

    const outCanvas = document.createElement("canvas");
    cv.imshow(outCanvas, thresh);

    return await new Promise((resolve) => outCanvas.toBlob((blob) => resolve(blob || file), "image/png"));
  } finally {
    cleanup.forEach((m) => { try { m.delete(); } catch { /* 이미 해제됐으면 무시 */ } });
  }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} 응답이 ${ms / 1000}초 넘게 없습니다. 인터넷 연결(특히 사내/공공 와이파이 차단)을 의심해보세요.`)), ms)),
  ]);
}

async function runOcr(file) {
  scanPreview.src = URL.createObjectURL(file);
  scanPreviewWrap.hidden = false;
  document.getElementById("scanProcessedWrap").hidden = true;
  parsedWrap.hidden = true;
  hideOcrDebug();
  hideOcrError();
  ocrProgress.hidden = false;
  ocrBarFill.style.width = "0%";
  ocrProgressText.textContent = "인식 준비 중… (처음 실행 시 한글 인식 모듈을 내려받아 다소 걸립니다)";

  if (typeof Tesseract === "undefined") {
    ocrProgress.hidden = true;
    showOcrError("OCR 엔진(Tesseract.js)을 불러오지 못했습니다. 인터넷 연결을 확인하거나, 와이파이가 외부 CDN을 막고 있다면 데이터(LTE/5G)로 전환해서 다시 시도해보세요.");
    return;
  }

  let worker = null;
  try {
    ocrProgressText.textContent = "문서 스캐너 엔진 불러오는 중… (처음 한 번만, 다소 걸릴 수 있습니다)";
    const processed = await withTimeout(
      scanDocument(file, (msg) => { ocrProgressText.textContent = msg; }),
      60000,
      "문서 스캐너 전처리"
    );
    document.getElementById("scanProcessedPreview").src = URL.createObjectURL(processed);
    document.getElementById("scanProcessedWrap").hidden = false;

    worker = await withTimeout(
      Tesseract.createWorker("kor+eng", 1, {
        logger: (m) => {
          if (m.status && typeof m.progress === "number") {
            ocrBarFill.style.width = `${Math.round(m.progress * 100)}%`;
            ocrProgressText.textContent = `${ocrStatusKo(m.status)} ${Math.round(m.progress * 100)}%`;
          }
        },
      }),
      45000,
      "한글 인식 모듈 다운로드"
    );
    // 엑셀 표처럼 격자선이 있는 이미지는 자동 레이아웃 분석이 열을 따로따로 묶어
    // 행 순서를 망가뜨리는 경우가 많다. "균일한 한 덩어리 텍스트"로 강제해서
    // 위→아래 줄 순서를 그대로 유지시킨다.
    await worker.setParameters({ tessedit_pageseg_mode: "6" });
    const { data } = await withTimeout(worker.recognize(processed), 45000, "글자 인식");
    await worker.terminate();

    ocrProgress.hidden = true;
    const defaultLine = document.getElementById("lineInput").value.trim();
    currentParsedRows = parseTableText(data.text, defaultLine);
    renderParsedTable();

    if (currentParsedRows.length === 0) {
      showOcrDebug(data.text);
    }
  } catch (err) {
    ocrProgress.hidden = true;
    if (worker) { try { await worker.terminate(); } catch { /* 이미 종료됐으면 무시 */ } }
    showOcrError(`${err.name || "오류"}: ${err.message}`);
  }
}

const ocrDebug = document.getElementById("ocrDebug");
const ocrDebugText = document.getElementById("ocrDebugText");
function showOcrError(msg) {
  ocrErrorText.textContent = msg;
  ocrError.hidden = false;
}
function hideOcrError() {
  ocrError.hidden = true;
}
function showOcrDebug(rawText) {
  ocrDebugText.textContent = rawText.trim() || "(인식된 글자가 없습니다)";
  ocrDebug.hidden = false;
}
function hideOcrDebug() {
  ocrDebug.hidden = true;
}

function ocrStatusKo(status) {
  const map = {
    "loading tesseract core": "엔진 불러오는 중",
    "initializing tesseract": "엔진 준비 중",
    "loading language traineddata": "한글 인식 모듈 다운로드",
    "initializing api": "초기화 중",
    "recognizing text": "글자 인식 중",
  };
  return map[status] || status;
}

/**
 * OCR이 숫자를 흔히 잘못 읽는 문자(O/o→0, I/l→1)를, 숫자가 섞인 토큰 안에서만 되돌린다.
 * "장승배기역" 같은 순수 한글 토큰은 손대지 않는다.
 */
function normalizeOcrDigits(text) {
  return text.replace(/\b[0-9OolI]{3,5}\b/g, (tok) => {
    if (!/\d/.test(tok)) return tok;
    return tok.replace(/[Oo]/g, "0").replace(/[Il]/g, "1");
  });
}

/**
 * 사진 한 줄(=표의 한 행)을 대상으로 연번 / 역명 / 비밀번호 3종을 뽑아낸다.
 * 연번은 1~3자리 숫자, 비밀번호는 4자리 숫자라는 규칙을 이용해 구분한다.
 */
function parseTableText(rawText, defaultLine) {
  const lines = normalizeOcrDigits(rawText).split("\n").map(l => l.trim()).filter(Boolean);
  const rows = [];
  for (const line of lines) {
    const stationMatch = line.match(/([가-힣]{2,10}역)/);
    if (!stationMatch) continue; // 역명이 없는 줄(헤더, 제목 등)은 건너뜀

    const seqMatch = line.match(/^\D{0,4}(\d{1,3})\b/);
    const seq = seqMatch ? seqMatch[1] : "";

    const fourDigits = line.match(/\b\d{4}\b/g) || [];

    rows.push({
      seq,
      line: defaultLine,
      station: stationMatch[1],
      prev: fourDigits[0] || "",
      curr: fourDigits[1] || "",
      aux: fourDigits[2] || "",
    });
  }
  return rows;
}

function renderParsedTable() {
  parsedBody.innerHTML = "";
  currentParsedRows.forEach((row, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input data-i="${i}" data-f="seq" value="${escapeAttr(row.seq)}" inputmode="numeric" style="width:44px"></td>
      <td><input data-i="${i}" data-f="station" value="${escapeAttr(row.station)}"></td>
      <td><input data-i="${i}" data-f="prev" value="${escapeAttr(row.prev)}" inputmode="numeric" style="width:60px"></td>
      <td><input data-i="${i}" data-f="curr" value="${escapeAttr(row.curr)}" inputmode="numeric" style="width:60px"></td>
      <td><input data-i="${i}" data-f="aux" value="${escapeAttr(row.aux)}" inputmode="numeric" style="width:60px"></td>
      <td><button class="rowdelete" data-del="${i}">✕</button></td>
    `;
    parsedBody.appendChild(tr);
  });
  parsedCount.textContent = `(${currentParsedRows.length}건)`;
  parsedWrap.hidden = currentParsedRows.length === 0;

  parsedBody.querySelectorAll("input").forEach(inp => {
    inp.addEventListener("input", () => {
      currentParsedRows[+inp.dataset.i][inp.dataset.f] = inp.value;
    });
  });
  parsedBody.querySelectorAll("[data-del]").forEach(btn => {
    btn.addEventListener("click", () => {
      currentParsedRows.splice(+btn.dataset.del, 1);
      renderParsedTable();
    });
  });
}

document.getElementById("addRowBtn").addEventListener("click", () => {
  currentParsedRows.push({ seq: "", line: document.getElementById("lineInput").value.trim(), station: "", prev: "", curr: "", aux: "" });
  renderParsedTable();
});
document.getElementById("addRowBtn2").addEventListener("click", () => {
  hideOcrDebug();
  currentParsedRows.push({ seq: "", line: document.getElementById("lineInput").value.trim(), station: "", prev: "", curr: "", aux: "" });
  renderParsedTable();
});

document.getElementById("saveParsedBtn").addEventListener("click", () => {
  const valid = currentParsedRows.filter(r => r.station.trim());
  if (!valid.length) { alert("저장할 역이 없습니다."); return; }
  upsertRows(valid);
  currentParsedRows = [];
  parsedWrap.hidden = true;
  scanPreviewWrap.hidden = true;
  imgInput.value = "";
  alert(`${valid.length}개 역을 저장했습니다.`);
});

function escapeAttr(s) {
  return (s || "").replace(/"/g, "&quot;");
}

/* ---------- 전체 목록 탭 ---------- */
const listBody = document.getElementById("listBody");

function renderListTab() {
  const db = loadDB().sort((a, b) => (a.seq || "").localeCompare(b.seq || "", undefined, { numeric: true }));
  listBody.innerHTML = "";
  db.forEach(row => {
    const tr = document.createElement("tr");
    const dateStr = row.updatedAt ? new Date(row.updatedAt).toLocaleDateString("ko-KR", { month: "2-digit", day: "2-digit" }) : "";
    tr.innerHTML = `
      <td>${escapeAttr(row.seq)}</td>
      <td>${escapeAttr(row.line)}</td>
      <td>${escapeAttr(row.station)}</td>
      <td class="mono">${escapeAttr(row.prev)}</td>
      <td class="mono">${escapeAttr(row.curr)}</td>
      <td class="mono">${escapeAttr(row.aux)}</td>
      <td>${dateStr}</td>
      <td><button class="rowdelete" data-delstation="${escapeAttr(row.station)}">✕</button></td>
    `;
    listBody.appendChild(tr);
  });
  listBody.querySelectorAll("[data-delstation]").forEach(btn => {
    btn.addEventListener("click", () => {
      if (confirm(`${btn.dataset.delstation}을(를) 삭제할까요?`)) {
        deleteStation(btn.dataset.delstation);
        renderListTab();
      }
    });
  });
}

/* ---------- 백업 내보내기 / 불러오기 ---------- */
document.getElementById("exportBtn").addEventListener("click", () => {
  const db = loadDB();
  if (!db.length) { alert("내보낼 데이터가 없습니다."); return; }
  const dateStr = new Date().toISOString().slice(0, 10);
  const blob = new Blob([JSON.stringify(db, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `psd-passvoice-backup-${dateStr}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

document.getElementById("importInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error("백업 파일 형식이 올바르지 않습니다.");
    upsertRows(parsed);
    renderListTab();
    alert(`${parsed.length}개 역을 불러왔습니다.`);
  } catch (err) {
    alert("불러오기에 실패했습니다: " + err.message);
  } finally {
    e.target.value = "";
  }
});

document.getElementById("addManualBtn").addEventListener("click", () => {
  const station = prompt("역명을 입력하세요 (예: 온수역)");
  if (!station) return;
  const curr = prompt("이번 비밀번호") || "";
  const aux = prompt("보조잠금장치 비밀번호") || "";
  const line = prompt("호선") || "";
  upsertRows([{ station, curr, aux, line, seq: "" }]);
  renderListTab();
});

/* ---------- 음성 조회 ---------- */
const micBtn = document.getElementById("micBtn");
const micStatus = document.getElementById("micStatus");
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;

if (SpeechRecognition) {
  recognition = new SpeechRecognition();
  recognition.lang = "ko-KR";
  recognition.interimResults = false;
  recognition.maxAlternatives = 3;

  recognition.onstart = () => {
    micBtn.classList.add("listening");
    micStatus.textContent = "듣고 있습니다…";
  };
  recognition.onerror = (e) => {
    micBtn.classList.remove("listening");
    micStatus.textContent = e.error === "not-allowed" ? "마이크 권한을 허용해주세요" : "음성 인식에 실패했습니다";
  };
  recognition.onend = () => {
    micBtn.classList.remove("listening");
  };
  recognition.onresult = (e) => {
    const said = e.results[0][0].transcript;
    micStatus.textContent = `"${said}" 로 검색 중…`;
    handleVoiceQuery(said);
  };
} else {
  micStatus.textContent = "이 브라우저는 음성 인식을 지원하지 않습니다. 아래 목록에서 직접 눌러주세요.";
}

micBtn.addEventListener("click", () => {
  if (!recognition) return;
  try { recognition.start(); } catch { /* 이미 듣는 중이면 무시 */ }
});

function handleVoiceQuery(said) {
  const db = loadDB();
  const norm = normalizeStation(said);
  let match = db.find(r => normalizeStation(r.station) === norm);
  if (!match) match = db.find(r => normalizeStation(r.station).includes(norm) || norm.includes(normalizeStation(r.station)));

  if (match) {
    micStatus.textContent = "버튼을 눌러 역 이름을 말해주세요";
    showPopup(match);
  } else {
    micStatus.textContent = `"${said}"에 해당하는 역을 찾지 못했습니다`;
  }
}

function renderQuickList() {
  const db = loadDB().sort((a, b) => (a.seq || "").localeCompare(b.seq || "", undefined, { numeric: true }));
  const wrap = document.getElementById("quickStationList");
  wrap.innerHTML = "";
  db.slice(0, 30).forEach(row => {
    const chip = document.createElement("button");
    chip.className = "quickchip";
    chip.textContent = row.station;
    chip.addEventListener("click", () => showPopup(row));
    wrap.appendChild(chip);
  });
}

/* ---------- 결과 팝업 ---------- */
const popupOverlay = document.getElementById("popupOverlay");
function showPopup(row) {
  document.getElementById("popupLine").textContent = (row.line || "").replace("호선", "") || "-";
  document.getElementById("popupStation").textContent = row.station;
  document.getElementById("popupCurr").textContent = row.curr || "미등록";
  document.getElementById("popupAux").textContent = row.aux || "미등록";
  document.getElementById("popupUpdated").textContent = row.updatedAt
    ? new Date(row.updatedAt).toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "-";
  popupOverlay.hidden = false;

  if (window.speechSynthesis) {
    const utter = new SpeechSynthesisUtterance(`${row.station}, 비밀번호는 ${spellOut(row.curr)} 입니다`);
    utter.lang = "ko-KR";
    speechSynthesis.speak(utter);
  }
}
function spellOut(digits) {
  if (!digits) return "미등록";
  return digits.split("").join(" ");
}
document.getElementById("popupClose").addEventListener("click", () => {
  popupOverlay.hidden = true;
});
popupOverlay.addEventListener("click", (e) => {
  if (e.target === popupOverlay) popupOverlay.hidden = true;
});

/* ---------- 홈 화면에 추가 ---------- */
const installBanner = document.getElementById("installBanner");
const installBtn = document.getElementById("installBtn");
const installBannerClose = document.getElementById("installBannerClose");
const instrOverlay = document.getElementById("instrOverlay");
const instrSteps = document.getElementById("instrSteps");
const instrClose = document.getElementById("instrClose");

let deferredInstallPrompt = null;
const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const bannerDismissed = localStorage.getItem("psd_install_dismissed") === "1";

if (!isStandalone && !bannerDismissed) {
  if (isIOS) {
    installBanner.hidden = false; // iOS는 beforeinstallprompt가 없어 안내만 띄운다
  }
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    installBanner.hidden = false;
  });
}

installBtn.addEventListener("click", async () => {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    installBanner.hidden = true;
  } else if (isIOS) {
    instrSteps.innerHTML = `
      <li>화면 아래쪽 공유 버튼 <b>⬆︎</b> 을 누르세요</li>
      <li>메뉴에서 <b>"홈 화면에 추가"</b>를 선택하세요</li>
      <li>오른쪽 위 <b>추가</b>를 누르면 완료됩니다</li>
    `;
    instrOverlay.hidden = false;
  } else {
    instrSteps.innerHTML = `
      <li>브라우저 오른쪽 위 <b>⋮</b> 메뉴를 여세요</li>
      <li><b>"홈 화면에 추가"</b> 또는 <b>"앱 설치"</b>를 선택하세요</li>
    `;
    instrOverlay.hidden = false;
  }
});
instrClose.addEventListener("click", () => { instrOverlay.hidden = true; });
instrOverlay.addEventListener("click", (e) => { if (e.target === instrOverlay) instrOverlay.hidden = true; });

installBannerClose.addEventListener("click", () => {
  installBanner.hidden = true;
  localStorage.setItem("psd_install_dismissed", "1");
});

window.addEventListener("appinstalled", () => {
  installBanner.hidden = true;
});

/* ---------- 초기화 ---------- */
renderDBCount();
renderQuickList();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => { /* 로컬 file:// 실행 시 무시 */ });
  });
}
