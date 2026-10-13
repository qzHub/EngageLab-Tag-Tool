const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_IDS = 100000;
const BATCH_SIZE = 1000;

const form = document.querySelector("#tag-form");
const fileInput = document.querySelector("#csv-file");
const dropZone = document.querySelector("#drop-zone");
const fileSummary = document.querySelector("#file-summary");
const preview = document.querySelector("#preview");
const submitButton = document.querySelector("#submit-button");
const resultCard = document.querySelector("#result-card");
const errorBox = document.querySelector("#form-error");
const tagInput = document.querySelector("#tag");
const secretInput = document.querySelector("#master-secret");
const retryButton = document.querySelector("#retry-failed");
const csvModeButton = document.querySelector("#csv-mode-button");
const manualModeButton = document.querySelector("#manual-mode-button");
const csvPanel = document.querySelector("#csv-panel");
const manualPanel = document.querySelector("#manual-panel");
const manualInput = document.querySelector("#manual-id-input");
const setOperationButton = document.querySelector("#set-operation-button");
const queryOperationButton = document.querySelector("#query-operation-button");
const downloadQueryButton = document.querySelector("#download-query");

let operationMode = "set";
let inputMode = "csv";
let csvRegistrationIds = [];
let manualRegistrationIds = [];
let failedRegistrationIds = [];
let queryBoundIds = [];

async function watchBrowserSession() {
  while (true) {
    try {
      const response = await fetch("/api/session/watch", { cache: "no-store" });
      if (response.status === 204) return;
      if (!response.ok || !response.body) throw new Error("session watcher unavailable");
      const reader = response.body.getReader();
      while (!(await reader.read()).done) {
        // Reading keeps the connection alive without background timer throttling.
      }
    } catch {
      // A reload can briefly close the watcher; reconnect within the server grace period.
    }
    await new Promise((resolve) => window.setTimeout(resolve, 500));
  }
}

watchBrowserSession();

function activeRegistrationIds() {
  return inputMode === "csv" ? csvRegistrationIds : manualRegistrationIds;
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
  window.clearTimeout(showError.timer);
  showError.timer = window.setTimeout(() => { errorBox.hidden = true; }, 7000);
}

function parseCsv(text) {
  const normalized = text.replace(/^\uFEFF/, "");
  const values = [];
  const seen = new Set();
  let duplicateCount = 0;

  normalized.split(/\r?\n/).forEach((rawLine, index) => {
    let value = rawLine.trim();
    if (!value) return;
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/""/g, '"').trim();
    } else if (value.includes(",")) {
      value = value.split(",", 1)[0].trim();
    }
    if (index === 0 && /^(registration_?id|reg_?id)$/i.test(value)) return;
    if (!value) return;
    if (seen.has(value)) {
      duplicateCount += 1;
      return;
    }
    seen.add(value);
    values.push(value);
  });

  return { values, duplicateCount };
}

async function loadFile(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".csv")) {
    showError("请选择 .csv 文件");
    return;
  }
  if (file.size > MAX_FILE_SIZE) {
    showError("CSV 文件不能超过 10 MB");
    return;
  }

  try {
    const parsed = parseCsv(await file.text());
    if (parsed.values.length === 0) throw new Error("CSV 中没有可用的 registration ID");
    if (parsed.values.length > MAX_IDS) throw new Error(`唯一 registration ID 不能超过 ${MAX_IDS.toLocaleString()}`);

    csvRegistrationIds = parsed.values;
    failedRegistrationIds = [];
    document.querySelector("#file-name").textContent = file.name;
    document.querySelector("#file-meta").textContent = `${(file.size / 1024).toFixed(1)} KB`;
    document.querySelector("#valid-count").textContent = parsed.values.length.toLocaleString();
    document.querySelector("#duplicate-count").textContent = parsed.duplicateCount.toLocaleString();
    document.querySelector("#batch-count").textContent = (
      operationMode === "set" ? Math.ceil(parsed.values.length / BATCH_SIZE) : parsed.values.length
    ).toLocaleString();
    document.querySelector("#id-preview").replaceChildren(
      ...parsed.values.slice(0, 8).map((id) => {
        const item = document.createElement("li");
        item.textContent = id;
        return item;
      }),
    );
    fileSummary.hidden = false;
    preview.hidden = false;
    resultCard.hidden = true;
    updateSubmitState();
  } catch (error) {
    clearFile();
    showError(error.message || "无法读取 CSV 文件");
  }
}

function clearFile() {
  fileInput.value = "";
  csvRegistrationIds = [];
  failedRegistrationIds = [];
  fileSummary.hidden = true;
  preview.hidden = true;
  updateSubmitState();
}

function updateSubmitState() {
  submitButton.disabled = activeRegistrationIds().length === 0 || submitButton.classList.contains("is-loading");
}

function setLoading(loading) {
  submitButton.classList.toggle("is-loading", loading);
  submitButton.disabled = loading || activeRegistrationIds().length === 0;
  retryButton.disabled = loading;
  downloadQueryButton.disabled = loading;
  setOperationButton.disabled = loading;
  queryOperationButton.disabled = loading;
  csvModeButton.disabled = loading;
  manualModeButton.disabled = loading;
  form.querySelectorAll("input, select").forEach((element) => { element.disabled = loading; });
}

function collectPayload(ids) {
  return {
    api_base_url: document.querySelector("#api-base-url").value,
    app_key: document.querySelector("#app-key").value.trim(),
    master_secret: secretInput.value.trim(),
    tag: tagInput.value.trim(),
    timeout_seconds: Number.parseInt(document.querySelector("#timeout").value, 10),
    registration_ids: ids,
  };
}

function resetResultView() {
  document.querySelector("#batch-results").replaceChildren();
  document.querySelector("#query-errors").replaceChildren();
  document.querySelector("#query-results").hidden = true;
  retryButton.hidden = true;
  downloadQueryButton.hidden = true;
  document.querySelector("#error-stat").hidden = true;
  resultCard.classList.remove("is-query");
}

function renderSetResults(data, attemptedIds) {
  resetResultView();
  document.querySelector("#result-primary-label").textContent = "成功";
  document.querySelector("#result-secondary-label").textContent = "失败";
  document.querySelector("#result-total-label").textContent = "总计";
  document.querySelector("#success-count").textContent = data.success_count.toLocaleString();
  document.querySelector("#failed-count").textContent = data.failed_count.toLocaleString();
  document.querySelector("#total-count").textContent = data.total.toLocaleString();
  document.querySelector("#result-title").textContent = data.failed_count ? "部分批次处理失败" : "全部处理完成";

  const rows = data.results.map((result) => {
    const row = document.createElement("div");
    row.className = `batch-row${result.success ? "" : " failed"}`;
    const title = document.createElement("strong");
    title.textContent = `批次 ${result.batch}`;
    const message = document.createElement("span");
    message.className = "message";
    message.textContent = `${result.count} 条 · ${result.message}`;
    message.title = result.message;
    const status = document.createElement("span");
    status.className = "status-pill";
    status.textContent = result.success ? "成功" : (result.status ? `HTTP ${result.status}` : "网络错误");
    row.append(title, message, status);
    return row;
  });
  document.querySelector("#batch-results").replaceChildren(...rows);

  failedRegistrationIds = [];
  data.results.forEach((result) => {
    if (!result.success) {
      const start = (result.batch - 1) * BATCH_SIZE;
      failedRegistrationIds.push(...attemptedIds.slice(start, start + result.count));
    }
  });
  retryButton.hidden = failedRegistrationIds.length === 0;
  resultCard.hidden = false;
  resultCard.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderQueryResults(data) {
  resetResultView();
  resultCard.classList.add("is-query");
  document.querySelector("#result-primary-label").textContent = "已绑定";
  document.querySelector("#result-secondary-label").textContent = "未绑定";
  document.querySelector("#result-total-label").textContent = "查询总数";
  document.querySelector("#success-count").textContent = data.bound_count.toLocaleString();
  document.querySelector("#failed-count").textContent = data.unbound_count.toLocaleString();
  document.querySelector("#error-count").textContent = data.error_count.toLocaleString();
  document.querySelector("#total-count").textContent = data.total.toLocaleString();
  document.querySelector("#error-stat").hidden = false;
  document.querySelector("#result-title").textContent = data.error_count ? "查询完成，部分 ID 查询失败" : "查询完成";

  queryBoundIds = data.bound_registration_ids;
  document.querySelector("#query-id-list").value = queryBoundIds.join("\n");
  document.querySelector("#query-list-note").textContent = queryBoundIds.length
    ? `共 ${queryBoundIds.length.toLocaleString()} 条，可导出完整 CSV`
    : "没有候选 ID 绑定该 Tag";
  document.querySelector("#query-results").hidden = false;
  downloadQueryButton.hidden = queryBoundIds.length === 0;

  const errorRows = data.errors.slice(0, 100).map((error) => {
    const row = document.createElement("div");
    row.className = "batch-row failed";
    const title = document.createElement("strong");
    title.textContent = error.registration_id;
    title.title = error.registration_id;
    const message = document.createElement("span");
    message.className = "message";
    message.textContent = error.message;
    message.title = error.message;
    const status = document.createElement("span");
    status.className = "status-pill";
    status.textContent = error.status ? `HTTP ${error.status}` : "网络错误";
    row.append(title, message, status);
    return row;
  });
  if (data.errors.length > 100) {
    const note = document.createElement("p");
    note.className = "query-error-note";
    note.textContent = `仅展示前 100 条查询失败记录，共 ${data.errors.length.toLocaleString()} 条。`;
    errorRows.push(note);
  }
  document.querySelector("#query-errors").replaceChildren(...errorRows);
  resultCard.hidden = false;
  resultCard.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function submitIds(ids) {
  const submittedOperation = operationMode;
  setLoading(true);
  errorBox.hidden = true;
  try {
    const response = await fetch(submittedOperation === "query" ? "/api/tags/verify" : "/api/tags/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collectPayload(ids)),
    });
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error(`本地服务返回了无法解析的响应（HTTP ${response.status}）`);
    }
    if (!response.ok) throw new Error(data.error || `请求失败（HTTP ${response.status}）`);
    if (submittedOperation === "query") {
      renderQueryResults(data);
    } else {
      renderSetResults(data, ids);
    }
  } catch (error) {
    showError(error.message || "请求失败，请检查本地服务和网络");
  } finally {
    setLoading(false);
  }
}

fileInput.addEventListener("change", () => loadFile(fileInput.files[0]));
document.querySelector("#remove-file").addEventListener("click", clearFile);

["dragenter", "dragover"].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  });
});
["dragleave", "drop"].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-dragging");
  });
});
dropZone.addEventListener("drop", (event) => loadFile(event.dataTransfer.files[0]));

document.querySelector("#toggle-secret").addEventListener("click", (event) => {
  const revealing = secretInput.type === "password";
  secretInput.type = revealing ? "text" : "password";
  event.currentTarget.textContent = revealing ? "隐藏" : "显示";
  event.currentTarget.setAttribute("aria-label", revealing ? "隐藏 Master Secret" : "显示 Master Secret");
});

tagInput.addEventListener("input", () => {
  const bytes = new TextEncoder().encode(tagInput.value.trim()).length;
  const counter = document.querySelector("#tag-bytes");
  counter.textContent = `${bytes} / 40 字节`;
  counter.style.color = bytes > 40 ? "var(--danger)" : "";
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  const registrationIds = activeRegistrationIds();
  if (!registrationIds.length) {
    showError(inputMode === "csv" ? "请先选择 CSV 文件" : "请先输入 registration ID 并按回车添加");
    return;
  }
  submitIds(registrationIds);
});

retryButton.addEventListener("click", () => {
  if (failedRegistrationIds.length) submitIds([...failedRegistrationIds]);
});

function switchOperation(mode) {
  operationMode = mode;
  const settingTag = mode === "set";
  setOperationButton.classList.toggle("is-active", settingTag);
  queryOperationButton.classList.toggle("is-active", !settingTag);
  setOperationButton.setAttribute("aria-selected", String(settingTag));
  queryOperationButton.setAttribute("aria-selected", String(!settingTag));
  document.querySelector("#tag-label-text").textContent = settingTag ? "要添加的 Tag" : "要查询的 Tag";
  document.querySelector("#upload-title").textContent = settingTag ? "添加 registration ID" : "提供候选 registration ID";
  document.querySelector("#input-description").textContent = settingTag
    ? "选择 CSV 批量导入，或逐条手动输入。"
    : "提供候选 registration ID，逐个验证是否绑定该 Tag。";
  document.querySelector("#action-note-title").textContent = settingTag ? "本操作只添加 Tag" : "本操作只查询绑定关系";
  document.querySelector("#action-note-description").textContent = settingTag
    ? "不会移除设备已有的其他 Tag。"
    : "不会修改设备的任何 Tag；最多同时发起 10 个查询。";
  submitButton.querySelector(".button-label").textContent = settingTag ? "开始批量设置" : "开始查询";
  document.querySelector("#request-count-label").textContent = settingTag ? "预计批次" : "预计请求";
  document.querySelector("#batch-count").textContent = (
    settingTag ? Math.ceil(csvRegistrationIds.length / BATCH_SIZE) : csvRegistrationIds.length
  ).toLocaleString();
  resultCard.hidden = true;
  failedRegistrationIds = [];
  queryBoundIds = [];
  updateSubmitState();
}

setOperationButton.addEventListener("click", () => switchOperation("set"));
queryOperationButton.addEventListener("click", () => switchOperation("query"));

downloadQueryButton.addEventListener("click", () => {
  if (!queryBoundIds.length) return;
  const csvRows = ["registration_id", ...queryBoundIds.map((id) => `"${id.replaceAll('"', '""')}"`)];
  const blob = new Blob(["\uFEFF", csvRows.join("\r\n"), "\r\n"], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${tagInput.value.trim() || "tag"}-bound-registration-ids.csv`;
  link.click();
  URL.revokeObjectURL(url);
});

function switchInputMode(mode) {
  inputMode = mode;
  const usingCsv = mode === "csv";
  csvModeButton.classList.toggle("is-active", usingCsv);
  manualModeButton.classList.toggle("is-active", !usingCsv);
  csvModeButton.setAttribute("aria-selected", String(usingCsv));
  manualModeButton.setAttribute("aria-selected", String(!usingCsv));
  csvPanel.hidden = !usingCsv;
  manualPanel.hidden = usingCsv;
  resultCard.hidden = true;
  failedRegistrationIds = [];
  updateSubmitState();
  if (!usingCsv) manualInput.focus();
}

function renderManualIds() {
  const items = manualRegistrationIds.map((registrationId) => {
    const item = document.createElement("li");
    item.className = "manual-id-item";
    const value = document.createElement("code");
    value.textContent = registrationId;
    value.title = registrationId;
    const removeButton = document.createElement("button");
    removeButton.className = "remove-id-button";
    removeButton.type = "button";
    removeButton.textContent = "×";
    removeButton.setAttribute("aria-label", `移除 ${registrationId}`);
    removeButton.addEventListener("click", () => {
      manualRegistrationIds = manualRegistrationIds.filter((id) => id !== registrationId);
      renderManualIds();
    });
    item.append(value, removeButton);
    return item;
  });
  document.querySelector("#manual-id-list").replaceChildren(...items);
  document.querySelector("#manual-count").textContent = manualRegistrationIds.length.toLocaleString();
  document.querySelector("#manual-empty").hidden = manualRegistrationIds.length > 0;
  document.querySelector("#clear-manual-ids").disabled = manualRegistrationIds.length === 0;
  updateSubmitState();
}

function addManualId() {
  const registrationId = manualInput.value.trim();
  if (!registrationId) return;
  if (new TextEncoder().encode(registrationId).length > 255) {
    showError("Registration ID 过长，请检查输入");
    return;
  }
  if (manualRegistrationIds.includes(registrationId)) {
    showError("这个 registration ID 已经添加过了");
    manualInput.select();
    return;
  }
  if (manualRegistrationIds.length >= MAX_IDS) {
    showError(`最多添加 ${MAX_IDS.toLocaleString()} 个 registration ID`);
    return;
  }
  manualRegistrationIds.push(registrationId);
  manualInput.value = "";
  renderManualIds();
}

csvModeButton.addEventListener("click", () => switchInputMode("csv"));
manualModeButton.addEventListener("click", () => switchInputMode("manual"));
manualInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addManualId();
  }
});
document.querySelector("#clear-manual-ids").addEventListener("click", () => {
  manualRegistrationIds = [];
  renderManualIds();
  manualInput.focus();
});
