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

/**
 * 모니터 화면을 카메라로 찍으면 화면 픽셀 격자와 카메라 센서 격자가 겹치면서
 * 실제로는 없는 물결무늬(무아레)가 생겨 OCR을 심하게 방해한다.
 * 흑백화 + 살짝 블러(고주파 노이즈 완화) + 대비 강화로 이를 줄인다.
 */
async function preprocessForOcr(file) {
  const bitmap = await createImageBitmap(file);
  const maxDim = 1800;
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.filter = "grayscale(1) blur(1px) contrast(1.5) brightness(1.05)";
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob || file), "image/png"));
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
    ocrProgressText.textContent = "화면 반사·무아레 무늬 보정 중…";
    const processed = await preprocessForOcr(file);
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
