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

imgInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  scanPreview.src = URL.createObjectURL(file);
  scanPreviewWrap.hidden = false;
  parsedWrap.hidden = true;
  ocrProgress.hidden = false;
  ocrBarFill.style.width = "0%";
  ocrProgressText.textContent = "인식 준비 중… (처음 실행 시 한글 인식 모듈을 내려받아 다소 걸립니다)";

  try {
    const { data } = await Tesseract.recognize(file, "kor+eng", {
      logger: (m) => {
        if (m.status && typeof m.progress === "number") {
          ocrBarFill.style.width = `${Math.round(m.progress * 100)}%`;
          ocrProgressText.textContent = `${ocrStatusKo(m.status)} ${Math.round(m.progress * 100)}%`;
        }
      },
    });
    ocrProgress.hidden = true;
    const defaultLine = document.getElementById("lineInput").value.trim();
    currentParsedRows = parseTableText(data.text, defaultLine);
    renderParsedTable();
  } catch (err) {
    ocrProgress.hidden = true;
    alert("인식에 실패했습니다: " + err.message);
  }
});

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
 * 사진 한 줄(=표의 한 행)을 대상으로 연번 / 역명 / 비밀번호 3종을 뽑아낸다.
 * 연번은 1~3자리 숫자, 비밀번호는 4자리 숫자라는 규칙을 이용해 구분한다.
 */
function parseTableText(rawText, defaultLine) {
  const lines = rawText.split("\n").map(l => l.trim()).filter(Boolean);
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
